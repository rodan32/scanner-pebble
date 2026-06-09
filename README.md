# Scanner Feed — Pebble Time 2 watchapp

A live-ish P25 scanner feed for the Pebble Time 2 (`emery`). The phone polls
the scanner backend (`transcripts.zarchstuff.com/api/recent`), filters by a
preset, and pushes calls to the watch, which keeps a small persistent cache so
it opens instantly with the last-known feed.

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

- **Local** — Eagle Mountain / Saratoga / Lehi / American Fork talkgroups +
  Utah County Sheriff. Talkgroup list lives in `src/pkjs/index.js` (`LOCAL_TGS`);
  a couple are marked *verify* — tune as confirmed.
- **Utah Co** — everything in the `Utah County` category.
- **All** — unfiltered recent feed.

## Architecture

- `src/c/main.c` — watchapp: feed list (MenuLayer), detail view (ScrollLayer),
  filter cycling, persistent ring buffer (`MAX_CALLS = 24`).
- `src/pkjs/index.js` — PebbleKit JS: polls `/api/recent` every 10s, filters by
  preset, sends one AppMessage per call. Basic-auth creds come from settings.
- `src/pkjs/config.js` — Clay settings page (host / user / password / default
  filter). Nothing sensitive is committed.

The watch can't reach the LAN directly — all network access is through the
phone (PebbleKit JS). The backend is public over HTTPS (Cloudflare + NPM basic
auth), so the phone bridge works on any network.

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
| `CALL_TAG`   | JS→watch  | talkgroup alpha tag                      |
| `CALL_CAT`   | JS→watch  | category                                 |
| `CALL_TEXT`  | JS→watch  | transcript (truncated ~156 chars)        |
| `CALL_EMERG` | JS→watch  | 1 if emergency flag set                  |
| `STATUS`     | JS→watch  | connection/status text                   |
| `FILTER`     | watch→JS  | 0 = Local, 1 = Utah Co, 2 = All          |

## Roadmap

- Emergency vibrate + highlight (flag is already plumbed through).
- Ask query (canned/dictated questions to `/ask`).
- Favorites-based talkgroup switching.
