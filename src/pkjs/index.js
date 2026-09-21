// ---------------------------------------------------------------------------
// Scanner Feed — PebbleKit JS bridge (runs on the phone)
//
// Polls the scanner backend's live-tail feed, filters by the active preset
// incident-grain home log by default (call-grain live tail on demand), and
// pushes one AppMessage per call to the watch. Credentials, host, favorite
// areas and muted talkgroups come from the Clay settings page (config.js).
//
// Endpoint (2026-06): the public feed moved from the old scanner-feed app
// (transcripts.zarchstuff.com/api/recent) INTO the analytics app at
// data.zarchstuff.com/feed/api/*. The old host now 302-redirects to the new
// one — and because XHR strips the Authorization header on a cross-origin
// redirect, hitting the old host fails basic auth ("auth failed") AND returns
// HTML ("bad data"). So we target data.zarchstuff.com directly, no redirect.
//
//   GET /reports/api/home-log?scope=S&limit=N -> {incidents:[...], ...}
//        Incident-grain log for the home geography, newest-first. THE DEFAULT
//        VIEW: one row per incident (or per unclustered call), carrying the
//        stored relevance tiers. `scope` widens the geography:
//        home(home_block) < ward < neighborhood < nearby(~1mi).
//   GET /feed/api/incident/<id>            -> {incident_id, calls:[...]}  (drill-down, chronological)
//   GET /feed/api/feed?limit=N&areas=...   -> {calls:[...], next_cursor}  (live seed/history, newest-first)
//   GET /feed/api/since?after_id=ID&areas= -> {calls:[...], max_id}       (live-tail; server filters hallucinations)
// ---------------------------------------------------------------------------

var Clay = require('pebble-clay');
var clayConfig = require('./config');
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

// MSG_TYPE values (must match main.c)
var MSG_CALL = 0;
var MSG_STATUS = 1;

// Views (must match main.c). 0-3 are incident-grain home-log scopes, widening
// outward from the home block; 4 is the call-grain live tail. Incidents lead
// because what happened near home matters more than the running commentary —
// the live feed is the interesting one, not the important one.
var VIEW_HOME = 0;    // home_block only
var VIEW_WARD = 1;    // + ward_household
var VIEW_NBHD = 2;    // + neighborhood_grid
var VIEW_NEARBY = 3;  // + near_home_area (~1 mi)
var VIEW_LIVE = 4;    // live call tail, HOME_AREAS preset
var VIEW_COUNT = 5;

// Maps a view to the home-log `scope` parameter (HOME_LOG_SCOPES in the
// backend's analytics/app/home_log.py).
var VIEW_SCOPES = ['home', 'ward', 'neighborhood', 'nearby'];

var SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };
// "Significant" floor for the incident views. Medium and up, EXCEPT that a
// home-block incident is never filtered out at any severity — the whole point
// of the view is that proximity outranks severity.
var MIN_SEVERITY_RANK = SEVERITY_RANK.medium;

// Filter -> backend `areas` chips (keys from analytics/app/areas.py). The
// backend resolves each area to tg_alpha_tag substrings, so we think in
// agencies, not talkgroup numbers. ALL sends no area filter (everything).
//
// The live tail is scoped to the home area, mirroring the backend's own
// MY_AREA_DEFAULT (["Orem"]): the "Orem" chip resolves to Orem/Lindon PD plus
// Orem Fire and the shared POL Fire dispatch, so one chip is genuinely police
// + fire for home. Override with the HOME_AREAS setting.
var DEFAULT_HOME_AREAS = 'Orem';

var SEED_LIMIT = 24;     // history to pull on launch / view switch (= watch MAX_CALLS)
// The live tail is a cheap indexed lookup by id, so poll it hard. The home log
// aggregates member calls per incident and is far heavier — a 10s poll on it
// would hammer the two sync gunicorn workers for data that changes on the
// order of minutes.
var POLL_LIVE_MS = 10000;
var POLL_LOG_MS = 60000;
var activeView = VIEW_HOME;
var lastMaxId = 0;       // server-side cursor: highest call id we've sent
var pollTimer = null;
// Set while the watch is drilled into one incident's member calls. Polling
// pauses there: the member list is a fixed, chronological set, and pushing
// fresh feed rows underneath the user would be nothing but confusing.
var openIncidentId = 0;

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
    DEFAULT_FILTER: VIEW_HOME,
    HOME_AREAS: DEFAULT_HOME_AREAS,  // area chips for the strict Home preset
    MUTE_TAGS: ''     // comma-separated tag substrings to drop from the feed
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

// First non-empty value among `names` on `obj`. The backend's feed schema has
// already been renamed under us once (see the 2026-06 migration note above), so
// read every field through a candidate list rather than a single hard-coded
// name: a rename then degrades to a missing sub-field instead of a blank feed.
function pick(obj, names) {
  for (var i = 0; i < names.length; i++) {
    var v = obj[names[i]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}

// Two-digit zero pad (no String.padStart in PebbleKit JS).
function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

// The watch shows a bare clock, and the row only has room for one. `time_local`
// has arrived as an ISO stamp, a "YYYY-MM-DD HH:MM:SS" string and (for the
// incident-shaped rows) a bare epoch int, so normalize all three to HH:MM:SS
// rather than blind-slicing the tail — `.slice(-15)` on an ISO stamp yields
// "9-21T14:03:22", which is what the watch used to render.
function clockOf(raw, hm) {
  if (typeof raw === 'number' || /^\d{9,11}$/.test(String(raw))) {
    var d = new Date(Number(raw) * 1000);
    var t = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return hm ? t : t + ':' + pad2(d.getSeconds());
  }
  var m = /(\d{1,2}:\d{2})(:\d{2})?/.exec(String(raw || ''));
  if (!m) return String(raw || '').slice(-8);
  return (hm || !m[2]) ? m[1] : m[1] + m[2];
}

// Personal-relevance tiers, from the backend's enricher (relevance_score() in
// enricher/neighborhood.py). The dashboard's "Notable" query orders by this
// ladder ahead of severity, and so does the watch: an ordinary call on the home
// block matters more than a critical one across the county.
//
// Sent as a small int because the watch sorts and colours on it; 0 covers both
// 'external' and a row the enricher hasn't scored yet.
var TIER_RANK = {
  home_block: 4,
  ward_household: 3,
  neighborhood_grid: 2,
  broader_orem: 1,
  external: 0
};

// A tier is only trustworthy once enrichment has confirmed it. The pre-Whisper
// scorer runs before `calls.city` is populated and mis-fires home_block on
// cross-city grid collisions — a Spanish Fork address landing on Orem's grid
// (see B-2026-05-12-1 / B-2026-05-15-1 in the backend's BUGS.md). The enricher
// rescore fixes the row ~30s later, so trust the tier only when the row says it
// has been enriched; treat an unenriched row as untiered rather than badging a
// call as "home block" on the strength of data the backend itself retracts.
function tierRank(call) {
  var enriched = pick(call, ['enriched']);
  if (enriched !== '' && !Number(enriched)) return 0;
  var tier = String(pick(call, ['relevance_tier', 'tier'])).toLowerCase();
  return TIER_RANK[tier] || 0;
}

function sendCall(call) {
  // New feed has no `emergency` bool — derive urgency from enrichment severity.
  var sev = pick(call, ['severity']);
  var emergency = (sev === 'critical' || sev === 'high') ? 1 : 0;
  // No `category` anymore; the most useful secondary line is the incident type
  // (e.g. "traffic stop") or the city, when enrichment has filled them in.
  var cat = pick(call, ['incident_type', 'city']);
  // `transcript_clean` is the cleaned-up text the backend prefers everywhere it
  // renders a call; fall back to the raw transcript, then to whatever summary
  // or snippet the row carries, so a call never lands on the watch with a blank
  // body.
  var text = pick(call, ['transcript_clean', 'transcript', 'transcript_snippet', 'summary']);
  enqueue({
    MSG_TYPE: MSG_CALL,
    CALL_ID: call.id,
    CALL_TIME: clockOf(pick(call, ['time_local', 'start_time', 'time'])),
    CALL_TAG: String(pick(call, ['tg_alpha_tag', 'talkgroup', 'tg'])).slice(0, 26),
    CALL_CAT: String(cat).slice(0, 18),
    CALL_TEXT: String(text).slice(0, 156),
    CALL_EMERG: emergency,
    CALL_TIER: tierRank(call),
    CALL_LOC: '',
    // Live-call ids are monotonic, so the id doubles as the sort key.
    CALL_ORD: Number(call.id) || 0,
    CALL_INC: 0   // a call row is already the leaf; nothing to drill into
  });
}

// ---------------------------------------------------------------------------
// Incident rows (home log)
// ---------------------------------------------------------------------------
// Highest tier among an incident's member calls. home_log returns `tiers` as an
// array because one incident can span several — a call on the home block and a
// follow-up two streets over cluster together, and the row should read as the
// closer of the two.
function incidentTier(inc) {
  var tiers = inc.tiers || [];
  var best = 0;
  for (var i = 0; i < tiers.length; i++) {
    var r = TIER_RANK[String(tiers[i]).toLowerCase()] || 0;
    if (r > best) best = r;
  }
  return best;
}

// The "significant" gate. Medium and up, except that a home-block incident
// always passes: a minor call on your own block is the thing this view exists
// to surface, and severity is the backend's judgement of the radio traffic,
// not of how much it matters to you.
function isSignificant(inc) {
  if (incidentTier(inc) >= TIER_RANK.home_block) return true;
  return (SEVERITY_RANK[String(inc.severity || '').toLowerCase()] || 0)
           >= MIN_SEVERITY_RANK;
}

function sendIncident(inc) {
  var sev = String(inc.severity || '').toLowerCase();
  var emergency = (sev === 'critical' || sev === 'high') ? 1 : 0;
  // Secondary line: what happened, else where. Append the member-call count
  // when an incident is more than a single call — "3 calls" is a useful signal
  // that something is still developing.
  // Two lines of identity: WHAT on the lead, WHERE under it.
  //
  // incident_type is the real "what", but the backend leaves it NULL on plenty
  // of rows — then the address leads instead, since near home the where IS most
  // of the answer. `loc` is sent only when it would not simply repeat the lead,
  // so a row never spends a line saying the same thing twice; the watch gives
  // the summary that line back when `loc` is empty.
  var where = pick(inc, ['address', 'city']);
  var cat = pick(inc, ['incident_type']) || where;
  var loc = (where && where !== cat) ? where : '';
  // The member count rides the lead line, since that is what the list draws for
  // an incident — "5 calls" is how you tell a finished incident from one still
  // developing. But the TYPE is the thing the user came for, so the count is
  // appended only when it still fits: ~18 characters is all that survives next
  // to the clock at Gothic 18 Bold on a 200px screen, and a truncated
  // "suspicious vehi…" is worse than no count at all. It is spelled out in the
  // member list's header either way.
  //
  // U+00B7 middle dot, written as the character rather than as its UTF-8 bytes:
  // the AppMessage layer encodes the string itself, so a hand-rolled \xC2\xB7
  // gets double-encoded and lands on the watch as mojibake.
  var n = Number(inc.local_call_count || inc.incident_member_count || 0);
  if (n > 1) {
    var withCount = cat + '\u00B7' + n;
    if (withCount.length <= 18) cat = withCount;
  }
  var tag = String(pick(inc, ['agency', 'tg_alpha_tag']));
  // Prefer the LLM summary; fall back to the representative call's transcript.
  var text = pick(inc, ['summary', 'representative_excerpt', 'latest_excerpt']);
  enqueue({
    MSG_TYPE: MSG_CALL,
    CALL_ID: Number(inc.event_key) || 0,
    // Seconds are noise on an episode that spanned minutes, and the space goes
    // to the incident type instead.
    CALL_TIME: clockOf(pick(inc, ['start_time', 'when']), true),
    CALL_TAG: tag.slice(0, 26),
    CALL_CAT: String(cat).slice(0, 24),
    CALL_LOC: String(loc).slice(0, 22),
    CALL_TEXT: String(text).slice(0, 156),
    CALL_EMERG: emergency,
    CALL_TIER: incidentTier(inc),
    // event_key is not guaranteed to run in time order, so sort on start_time
    // rather than on the id the way the live tail does.
    CALL_ORD: Number(inc.start_time) || 0,
    // 0 for an unclustered single call — the watch then has nothing to open.
    CALL_INC: Number(inc.incident_id) || 0
  });
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
// Parse a comma-separated settings string into a trimmed, non-empty list.
function parseList(s) {
  return String(s || '').split(',').map(function (x) { return x.trim(); })
                        .filter(function (x) { return x.length > 0; });
}

// Mute: drop calls whose talkgroup tag contains any user-configured substring
// (case-insensitive). Filtered on the phone so muted calls never reach the
// watch or its cache.
function isMuted(cfg, call) {
  var mutes = parseList(cfg.MUTE_TAGS);
  if (!mutes.length) return false;
  var tag = String(call.tg_alpha_tag || '').toLowerCase();
  for (var i = 0; i < mutes.length; i++) {
    if (tag.indexOf(mutes[i].toLowerCase()) >= 0) return true;
  }
  return false;
}

// The live tail is scoped to the home area. An empty setting falls back to the
// built-in default rather than widening to everything — the one preset the user
// never explicitly chose must not quietly become statewide.
function areaParam(cfg) {
  var home = parseList(cfg.HOME_AREAS);
  if (!home.length) home = parseList(DEFAULT_HOME_AREAS);
  return '&areas=' + encodeURIComponent(home.join(','));
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

// ---------------------------------------------------------------------------
// Incident log (the default view)
// ---------------------------------------------------------------------------
// No cursor here: the home log has no "since" endpoint, so each poll re-reads
// the top of the list. The watch dedupes by id and updates rows in place, so
// re-sending a row it already holds is cheap and keeps late enrichment (a
// summary or severity landing minutes after the call) flowing through.
function pollHomeLog(cfg) {
  var scope = VIEW_SCOPES[activeView] || VIEW_SCOPES[0];
  apiGet(cfg, '/reports/api/home-log?scope=' + scope + '&limit=' + SEED_LIMIT,
    function (body) {
      // The endpoint answers 200 with unavailable:true when its query fails,
      // rather than an error status — so check the flag, not just the code.
      if (body && body.unavailable) { sendStatus('log down'); return; }
      var incs = (body && body.incidents) || [];
      var shown = 0;
      // Newest-first from the server; send oldest-first so the watch's "pin to
      // top" lands on the most recent.
      for (var i = incs.length - 1; i >= 0; i--) {
        if (!isSignificant(incs[i])) continue;
        sendIncident(incs[i]);
        shown++;
      }
      // Distinguish "nothing happened near home" (the good, common case) from
      // "everything was filtered out", which means the floor is set too high.
      if (!shown) {
        sendStatus(incs.length ? 'none sig' : 'all quiet');
        return;
      }
      // The status bar already names the view, so echoing the scope back would
      // just read "Home \u00B7 home". The count is the thing it doesn't know.
      sendStatus(shown + ' inc');
    });
}

// Drill-down: the member calls of one incident, chronological.
function fetchIncidentCalls(cfg, incId) {
  apiGet(cfg, '/feed/api/incident/' + incId, function (body) {
    var calls = (body && body.calls) || [];
    if (!calls.length) { sendStatus('no calls'); return; }
    // Chronological from the server. The watch sorts newest-first, so order
    // here doesn't matter for placement — but send oldest-first anyway so the
    // list settles on the newest call the same way every other view does.
    for (var i = 0; i < calls.length; i++) {
      if (!isMuted(cfg, calls[i])) sendCall(calls[i]);
    }
    sendStatus(calls.length + ' calls');
  });
}

// Seed: pull recent history for the active preset and prime the cursor.
function seed(cfg) {
  apiGet(cfg, '/feed/api/feed?limit=' + SEED_LIMIT + areaParam(cfg), function (body) {
    var calls = (body && body.calls) || [];
    if (!calls.length) { sendStatus('no calls'); return; }
    // /api/feed is newest-first; send oldest-first so the watch's "pin to top"
    // ends on the most recent call.
    var maxId = lastMaxId;
    for (var i = calls.length - 1; i >= 0; i--) {
      // Advance the cursor past muted calls too, so we don't re-pull them.
      if (calls[i].id > maxId) maxId = calls[i].id;
      if (!isMuted(cfg, calls[i])) sendCall(calls[i]);
    }
    lastMaxId = maxId;
    sendStatus('live');
  });
}

// Live-tail: ask the server for calls past our cursor. after_id=0 just seeds
// the cursor (empty calls + current max_id), so we never re-dump history here.
function pollSince(cfg) {
  apiGet(cfg, '/feed/api/since?after_id=' + lastMaxId + areaParam(cfg), function (body) {
    var calls = (body && body.calls) || [];
    // Server computes max_id from RAW rows (advances past hallucinations it
    // filtered out of `calls`), so trust it over the call ids we see.
    if (typeof body.max_id === 'number' && body.max_id > lastMaxId) {
      lastMaxId = body.max_id;
    }
    if (!calls.length) { sendStatus('live'); return; }
    for (var i = calls.length - 1; i >= 0; i--) {
      if (!isMuted(cfg, calls[i])) sendCall(calls[i]);
    }
    sendStatus('live');
  });
}

function poll() {
  var cfg = getConfig();
  if (!cfg.HOST) { sendStatus('set host'); return; }
  // Drilled into an incident: its member list is fixed, so hold still.
  if (openIncidentId) return;
  // The backend is gated by NPM basic auth, so a missing credential is a
  // guaranteed 401. Surface that distinctly instead of letting it come back as
  // the ambiguous 'auth failed' (which otherwise can't be told apart from
  // *wrong* creds — see the credential-preserving save in webviewclosed).
  if (!cfg.USERNAME) { sendStatus('set creds @' + hostTag(cfg.HOST)); return; }

  if (activeView !== VIEW_LIVE) { pollHomeLog(cfg); return; }
  if (lastMaxId === 0) seed(cfg);
  else pollSince(cfg);
}

function applyView(v) {
  if (isNaN(v) || v < 0 || v >= VIEW_COUNT) return;
  activeView = v;
  openIncidentId = 0;
  lastMaxId = 0;  // watch cleared its cache on switch — reseed for the new view
  startPolling();
}

// The watch asks to open an incident; reply with its member calls and stop
// polling until it backs out.
function openIncident(incId) {
  openIncidentId = incId;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  fetchIncidentCalls(getConfig(), incId);
}

function closeIncident() {
  openIncidentId = 0;
  lastMaxId = 0;  // the watch cleared its cache on the way out
  startPolling();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  // Announce the target host on launch so the watch confirms which backend
  // it's hitting (i.e. that the transcripts->data migration fired). The first
  // poll result overwrites this a moment later.
  sendStatus('-> ' + getConfig().HOST);
  poll();
  var every = (activeView === VIEW_LIVE) ? POLL_LIVE_MS : POLL_LOG_MS;
  pollTimer = setInterval(poll, every);
}

// ---------------------------------------------------------------------------
// Pebble events
// ---------------------------------------------------------------------------
Pebble.addEventListener('ready', function () {
  var cfg = getConfig();
  var df = parseInt(cfg.DEFAULT_FILTER, 10);
  activeView = (isNaN(df) || df < 0 || df >= VIEW_COUNT) ? VIEW_HOME : df;
  startPolling();
});

// CMD values (must match main.c)
var CMD_OPEN_INCIDENT = 1;
var CMD_CLOSE_INCIDENT = 2;

Pebble.addEventListener('appmessage', function (e) {
  var p = e && e.payload;
  if (!p) return;
  if (p.CMD === CMD_OPEN_INCIDENT && p.CALL_INC) {
    openIncident(p.CALL_INC);
    return;
  }
  if (p.CMD === CMD_CLOSE_INCIDENT) {
    closeIncident();
    return;
  }
  if (p.FILTER !== undefined) applyView(p.FILTER);
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
  var home = String(settingValue(settings, 'HOME_AREAS')).trim();
  var mute = String(settingValue(settings, 'MUTE_TAGS')).trim();

  // The Clay form opens blank each time (we persist config ourselves), so an
  // empty field means "unchanged" — keep the saved value. To deliberately
  // clear a list, type "none".
  function listField(raw, prevVal) {
    if (!raw) return prevVal;
    return (raw.toLowerCase() === 'none') ? '' : raw;
  }

  var cfg = {
    HOST: host || prev.HOST,
    USERNAME: user || prev.USERNAME,
    PASSWORD: pass || prev.PASSWORD,
    DEFAULT_FILTER: isNaN(df) ? prev.DEFAULT_FILTER : df,
    HOME_AREAS: listField(home, prev.HOME_AREAS) || DEFAULT_HOME_AREAS,
    MUTE_TAGS: listField(mute, prev.MUTE_TAGS)
  };
  localStorage.setItem('config', JSON.stringify(cfg));
  applyView(parseInt(cfg.DEFAULT_FILTER, 10));
});
