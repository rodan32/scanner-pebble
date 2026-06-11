# Scanner Feed — Pebble Time 2 watchapp

A live-ish P25 scanner feed for the Pebble Time 2 (`emery`). The phone polls
the scanner backend (`data.zarchstuff.com/feed/api/*`), filters by a preset,
and pushes calls to the watch, which keeps a small persistent cache so it opens
instantly with the last-known feed.

Companion to the PicoCalc Scanner Terminal — same backend, Pebble-native UI.

## Controls

| Button            | Action                                        |
|-------------------|-----------------------------------------------|
| UP / DOWN         | scroll the feed                               |
| SELECT (short)    | open the full transcript for the call         |
| SELECT (long)     | cycle filter: **Local → Utah Co → All**       |

The top bar shows the active filter and connection status (`live`, `offline`,
`auth failed`, etc.).

## Filters

Filtering is by **area** — the backend resolves each area chip to `tg_alpha_tag`
substrings (`analytics/app/areas.py`). The presets map to area lists in
`src/pkjs/index.js`:

- **Local** — busiest nearby agencies: Orem, Lehi, American Fork, UtCo Sheriff,
  UtCo Fire/EMS. (Orem/Lindon PD is by far the highest-volume TG, so this
  preset always has a steady feed.)
- **Utah Co** — every Utah-County-area chip.
- **All** — unfiltered (statewide: UHP, DPS, SLCo, etc.).

## Architecture

- `src/c/main.c` — watchapp: feed list (MenuLayer), detail view (ScrollLayer),
  filter cycling, persistent ring buffer (`MAX_CALLS = 24`).
- `src/pkjs/index.js` — PebbleKit JS: seeds history from `/feed/api/feed`, then
  live-tails `/feed/api/since?after_id=` every 10s, sending one AppMessage per
  call. Basic-auth creds come from settings.
- `src/pkjs/config.js` — Clay settings page (host / user / password / default
  filter). Nothing sensitive is committed.

The watch can't reach the LAN directly — all network access is through the
phone (PebbleKit JS). The backend is public over HTTPS (Cloudflare + NPM basic
auth), so the phone bridge works on any network.

> **Host gotcha (2026-06):** the feed moved from the old scanner-feed app
> (`transcripts.zarchstuff.com/api/recent`) into the analytics app at
> `data.zarchstuff.com/feed/api/*`. The old host now **302-redirects** to the
> new one — and XHR **strips the `Authorization` header on a cross-origin
> redirect**, so pointing the watch at `transcripts…` fails basic auth
> (`auth failed`) and returns HTML (`bad data`). Always use `data.zarchstuff.com`
> directly. The new `/feed/api/*` responses are wrapped objects
> (`{calls:[…], max_id}`), not bare arrays.

## Hard-won gotchas (read before reusing this as a template)

Every one of these cost real debugging time on this app. If you're starting a
new Pebble + Clay + CloudPebble project, read these first.

### 1. `clay.getSettings()` defaults to `convert=true` — read with `false`

This was the big one: **settings entered in the config page silently saved as
empty.** `clay.getSettings(e.response)` defaults to `convert: true`, which
returns the settings keyed by **numeric message-key IDs** (the shape
`Pebble.sendAppMessage()` wants). Reading them by *name* — `settings.USERNAME` —
is then always `undefined`, so you persist blank values and never notice.

```js
// WRONG — keys are numeric ids; settings.USERNAME is undefined
var settings = clay.getSettings(e.response);
var user = settings.USERNAME;

// RIGHT — keys are the string messageKey; value is under `.value`
var settings = clay.getSettings(e.response, false);
var user = settings.USERNAME && settings.USERNAME.value;
```

Only do this if you read settings by name on the JS side (as we do, persisting
to our own `localStorage`). If you just forward the dict straight to
`sendAppMessage`, the default `convert: true` is correct.

### 2. With `autoHandleEvents: false`, you own persistence — and the form opens blank

We pass `autoHandleEvents: false` so we can store config under our own key. The
trade-off: Clay does **not** repopulate the form from your storage, so it opens
blank every time. Treat an empty field on save as **"unchanged," not "clear"** —
fall back to the saved value — or a settings tweak (e.g. just changing a filter)
will silently wipe creds. See `webviewclosed` in `src/pkjs/index.js`.

### 3. HTTP Basic auth must be UTF-8, then base64 (RFC 7617)

PebbleKit JS has no reliable `btoa`/`TextEncoder`. A hand-rolled base64 that
does `charCodeAt(i) & 0xff` is correct **only for ASCII** — any non-ASCII char
in a username/password (accent, `£`, dash, emoji) gets truncated and the server
401s on correct creds. UTF-8-encode the `user:pass` string first, then base64.
See `toUtf8` / `authHeader` in `src/pkjs/index.js`.

### 4. XHR strips `Authorization` across a cross-origin redirect

If your endpoint 301/302s to a different host, the browser/XHR drops the
`Authorization` header on the redirected request and you get a 401 that looks
like bad creds. Target the final host directly; don't rely on a redirect.

### 5. CloudPebble's GitHub sync is manual, one-branch, and doesn't build

The slowest part of this whole saga was the build pipeline, not the code:

- **Pull ≠ build ≠ install.** They're three separate actions. A GitHub pull
  only updates source in CloudPebble; you still have to **Run build** and then
  **Install** to the phone.
- **Sync is manual and per-branch.** CloudPebble pulls one configured branch
  (usually `master`) only when you click *Pull from GitHub* — it does not
  auto-sync on push. Develop on a branch but get it onto the branch CloudPebble
  tracks.
- **Bump the version** (`package.json` → `version`) so you can *confirm on the
  watch* that the new build actually landed (check the app's About screen).
  Half this app's "fixes didn't work" turns were just stale builds.
- **PebbleKit JS is cached by the phone app.** If new JS doesn't take, **delete
  the app from the watch and reinstall**, and force-quit/reopen the Pebble phone
  app to clear the bridge cache.
- If a pull "succeeds" but the editor still shows old code, **delete the
  CloudPebble project and re-import fresh** rather than fighting a stuck sync.

### 6. Make failure states legible on the watch

The watch's only debug channel is the status line, so make it carry signal:
distinguish `set creds` (no credential stored) from `auth failed` (server
rejected) from `offline`/`timeout`, and tag the host (`@data`) so a stuck watch
tells you where it was pointed. When stuck, a temporary status that reports
*lengths* of stored values (never the values themselves) is a safe way to see
what's actually in storage.

## Testing the JS bridge (no watch needed)

`test/harness.js` mocks the Pebble runtime, loads the real `src/pkjs/index.js`,
and routes its `data.zarchstuff.com` requests to the internal analytics
container (CT137, no auth) so you can see the exact AppMessages the watch would
receive:

```
node test/harness.js local   # or: utco | all
```

## Build & install (CloudPebble)

This repo is the source of truth; CloudPebble is the build/flash backend
(local builds are impractical on aarch64 — no `stpyv8` wheels).

1. Go to https://cloudpebble.io (or developer.repebble.com → CloudPebble) and
   sign in with your Core Devices / Rebble account.
2. **Import** → from this repo (push it to GitHub/Gitea first) **or** create a
   new project and paste in `src/c/main.c`, `src/pkjs/index.js`,
   `src/pkjs/config.js`, and mirror the `messageKeys` from `package.json`.
3. Add the **pebble-clay** dependency (Dependencies tab) so the settings page
   builds.
4. Set the target platform to **emery** (Time 2). `basalt`/`chalk`/`diorite`
   are also enabled for the emulator.
5. Build, then **Install** to your phone-paired Time 2.
6. On the watch app's **Settings** (gear in the Pebble phone app), enter the
   host + basic-auth username/password and pick a default filter.

## Protocol (AppMessage keys)

| Key          | Dir       | Meaning                                  |
|--------------|-----------|------------------------------------------|
| `MSG_TYPE`   | JS→watch  | 0 = call, 1 = status                     |
| `CALL_ID`    | JS→watch  | DB id (dedupe / ordering key)            |
| `CALL_TIME`  | JS→watch  | local time string                        |
| `CALL_TAG`   | JS→watch  | talkgroup alpha tag (`tg_alpha_tag`)     |
| `CALL_CAT`   | JS→watch  | incident type / city (often empty)       |
| `CALL_TEXT`  | JS→watch  | transcript (truncated ~156 chars)        |
| `CALL_EMERG` | JS→watch  | 1 if severity is high/critical           |
| `STATUS`     | JS→watch  | connection/status text                   |
| `FILTER`     | watch→JS  | 0 = Local, 1 = Utah Co, 2 = All          |

## Roadmap

- Emergency vibrate + highlight (flag is already plumbed through).
- Ask query (canned/dictated questions to `/ask`).
- Favorites-based talkgroup switching.
