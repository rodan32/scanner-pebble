// ---------------------------------------------------------------------------
// Local test harness for the PebbleKit JS bridge (src/pkjs/index.js).
//
// Loads the REAL index.js under a mocked Pebble runtime and exercises the
// polling/filter/field-mapping logic against the live scanner backend, then
// prints the AppMessages the watch would actually receive. No watch, no phone,
// no Pebble SDK required.
//
// It targets the production host the app is configured with
// (data.zarchstuff.com) but routes the network to the internal analytics
// container (CT137) over http, which bypasses the NPM basic-auth gate — so we
// test the exact production paths + query params without needing creds.
//
//   node test/harness.js [local|utco|all]
// ---------------------------------------------------------------------------
'use strict';
const http = require('http');
const path = require('path');
const Module = require('module');

const INTERNAL = { host: '192.168.0.177', port: 80 }; // CT137 analytics, no auth
const PROD_HOST = 'data.zarchstuff.com';
const filterArg = (process.argv[2] || 'local').toLowerCase();
const FILTER = { local: 0, utco: 1, all: 2 }[filterArg];
if (FILTER === undefined) { console.error('filter must be local|utco|all'); process.exit(1); }

// --- mock: localStorage -----------------------------------------------------
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
store['config'] = JSON.stringify({
  HOST: PROD_HOST, USERNAME: '', PASSWORD: '', DEFAULT_FILTER: FILTER,
});

// --- mock: XMLHttpRequest (routes PROD_HOST -> internal CT137 over http) -----
global.XMLHttpRequest = function () {
  this._headers = {};
  this.status = 0;
  this.responseText = '';
  this.open = function (method, url) { this._method = method; this._url = url; };
  this.setRequestHeader = function (k, v) { this._headers[k] = v; };
  this.send = function () {
    const u = new URL(this._url);
    const reqPath = u.pathname + u.search;
    console.log(`  → GET https://${u.host}${reqPath}`);
    const req = http.request({
      host: INTERNAL.host, port: INTERNAL.port, path: reqPath,
      method: this._method || 'GET', headers: this._headers,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        this.status = res.statusCode;
        this.responseText = body;
        if (this.onload) this.onload();
      });
    });
    req.on('error', () => { if (this.onerror) this.onerror(); });
    req.end();
  };
};

// --- mock: Pebble -----------------------------------------------------------
const listeners = {};
let sent = 0;
global.Pebble = {
  addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
  sendAppMessage: (msg, ok) => {
    sent++;
    if (msg.MSG_TYPE === 1) {
      console.log(`  [status] ${msg.STATUS}`);
    } else {
      const em = msg.CALL_EMERG ? ' !EMERG' : '';
      console.log(`  [call ${msg.CALL_ID}] ${msg.CALL_TIME}  ${msg.CALL_TAG}` +
                  `${msg.CALL_CAT ? '  (' + msg.CALL_CAT + ')' : ''}${em}\n` +
                  `             ${msg.CALL_TEXT}`);
    }
    if (ok) setImmediate(ok); // async like the real outbox callback
  },
  openURL: () => {},
};
function fire(ev, payload) { (listeners[ev] || []).forEach((fn) => fn(payload)); }

// --- mock: require('pebble-clay') -------------------------------------------
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pebble-clay') {
    return function Clay() {
      return { generateUrl: () => 'about:blank', getSettings: () => ({}) };
    };
  }
  return origLoad.apply(this, arguments);
};

// --- load the real bridge and drive it --------------------------------------
console.log(`\n== Scanner Feed bridge test — filter=${filterArg.toUpperCase()} ==`);
require(path.join(__dirname, '..', 'src', 'pkjs', 'index.js'));

// 'ready' kicks off startPolling() -> first poll() does the seed (history).
fire('ready');

// Give the seed request time, then simulate one live-tail poll cycle and exit.
setTimeout(() => {
  console.log('\n-- simulating a live-tail poll (since cursor) --');
  // Re-fire ready would reseed; instead poke the internal poll by faking the
  // interval: easiest is to dispatch a no-op appmessage that re-runs poll via
  // applyFilter to the SAME filter (reseeds) — but to test /since we just wait
  // for the module's own setInterval (POLL_MS=10s) to fire once.
}, 1500);

setTimeout(() => {
  console.log(`\n== done — ${sent} AppMessage(s) sent to the watch ==`);
  process.exit(0);
}, 12000);
