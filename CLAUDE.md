# scanner-pebble — working notes

Pebble Time 2 (`emery`) watchapp: a live-ish P25 scanner feed. The phone
(PebbleKit JS) polls the backend, filters by preset, and pushes calls to the
watch over AppMessage; the watch keeps a small persistent ring buffer.

## Canonical branch
- **`master`** is the single source of truth and GitHub's default branch.
  CloudPebble builds from it and the watch is flashed from those builds.
- Do work on `master` (or a short-lived branch merged straight back). The
  old `main` / `claude/*` branches were stray duplicates.

## Build / run (CloudPebble — no local builds)
Local builds aren't practical on aarch64 (no `stpyv8` wheels). CloudPebble is
the build backend, GitHub-synced to this repo. **Pull ≠ build ≠ install** —
after pushing, in CloudPebble: *Pull from GitHub → Run build → Install*. Bump
`version` in `package.json` so the watch's About screen confirms the new build
landed. If new PebbleKit JS doesn't take, delete the app from the watch and
reinstall (the phone caches the JS).

## Layout
- `src/c/main.c` — watchapp UI: MenuLayer feed, ScrollLayer detail, ring buffer.
- `src/pkjs/index.js` — phone bridge: poll, filter, Basic auth, AppMessage.
- `src/pkjs/config.js` — Clay settings page.
- `test/harness.js` — run the JS bridge without a watch:
  `node test/harness.js home --offline` (canned payloads, no network) or
  `node test/harness.js home` (routes to the internal CT137 container; needs LAN).
  Views: `home|ward|nbhd|nearby|live`; add `--open <incident_id>` to exercise
  the drill-down.
- `test/fixtures.json` — canned `/feed/api/*` payloads for `--offline`.
- `test/stub/pebble.h` — stand-in SDK header so `main.c` can be type-checked here.

## Check before you push
`sh test/check.sh` — type-checks `main.c` (color **and** B&W), syntax-checks the
JS, and runs the bridge against the fixtures. Not a build; it just catches the
cheap mistakes without a CloudPebble round trip.

## Design
Incident-grain first. The default views are the backend's own home-log scopes
(`HOME_LOG_SCOPES` in `analytics/app/home_log.py`) widening outward from the
home block; the live call tail is last in the cycle. Significance is applied on
the phone — medium and up, except that a home-block incident always passes.
Proximity gets the accent bar, severity only tints text, rows stay
chronological. A row leads with the incident type, carries the address beneath
it, and gives that line back to the summary when there is no address.
Drill-down is list -> incident detail -> its calls -> one transcript; the detail
exists because it is the only place the full summary fits. See "What counts as
significant" in `README.md`.

## Backend coupling
The feed schema has been renamed under this app once already (2026-06:
`transcripts.zarchstuff.com/api/recent` -> `data.zarchstuff.com/feed/api/*`).
`src/pkjs/index.js` therefore reads every field through `pick()` with a list of
candidate names rather than one hard-coded name. When the backend changes, add
the new row shape to `test/fixtures.json`, run
`node test/harness.js home --offline`, and extend the `pick()` lists — don't
rewrite the mapping.

Endpoints in use: `/reports/api/home-log` (incident views),
`/feed/api/incident/<id>` (drill-down), `/feed/api/feed` + `/feed/api/since`
(live tail). Screens are mocked at emery's real geometry at
https://claude.ai/artifact/MVDBUJx3RPLYo28xGqsLak

## Gotchas
Read the "Hard-won gotchas" section in `README.md` before touching settings,
auth, or the build pipeline — especially `clay.getSettings(e.response, false)`
(the default `convert=true` keys by numeric id and silently drops creds).
