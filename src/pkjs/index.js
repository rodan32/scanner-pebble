// ---------------------------------------------------------------------------
// Scanner Feed — PebbleKit JS bridge (runs on the phone)
//
// Polls the scanner backend's /api/recent, filters by the active preset
// (Local / Utah Co / All), and pushes one AppMessage per call to the watch.
// Credentials + host come from the Clay settings page (src/pkjs/config.js)
// so nothing sensitive lives in the repo.
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

// "Local" talkgroups — Eagle Mountain / Saratoga / Lehi / American Fork area
// plus Utah County Sheriff. A couple are marked VERIFY in talkgroups.csv;
// tune this list as you confirm them.
var LOCAL_TGS = {
  6002: 1, // Saratoga Springs / Eagle Mountain PD (verify)
  6000: 1, // American Fork Fire
  6036: 1, // American Fork PD
  6001: 1, // American Fork PD car-to-car
  6003: 1, // Lehi PD
  6010: 1, // Lehi PD car-to-car
  6008: 1, // Lehi / AF PD secondary (verify)
  5921: 1, // Utah County Sheriff 1
  5922: 1, // Utah County Sheriff 2
  5923: 1, // Utah County Sheriff 3
  5924: 1, // Utah County Sheriff 4
  5929: 1, // Utah County Sheriff North
  63431: 1 // UCA SimPatch (Lehi-area fire/EMS)
};

var POLL_MS = 10000;
var activeFilter = FILTER_LOCAL;
var lastMaxId = 0;
var pollTimer = null;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function getConfig() {
  var defaults = {
    HOST: 'transcripts.zarchstuff.com',
    USERNAME: '',
    PASSWORD: '',
    DEFAULT_FILTER: FILTER_LOCAL
  };
  var raw = localStorage.getItem('config');
  if (!raw) return defaults;
  try {
    var parsed = JSON.parse(raw);
    for (var k in defaults) {
      if (parsed[k] === undefined || parsed[k] === null) parsed[k] = defaults[k];
    }
    return parsed;
  } catch (e) {
    return defaults;
  }
}

// Minimal base64 with correct '=' padding — PebbleKit JS has no reliable btoa.
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

// ---------------------------------------------------------------------------
// AppMessage send queue (sequential — the outbox holds one message at a time)
// ---------------------------------------------------------------------------
var sendQueue = [];
var sending = false;

function pump() {
  if (sending || sendQueue.length === 0) return;
  sending = true;
  var msg = sendQueue.shift();
  Pebble.sendAppMessage(msg, function () {
    sending = false;
    pump();
  }, function () {
    // On failure, drop this message and keep going (watch will catch up next poll).
    sending = false;
    pump();
  });
}

function enqueue(msg) {
  sendQueue.push(msg);
  pump();
}

function sendStatus(text) {
  enqueue({ MSG_TYPE: MSG_STATUS, STATUS: text });
}

function sendCall(call) {
  enqueue({
    MSG_TYPE: MSG_CALL,
    CALL_ID: call.id,
    CALL_TIME: String(call.time || '').slice(-15),
    CALL_TAG: String(call.tag || '').slice(0, 26),
    CALL_CAT: String(call.category || '').slice(0, 18),
    CALL_TEXT: String(call.transcript || '').slice(0, 156),
    CALL_EMERG: call.emergency ? 1 : 0
  });
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------
function feedUrl(cfg) {
  var base = 'https://' + cfg.HOST + '/api/recent';
  if (activeFilter === FILTER_ALL) return base + '?limit=40';
  // Local is a subset of Utah County, so both fetch the county feed.
  return base + '?category=' + encodeURIComponent('Utah County') + '&limit=100';
}

function passesFilter(call) {
  if (activeFilter === FILTER_ALL) return true;
  if (activeFilter === FILTER_UTCO) return call.category === 'Utah County';
  if (activeFilter === FILTER_LOCAL) return LOCAL_TGS[call.tg] === 1;
  return true;
}

function poll() {
  var cfg = getConfig();
  if (!cfg.HOST) { sendStatus('set host'); return; }

  var xhr = new XMLHttpRequest();
  xhr.open('GET', feedUrl(cfg), true);
  xhr.timeout = 12000;
  if (cfg.USERNAME) {
    xhr.setRequestHeader('Authorization', 'Basic ' + b64(cfg.USERNAME + ':' + cfg.PASSWORD));
  }
  xhr.onload = function () {
    if (xhr.status === 401) { sendStatus('auth failed'); return; }
    if (xhr.status !== 200) { sendStatus('http ' + xhr.status); return; }
    var calls;
    try { calls = JSON.parse(xhr.responseText); }
    catch (e) { sendStatus('bad data'); return; }
    if (!calls || !calls.length) { sendStatus('no calls'); return; }

    // API returns chronological (oldest..newest). Send only ids past lastMaxId.
    var sent = 0;
    for (var i = 0; i < calls.length; i++) {
      var c = calls[i];
      if (!passesFilter(c)) continue;
      if (c.id > lastMaxId) {
        sendCall(c);
        lastMaxId = c.id;
        sent++;
      }
    }
    if (sent === 0) sendStatus('live');
  };
  xhr.onerror = function () { sendStatus('offline'); };
  xhr.ontimeout = function () { sendStatus('timeout'); };
  xhr.send();
}

function applyFilter(f) {
  activeFilter = f;
  lastMaxId = 0; // resend the full window for the new preset (watch cleared its cache)
  poll();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
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

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  var settings = clay.getSettings(e.response);
  var cfg = {
    HOST: (settings.HOST || '').trim(),
    USERNAME: (settings.USERNAME || '').trim(),
    PASSWORD: settings.PASSWORD || '',
    DEFAULT_FILTER: parseInt(settings.DEFAULT_FILTER, 10) || FILTER_LOCAL
  };
  localStorage.setItem('config', JSON.stringify(cfg));
  activeFilter = cfg.DEFAULT_FILTER;
  lastMaxId = 0;
  startPolling();
});
