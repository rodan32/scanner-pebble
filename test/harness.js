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
//   node test/harness.js [local|utco|all|fav]
//
// Pass --offline to serve canned payloads from test/fixtures.json instead of
// the LAN. That needs no network at all, so it runs anywhere (and in CI) and is
// the way to check the field mapping against a feed shape before the backend
// actually serves it — add the new shape to fixtures.json and run it.
// ---------------------------------------------------------------------------
'use strict';
const http = require('http');
const path = require('path');
const Module = require('module');

const INTERNAL = { host: '192.168.0.177', port: 80 }; // CT137 analytics, no auth
const PROD_HOST = 'data.zarchstuff.com';
const OFFLINE = process.argv.includes('--offline');
const filterArg = (process.argv.slice(2).find((a) => !a.startsWith('--')) || 'local').toLowerCase();
const FILTER = { local: 0, utco: 1, all: 2, fav: 3 }[filterArg];
if (FILTER === undefined) { console.error('filter must be local|utco|all|fav'); process.exit(1); }
// `fav` reads the preset from FAVE_AREAS rather than a built-in list, so let it
// be supplied per-run: FAVE_AREAS="Orem, UHP" node test/harness.js fav
const FAVE_AREAS = process.env.FAVE_AREAS || 'Orem, Provo';
const MUTE_TAGS = process.env.MUTE_TAGS || '';

const FIXTURES = OFFLINE
  ? JSON.parse(require('fs').readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'))
  : null;

// --- mock: localStorage -----------------------------------------------------
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
// USERNAME must be non-empty: the bridge short-circuits to 'set creds' before
// it ever issues a request, since a missing credential against the real host is
// a guaranteed 401. Neither the internal container nor --offline checks it, so
// any placeholder does; override for a run against something that does check.
store['config'] = JSON.stringify({
  HOST: PROD_HOST,
  USERNAME: process.env.SCANNER_USER || 'harness',
  PASSWORD: process.env.SCANNER_PASS || '',
  DEFAULT_FILTER: FILTER,
  FAVE_AREAS, MUTE_TAGS,
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
    if (OFFLINE) {
      // Match the fixture by endpoint: /feed/api/feed is the seed, /since the
      // live tail. Reply on a later tick so the bridge's async flow is the same
      // as it is against a real server.
      const key = reqPath.indexOf('/since') >= 0 ? 'since' : 'feed';
      setImmediate(() => {
        this.status = 200;
        this.responseText = JSON.stringify(FIXTURES[key]);
        if (this.onload) this.onload();
      });
      return;
    }
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
console.log(`\n== Scanner Feed bridge test — filter=${filterArg.toUpperCase()}`
            + `${OFFLINE ? ' (offline fixtures)' : ''} ==`);
require(path.join(__dirname, '..', 'src', 'pkjs', 'index.js'));

// 'ready' kicks off startPolling() -> first poll() does the seed (history).
fire('ready');

// The bridge's own setInterval (POLL_MS = 10s) fires the live-tail /since call,
// so just stay alive long enough to watch one land, then report and exit.
setTimeout(() => {
  console.log(`\n== done — ${sent} AppMessage(s) sent to the watch ==`);
  process.exit(0);
}, 12000);
