// ---------------------------------------------------------------------------
// Scanner Feed — PebbleKit JS bridge (runs on the phone)
//
// Polls the scanner backend's live-tail feed, filters by the active preset
// (Local / Utah Co / All), and pushes one AppMessage per call to the watch.
// Credentials + host come from the Clay settings page (src/pkjs/config.js)
// so nothing sensitive lives in the repo.
//
// Endpoint (2026-06): the public feed moved from the old scanner-feed app
// (transcripts.zarchstuff.com/api/recent) INTO the analytics app at
// data.zarchstuff.com/feed/api/*. The old host now 302-redirects to the new
// one — and because XHR strips the Authorization header on a cross-origin
// redirect, hitting the old host fails basic auth ("auth failed") AND returns
// HTML ("bad data"). So we target data.zarchstuff.com directly, no redirect.
//
//   GET /feed/api/feed?limit=N&areas=...   -> {calls:[...], next_cursor}  (seed/history, newest-first)
//   GET /feed/api/since?after_id=ID&areas= -> {calls:[...], max_id}        (live-tail; server filters hallucinations)
// ---------------------------------------------------------------------------

var Clay = require('pebble-clay');
var clayConfig = require('./config');
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

// MSG_TYPE values (must match main.c)
var MSG_CALL = 0;
var MSG_STATUS = 1;

// Filter presets (must match main.c)
var FILTER_LOCAL = 0;
var FILTER_UTCO = 1;
var FILTER_ALL = 2;

// Filter -> backend `areas` chips (keys from analytics/app/areas.py). The
// backend resolves each area to tg_alpha_tag substrings, so we think in
// agencies, not talkgroup numbers. ALL sends no area filter (everything).
//
//   Local   = the busiest nearby agencies — guarantees a steady feed.
//             (Orem/Lindon PD is by far the highest-volume TG.)
//   Utah Co = every Utah-County-area chip.
var LOCAL_AREAS = ['Orem', 'Lehi', 'American Fork', 'UtCo Sheriff', 'UtCo Fire/EMS'];
var UTCO_AREAS = ['Orem', 'Provo', 'Lehi', 'American Fork', 'Springville',
                  'Spanish Fork', 'UtCo Sheriff', 'UtCo Fire/EMS'];

var SEED_LIMIT = 24;     // history to pull on launch / filter switch (= watch MAX_CALLS)
var POLL_MS = 10000;
var activeFilter = FILTER_LOCAL;
var lastMaxId = 0;       // server-side cursor: highest call id we've sent
var pollTimer = null;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
var DEFAULT_HOST = 'data.zarchstuff.com';
// The feed moved off this host in 2026-06; it now 302-redirects (which strips
// auth). Auto-migrate any saved config still pointing at it so existing
// installs self-heal without the user re-entering settings.
var DEAD_HOST = 'transcripts.zarchstuff.com';

function migrateHost(host) {
  if (!host || host === DEAD_HOST) return DEFAULT_HOST;
  return host;
}

// Short label for the status bar: 'data.zarchstuff.com' -> 'data'. Lets the
// watch show which host it's hitting (confirms the migration fired).
function hostTag(host) {
  host = host || '?';
  var dot = host.indexOf('.');
  return dot > 0 ? host.slice(0, dot) : host;
}

function getConfig() {
  var defaults = {
    HOST: DEFAULT_HOST,
    USERNAME: '',
    PASSWORD: '',
    DEFAULT_FILTER: FILTER_LOCAL
  };
  var raw = localStorage.getItem('config');
  if (!raw) return defaults;
  try {
    var parsed = JSON.parse(raw);
    for (var k in defaults) {
      if (parsed[k] === undefined || parsed[k] === null || parsed[k] === '') {
        parsed[k] = defaults[k];
      }
    }
    parsed.HOST = migrateHost(parsed.HOST);
    return parsed;
  } catch (e) {
    return defaults;
  }
}

// Minimal base64 with correct '=' padding — PebbleKit JS has no reliable btoa.
// Operates on a *byte string* (each char 0..255); callers must UTF-8-encode
// first (see toUtf8 / authHeader) so non-ASCII credentials encode correctly.
function b64(str) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var out = '';
  for (var i = 0; i < str.length; i += 3) {
    var hasB2 = i + 1 < str.length;
    var hasB3 = i + 2 < str.length;
    var b1 = str.charCodeAt(i) & 0xff;
    var b2 = hasB2 ? str.charCodeAt(i + 1) & 0xff : 0;
    var b3 = hasB3 ? str.charCodeAt(i + 2) & 0xff : 0;
    out += chars.charAt(b1 >> 2);
    out += chars.charAt(((b1 & 3) << 4) | (b2 >> 4));
    out += hasB2 ? chars.charAt(((b2 & 15) << 2) | (b3 >> 6)) : '=';
    out += hasB3 ? chars.charAt(b3 & 63) : '=';
  }
  return out;
}

// HTTP Basic auth (RFC 7617) encodes "user:pass" as UTF-8 bytes before base64.
// PebbleKit JS has no TextEncoder, so fold each codepoint to its UTF-8 byte
// sequence by hand. Pure-ASCII input is unchanged; this only matters when a
// credential contains a non-ASCII char — in which case `charCodeAt & 0xff`
// would otherwise truncate it and the server rejects correct creds (401).
function toUtf8(str) {
  var out = '';
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) {
      out += String.fromCharCode(c);
    } else if (c < 0x800) {
      out += String.fromCharCode(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
    } else if (c < 0xD800 || c >= 0xE000) {
      out += String.fromCharCode(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    } else {
      // high surrogate — combine with the following low surrogate
      var c2 = str.charCodeAt(++i);
      var cp = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
      out += String.fromCharCode(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
                                 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    }
  }
  return out;
}

function authHeader(user, pass) {
  return 'Basic ' + b64(toUtf8(user + ':' + pass));
}

// ---------------------------------------------------------------------------
// AppMessage send queue (sequential — the outbox holds one message at a time)
// ---------------------------------------------------------------------------
var sendQueue = [];
var sending = false;
var MAX_QUEUE = 60; // bound the backlog if the watch is disconnected

function pump() {
  if (sending || sendQueue.length === 0) return;
  sending = true;
  var msg = sendQueue.shift();
  Pebble.sendAppMessage(msg, function () {
    sending = false;
    pump();
  }, function () {
    // On failure, drop this message and keep going (watch catches up next poll).
    sending = false;
    pump();
  });
}

function enqueue(msg) {
  // Status messages are tiny and always relevant; calls are the bulk. If the
  // backlog is huge the watch is offline — drop oldest calls, keep newest.
  if (sendQueue.length >= MAX_QUEUE) sendQueue.shift();
  sendQueue.push(msg);
  pump();
}

function sendStatus(text) {
  enqueue({ MSG_TYPE: MSG_STATUS, STATUS: text });
}

function sendCall(call) {
  // New feed has no `emergency` bool — derive urgency from enrichment severity.
  var sev = call.severity || '';
  var emergency = (sev === 'critical' || sev === 'high') ? 1 : 0;
  // No `category` anymore; the most useful secondary line is the incident type
  // (e.g. "traffic stop") or the city, when enrichment has filled them in.
  var cat = call.incident_type || call.city || '';
  enqueue({
    MSG_TYPE: MSG_CALL,
    CALL_ID: call.id,
    CALL_TIME: String(call.time_local || '').slice(-15),
    CALL_TAG: String(call.tg_alpha_tag || '').slice(0, 26),
    CALL_CAT: String(cat).slice(0, 18),
    CALL_TEXT: String(call.transcript || '').slice(0, 156),
    CALL_EMERG: emergency
  });
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
function areaParam() {
  if (activeFilter === FILTER_ALL) return '';
  var areas = (activeFilter === FILTER_UTCO) ? UTCO_AREAS : LOCAL_AREAS;
  return '&areas=' + encodeURIComponent(areas.join(','));
}

function apiGet(cfg, path, onJson) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', 'https://' + cfg.HOST + path, true);
  xhr.timeout = 12000;
  if (cfg.USERNAME) {
    xhr.setRequestHeader('Authorization', authHeader(cfg.USERNAME, cfg.PASSWORD));
  }
  var tag = hostTag(cfg.HOST);
  xhr.onload = function () {
    if (xhr.status === 401) { sendStatus('auth failed @' + tag); return; }
    if (xhr.status !== 200) { sendStatus('http ' + xhr.status + ' @' + tag); return; }
    var body;
    try { body = JSON.parse(xhr.responseText); }
    catch (e) { sendStatus('bad data @' + tag); return; }
    onJson(body);
  };
  xhr.onerror = function () { sendStatus('offline @' + tag); };
  xhr.ontimeout = function () { sendStatus('timeout @' + tag); };
  xhr.send();
}

// Seed: pull recent history for the active preset and prime the cursor.
function seed(cfg) {
  apiGet(cfg, '/feed/api/feed?limit=' + SEED_LIMIT + areaParam(), function (body) {
    var calls = (body && body.calls) || [];
    if (!calls.length) { sendStatus('no calls'); return; }
    // /api/feed is newest-first; send oldest-first so the watch's "pin to top"
    // ends on the most recent call.
    var maxId = lastMaxId;
    for (var i = calls.length - 1; i >= 0; i--) {
      sendCall(calls[i]);
      if (calls[i].id > maxId) maxId = calls[i].id;
    }
    lastMaxId = maxId;
    sendStatus('live');
  });
}

// Live-tail: ask the server for calls past our cursor. after_id=0 just seeds
// the cursor (empty calls + current max_id), so we never re-dump history here.
function pollSince(cfg) {
  apiGet(cfg, '/feed/api/since?after_id=' + lastMaxId + areaParam(), function (body) {
    var calls = (body && body.calls) || [];
    // Server computes max_id from RAW rows (advances past hallucinations it
    // filtered out of `calls`), so trust it over the call ids we see.
    if (typeof body.max_id === 'number' && body.max_id > lastMaxId) {
      lastMaxId = body.max_id;
    }
    if (!calls.length) { sendStatus('live'); return; }
    for (var i = calls.length - 1; i >= 0; i--) {
      sendCall(calls[i]);
    }
    sendStatus('live');
  });
}

function poll() {
  var cfg = getConfig();
  if (!cfg.HOST) { sendStatus('set host'); return; }
  // The backend is gated by NPM basic auth, so a missing credential is a
  // guaranteed 401. Surface that distinctly instead of letting it come back as
  // the ambiguous 'auth failed' (which otherwise can't be told apart from
  // *wrong* creds — see the credential-preserving save in webviewclosed).
  if (!cfg.USERNAME) { sendStatus('set creds @' + hostTag(cfg.HOST)); return; }
  if (lastMaxId === 0) seed(cfg);
  else pollSince(cfg);
}

function applyFilter(f) {
  activeFilter = f;
  lastMaxId = 0; // watch cleared its cache on switch — reseed history for the new preset
  poll();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  // Announce the target host on launch so the watch confirms which backend
  // it's hitting (i.e. that the transcripts->data migration fired). The first
  // poll result overwrites this with 'live' a moment later.
  sendStatus('-> ' + getConfig().HOST);
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}

// ---------------------------------------------------------------------------
// Pebble events
// ---------------------------------------------------------------------------
Pebble.addEventListener('ready', function () {
  var cfg = getConfig();
  activeFilter = parseInt(cfg.DEFAULT_FILTER, 10) || FILTER_LOCAL;
  startPolling();
});

Pebble.addEventListener('appmessage', function (e) {
  if (e.payload && e.payload.FILTER !== undefined) {
    applyFilter(e.payload.FILTER);
  }
});

// Clay config page (autoHandleEvents:false — we persist settings ourselves).
Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(clay.generateUrl());
});

// Pull a value out of clay.getSettings(resp, false) output, which is keyed by
// the string messageKey with each item shaped like { value: ... }. (Defensive
// against a raw value too, in case a Clay version returns it unwrapped.)
function settingValue(settings, key) {
  var item = settings ? settings[key] : undefined;
  if (item && typeof item === 'object' && 'value' in item) item = item.value;
  return (item === undefined || item === null) ? '' : item;
}

Pebble.addEventListener('webviewclosed', function (e) {
  // Page closed without submitting (backed out instead of Save) — nothing to do.
  if (!e || !e.response) return;

  // IMPORTANT: pass convert=false. The default (true) returns the settings
  // keyed by NUMERIC message-key ids for sendAppMessage, so reading
  // settings.USERNAME by name yields undefined and silently stores empty creds.
  // convert=false keys by the string messageKey with values under `.value`.
  var settings = clay.getSettings(e.response, false);

  // The form opens blank when only the filter is changed (we persist creds
  // under our own 'config' key, not Clay's), so treat an empty field as
  // "unchanged" and fall back to the saved value rather than wiping it.
  var prev = getConfig();
  var host = migrateHost(String(settingValue(settings, 'HOST')).trim());
  var user = String(settingValue(settings, 'USERNAME')).trim();
  var pass = String(settingValue(settings, 'PASSWORD'));
  var df = parseInt(settingValue(settings, 'DEFAULT_FILTER'), 10);

  var cfg = {
    HOST: host || prev.HOST,
    USERNAME: user || prev.USERNAME,
    PASSWORD: pass || prev.PASSWORD,
    DEFAULT_FILTER: isNaN(df) ? prev.DEFAULT_FILTER : df
  };
  localStorage.setItem('config', JSON.stringify(cfg));
  activeFilter = cfg.DEFAULT_FILTER;
  lastMaxId = 0;
  startPolling();
});
