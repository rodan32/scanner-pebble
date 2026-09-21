# Scanner Feed — Pebble Time 2 watchapp

An **incident-first** scanner companion for the Pebble Time 2 (`emery`). The
phone polls the scanner backend, and the watch shows one row per incident near
home — not a running call feed. The raw call tail is still there, one long-press
away, because it is the interesting view rather than the important one.

Companion to the PicoCalc Scanner Terminal — same backend, Pebble-native UI.

## Views

Long-press SELECT cycles five views. The first four are the backend's own home
geography scopes (`HOME_LOG_SCOPES` in `analytics/app/home_log.py`), widening
outward; the fifth is the call-grain live tail.

| View       | Grain    | Shows                                          |
|------------|----------|------------------------------------------------|
| **Home**   | incident | your home block only                           |
| **Ward**   | incident | + ward households                              |
| **Nbhd**   | incident | + the neighborhood grid                        |
| **Nearby** | incident | + roughly a mile out                           |
| **Live**   | call     | raw call tail for `HOME_AREAS` (default `Orem`)|

## Controls

| Context   | Button         | Action                                          |
|-----------|----------------|-------------------------------------------------|
| List      | UP / DOWN      | scroll                                          |
| List      | SELECT (short) | open the detail for the highlighted row         |
| List      | SELECT (long)  | cycle the view                                  |
| Detail    | UP / DOWN      | scroll; at the top/bottom, step prev/next       |
| Detail    | SELECT         | *(incident only)* open the calls behind it      |
| Detail    | BACK           | return to the list                              |
| Calls     | SELECT         | open that call's transcript                     |
| Calls     | BACK           | return to the incident detail                   |

SELECT always goes one level deeper, and every level is one step:

```
incident list ─SELECT▶ incident detail ─SELECT▶ its calls ─SELECT▶ transcript
              ◀─BACK──                 ◀─BACK──            ◀─BACK──
```

The **incident detail** sits between the list and the calls because it is the
only place the full summary fits — a row gives it one or two clipped lines.
Jumping the list straight to raw radio traffic skipped the one screen that
actually explains the incident.

An unclustered incident (no `incident_id`) has no calls behind it, so SELECT on
its detail does nothing; a transcript is a leaf for the same reason. While you
are inside an incident's calls the phone stops polling — the member list is a
fixed set, and pushing fresh feed rows in underneath would only be confusing.

## What counts as significant

`/reports/api/home-log` has no severity parameter, so the floor is applied on
the phone:

- **medium and up**, *except*
- **a home-block incident always passes, at any severity.**

A minor call on your own block is exactly what this view exists to surface;
severity is the backend's read of the radio traffic, not of how much it matters
to you.

An **incident row leads with the incident type**, not the talkgroup. Once a row
is an episode rather than a single transmission, who was talking matters much
less than what happened — so the agency moves to the detail view and keeps only
its colour here. `incident_type` is NULL on plenty of rows, so the lead falls
back to the address, then the city: near home, *where* is most of the answer.

Under it sits the **where**, in a smaller, dimmer font. The row adapts rather
than growing: the phone sends a location only when it would not simply repeat
the lead, and when there is none the summary takes that line back.

```
17:40           suspicious vehicle      type leads, count if it fits
640 N 700 E                             where, when it isn't the lead
Reports of an unfamiliar…               summary gets one line

17:13                640 N 700 E·2      no type — the address leads
Caller reports a garage door            …so the summary keeps both
left open overnight on the…
```

Incident rows are 66px rather than 46px. At 46px the summary gets one line —
about thirty characters — which truncates mid-clause and leaves a list of bare
timestamps. The extra height costs one visible row and is the difference between
a feed you can read and one you have to open.

The clock drops to `HH:MM` on incidents — seconds are noise on something that
spanned minutes, and the space goes to the type. The member count (`·3`) is
appended to the lead only when it still fits in ~18 characters; a truncated
`suspicious vehi…` is worse than no count, and the member list spells it out in
its header anyway.

Rows stay in **chronological** order. Proximity gets its own visual channel
instead of a competing sort: a 4px accent bar in the left margin — red for home
block, orange ward, yellow neighborhood, blue nearby — with severity only
tinting the text, and a home-block incident spelling it out in the detail
header so B&W watches get it too.

**Tiers are only trusted once enriched.** The backend's pre-Whisper scorer
fires `home_block` on cross-city grid collisions before `calls.city` is
populated, and the enricher retracts it ~30s later (`B-2026-05-12-1`,
`B-2026-05-15-1`). The bridge treats an unenriched row as untiered rather than
badging a call as "home block" on data the backend itself withdraws.

**Muting:** `MUTE_TAGS` (settings) is a comma-separated list of substrings; any
call whose talkgroup contains one is dropped on the phone before it reaches the
watch. Blank keeps the current value; type `none` to clear.

## Architecture

- `src/c/main.c` — watchapp: feed list (MenuLayer), member-call list (a second
  window, so BACK pops natively), detail view (ScrollLayer), view cycling,
  persistent ring buffer (`MAX_CALLS = 24`, `MAX_MEMBERS = 12`).
- `src/pkjs/index.js` — PebbleKit JS. Polls `/reports/api/home-log` every 60s
  for the incident views, or seeds `/feed/api/feed` and live-tails
  `/feed/api/since` every 10s for the Live view, and fetches
  `/feed/api/incident/<id>` on drill-down. One AppMessage per row.
- `src/pkjs/config.js` — Clay settings page (host / user / password / opening
  view / home areas / muted talkgroups). Nothing sensitive is committed.

The home log aggregates member calls per incident and is far heavier than the
live tail's indexed lookup by id, which is why the two poll at different rates —
a 10s poll on it would hammer the backend's two sync gunicorn workers for data
that changes on the order of minutes.

The watch can't reach the LAN directly — all network access is through the
phone (PebbleKit JS). The backend is public over HTTPS (Cloudflare + NPM basic
auth), so the phone bridge works on any network.

> **Host gotcha (2026-06):** the feed moved from the old scanner-feed app
> (`transcripts.zarchstuff.com/api/recent`) into the analytics app at
> `data.zarchstuff.com`. The old host now **302-redirects** to the new one —
> and XHR **strips the `Authorization` header on a cross-origin redirect**, so
> pointing the watch at `transcripts…` fails basic auth (`auth failed`) and
> returns HTML (`bad data`). Always use `data.zarchstuff.com` directly.

## Pre-flight checks (no SDK, no watch, no network)

```
sh test/check.sh
```

Type-checks `src/c/main.c` against `test/stub/pebble.h` (a hand-written
stand-in for the SDK header) in **both** the color and B&W configurations,
syntax-checks the JS, then runs the bridge against canned feed payloads. A
clean run proves the code parses and type-checks — it is *not* a build, and
says nothing about on-device behaviour. Run it before every push; it is far
cheaper than a CloudPebble round trip.

## Testing the JS bridge (no watch needed)

`test/harness.js` mocks the Pebble runtime, loads the real `src/pkjs/index.js`,
and prints the exact AppMessages the watch would receive.

```
node test/harness.js home --offline       # canned payloads, no network
node test/harness.js home                 # or: local | utco | all | fav
HOME_AREAS="Orem, Lindon" node test/harness.js home
```

`--offline` serves `test/fixtures.json` instead of the network, so it runs
anywhere. The other modes route the app's `data.zarchstuff.com` requests to the
internal analytics container (CT137, no auth), which needs LAN access but hits
the real query paths.

The fixtures deliberately mix field shapes — `transcript` vs `transcript_clean`
vs `transcript_snippet`, `tg_alpha_tag` vs `talkgroup` vs `tg`, an ISO
`time_local` vs a bare epoch `start_time`. The bridge reads every field through
a candidate list (`pick()` in `index.js`), so a backend rename degrades to one
blank sub-field rather than an empty feed. **When the feed schema changes, add
the new shape to `fixtures.json` and run `--offline` before touching anything
else** — that is the cheapest way to find out what the watch would render.

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

| Key          | Dir       | Meaning                                       |
|--------------|-----------|-----------------------------------------------|
| `MSG_TYPE`   | JS→watch  | 0 = row, 1 = status                           |
| `CALL_ID`    | JS→watch  | row identity: call id, or incident `event_key`|
| `CALL_ORD`   | JS→watch  | sort key, descending: call id or `start_time` |
| `CALL_INC`   | JS→watch  | incident id to drill into; 0 = leaf row       |
| `CALL_TIER`  | JS→watch  | relevance tier 0-4 (4 = home block)           |
| `CALL_TIME`  | JS→watch  | `HH:MM:SS` on calls, `HH:MM` on incidents     |
| `CALL_TAG`   | JS→watch  | talkgroup / agency (lead on call rows)        |
| `CALL_CAT`   | JS→watch  | incident type / address, `·N` (lead on incidents) |
| `CALL_LOC`   | JS→watch  | where, only when it isn't already the lead    |
| `CALL_TEXT`  | JS→watch  | summary or transcript (~156 chars)            |
| `CALL_EMERG` | JS→watch  | 1 if severity is high/critical                |
| `STATUS`     | JS→watch  | connection/status text                        |
| `FILTER`     | watch→JS  | view 0-4 (Home…Live)                          |
| `CMD`        | watch→JS  | 1 = open incident (with `CALL_INC`), 2 = back |

`CALL_ORD` exists because the home log's `event_key` is not guaranteed to run
in time order — the watch sorts on `ord` and uses the id purely as identity, so
re-sending a row (late enrichment landing a summary or severity minutes after
the call) updates it in place instead of duplicating it.

## Roadmap

- Ask query (canned/dictated questions to `/ask`).
- Per-call audio playback on the phone (`Pebble.openURL` to the call's audio
  URL) — parked until the backend exposes a per-call audio endpoint. Watch-side
  speaker playback waits on a PebbleOS app audio API.
- Emergency vibrate + highlight (flag is already plumbed through) — deferred;
  scanner emergencies are currently too noisy to be useful.
