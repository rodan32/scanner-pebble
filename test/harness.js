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
//   node test/harness.js [home|ward|nbhd|nearby|live]
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
const filterArg = (process.argv.slice(2).find((a) => !a.startsWith('--')) || 'home').toLowerCase();
const FILTER = { home: 0, ward: 1, nbhd: 2, nearby: 3, live: 4 }[filterArg];
if (FILTER === undefined) {
  console.error('view must be home|ward|nbhd|nearby|live'); process.exit(1);
}
const HOME_AREAS = process.env.HOME_AREAS || 'Orem';
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
  HOME_AREAS, MUTE_TAGS,
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
      var key = 'feed';
      if (reqPath.indexOf('/home-log') >= 0) key = 'home_log';
      else if (reqPath.indexOf('/api/incident/') >= 0) key = 'incident';
      else if (reqPath.indexOf('/since') >= 0) key = 'since';
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

// --- row preview ------------------------------------------------------------
// Approximates what main.c's menu_draw_row actually puts on screen, so the
// harness answers "what will I see" rather than "what got sent". The watch is
// 200px wide in Gothic 18, which is roughly 30 characters a line: an incident
// row gets two lines of summary, a call row one. Getting that clamp wrong is
// how a feed ends up as a list of bare timestamps.
let openInc = 0;      // set while the drill-down simulation is active
const ROW_COLS = 30;
const TIER_MARK = ['   ', ' : ', ' : ', ' | ', '###'];  // 0..4, 4 = home block

function wrap(text, cols, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line) { line = w; continue; }
    if ((line + ' ' + w).length <= cols) { line += ' ' + w; }
    else { lines.push(line); line = w; if (lines.length === maxLines) break; }
  }
  if (line && lines.length < maxLines) lines.push(line);
  const clipped = words.join(' ').length >
                  lines.join(' ').length;
  if (clipped && lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, cols - 1) + '\u2026';
  }
  return lines;
}

function renderRow(msg) {
  // Incident rows lead with the type and drop seconds; call rows keep the tag.
  const incident = !openInc && FILTER !== 4;
  const lead = (incident && msg.CALL_CAT) ? msg.CALL_CAT : msg.CALL_TAG;
  const bar = TIER_MARK[msg.CALL_TIER || 0];
  const em = msg.CALL_EMERG ? '!' : ' ';
  const head = msg.CALL_TIME + em;
  const pad = Math.max(1, ROW_COLS + 4 - head.length - String(lead).length);
  // WHERE takes its line out of the summary's two, exactly as main.c does.
  const hasLoc = incident && msg.CALL_LOC;
  const lines = [];
  if (hasLoc) lines.push(`  ${bar} ${msg.CALL_LOC}`);
  for (const l of wrap(msg.CALL_TEXT, ROW_COLS, (incident && !hasLoc) ? 2 : 1)) {
    lines.push(`  ${bar} ${l}`);
  }
  return `  ${bar} ${head}${' '.repeat(pad)}${lead}\n${lines.join('\n')}`;
}

// --- mock: Pebble -----------------------------------------------------------
const listeners = {};
let sent = 0;
global.Pebble = {
  addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
  sendAppMessage: (msg, ok) => {
    sent++;
    if (msg.MSG_TYPE === 1) {
      console.log(`  [status] ${msg.STATUS}`);
    } else if (msg.MSG_TYPE === 2) {
      console.log(`  [reset] list cleared, view -> ${msg.FILTER}`);
    } else {
      console.log(renderRow(msg));
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
console.log(`\n== Scanner Feed bridge test — view=${filterArg.toUpperCase()}`
            + `${OFFLINE ? ' (offline fixtures)' : ''} ==`);
require(path.join(__dirname, '..', 'src', 'pkjs', 'index.js'));

// 'ready' kicks off startPolling() -> first poll() does the seed (history).
fire('ready');

// --offline --open: simulate the watch pressing SELECT on an incident, which is
// the only way to exercise the drill-down path without a watch.
const OPEN_INC = (() => {
  const i = process.argv.indexOf('--open');
  return i >= 0 ? Number(process.argv[i + 1]) : 0;
})();
if (OPEN_INC) {
  setTimeout(() => {
    console.log(`\n-- SELECT on incident ${OPEN_INC} (drill down to its calls) --`);
    openInc = OPEN_INC;
    fire('appmessage', { payload: { CMD: 1, CALL_INC: OPEN_INC } });
  }, 300);
  setTimeout(() => {
    console.log('\n-- BACK to the incident list --');
    openInc = 0;
    fire('appmessage', { payload: { CMD: 2 } });
  }, 900);
}

// The bridge's own setInterval (POLL_MS = 10s) fires the live-tail /since call,
// so just stay alive long enough to watch one land, then report and exit.
setTimeout(() => {
  console.log(`\n== done — ${sent} AppMessage(s) sent to the watch ==`);
  process.exit(0);
}, 12000);
