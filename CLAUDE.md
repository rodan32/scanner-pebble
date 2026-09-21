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
  `node test/harness.js local --offline` (canned payloads, no network) or
  `node test/harness.js local` (routes to the internal CT137 container; needs LAN).
- `test/fixtures.json` — canned `/feed/api/*` payloads for `--offline`.
- `test/stub/pebble.h` — stand-in SDK header so `main.c` can be type-checked here.

## Check before you push
`sh test/check.sh` — type-checks `main.c` (color **and** B&W), syntax-checks the
JS, and runs the bridge against the fixtures. Not a build; it just catches the
cheap mistakes without a CloudPebble round trip.

## Backend coupling
The feed schema has been renamed under this app once already (2026-06:
`transcripts.zarchstuff.com/api/recent` -> `data.zarchstuff.com/feed/api/*`).
`src/pkjs/index.js` therefore reads every call field through `pick()` with a
list of candidate names rather than one hard-coded name. When the backend
changes, add the new row shape to `test/fixtures.json`, run
`node test/harness.js local --offline`, and extend the `pick()` lists — don't
rewrite the mapping.

## Gotchas
Read the "Hard-won gotchas" section in `README.md` before touching settings,
auth, or the build pipeline — especially `clay.getSettings(e.response, false)`
(the default `convert=true` keys by numeric id and silently drops creds).
