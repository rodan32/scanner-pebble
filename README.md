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
