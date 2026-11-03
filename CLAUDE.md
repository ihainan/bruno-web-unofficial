# Bruno Web: notes for coding agents

Bruno Web runs the unmodified Bruno desktop app's main process on Node behind a stand-in `electron` module, and serves
Bruno's renderer to the browser with a WebSocket `ipcRenderer`. See README.md, and docs/DESIGN.md (Chinese) for the
design and its trade-offs.

## Ground rules

- **Never edit `upstream/` by hand.** It is a pinned checkout of usebruno/bruno (gitignored) that
  `scripts/fetch-upstream.sh` re-creates: it checks out `UPSTREAM_COMMIT`, applies `patches/*.patch`, copies `phone/`
  to `packages/bruno-app/src/bruno-web-phone` and builds. Adapt Bruno Web (`server/`, `web/`, `phone/`, `test/`,
  `scripts/`) instead. Upstream changes go only through `patches/`, under the rules in "Patches" below.
- Upstream is pinned by `UPSTREAM_COMMIT`. After changing it run `scripts/fetch-upstream.sh`, which also regenerates
  `web/channels.json` (commit that file with the bump).
- Do not commit `data/`, `gate-results/`, test output, or anything from a user's collections.
- Commit messages in English; no AI attribution lines.

## Phone mode and patches

On a phone (coarse pointer, and 760 px wide or 500 px tall at most) the renderer shows phone mode, `phone/index.js`:
a request manager built from upstream's own Redux store, actions and components (collections → request → send →
response, editing with upstream's request pane). `patches/0001-phone-mode.patch` renders it from
`pages/Bruno/index.js`; anywhere else the app is upstream's. Phone mode has a button to the full interface, where
`web/mobile.css` and `web/mobile.js` adapt upstream's layout to touch screens.

Patches:

- A patch only hooks Bruno Web code in (the feature lives in `phone/` or `web/`), touches few lines (aim: under 30
  per patch), and only files upstream rarely changes (`pages/Bruno/index.js` changed once in 90 days; the sidebar
  50 times: never patch that kind of file).
- A patch changes nothing outside phone mode, so upstream's own e2e suite (desktop viewport) still tests upstream's
  behaviour, and the gate builds its baseline without patches (`BRUNO_WEB_PLAIN=1`).
- When a patch no longer applies, `fetch-upstream.sh` fails and leaves `upstream/` checked out at the new commit,
  without that patch and unbuilt. Fix it there: `git -C upstream apply --3way ../patches/<file>` (or `--reject`
  and edit), check the result keeps the rules above, `git -C upstream diff -- <patched files> > patches/<file>`,
  then run `scripts/fetch-upstream.sh` again.
- `phone/` imports upstream internals (`providers/ReduxStore/...`, `components/...`). A moved module fails the build,
  but a renamed action argument, prop or store field does not; the phone tests in `test/e2e/web.spec.js` ("on a
  phone", run on Chromium and WebKit) are what catches that, so keep them covering every action phone mode uses.

## Running tests safely (this has crashed a 31 GB machine before)

Each upstream e2e worker starts a ~260 MB server plus a browser, about 1.5 GB in total.

- Run heavy suites through `scripts/run-guarded.sh <log> <command...>`; it stops the process group when free memory
  drops below `MIN_MB` (3 GB).
- `E2E_WORKERS=3` at most for a full suite. Never run the upstream suite and the Bruno Web suite at the same time.
- Stop processes only by the exact PID you started. Never `pkill`/`killall` by pattern: other people's sessions run
  on the same machine.
- Single upstream spec files are fine for iterating:
  `E2E_WORKERS=1 scripts/run-guarded.sh /tmp/x.log scripts/upstream-e2e.sh tests/<path>.spec.ts`
  (set `BRUNO_WEB_E2E_DIR` to a directory of your own when another run may be going on).

## Checks, cheapest first

| Command | What it proves |
| --- | --- |
| `npm test` | unit tests |
| `scripts/check-upstream-selectors.js` | every upstream class / test id our CSS and JS select on still exists |
| `/bruno-web/selfcheck` on a running server | every renderer channel has a handler, no unimplemented Electron API was touched, sandbox and HTTP work |
| `npx playwright test -c test/e2e/playwright.config.js` | Bruno Web's own flows (dialogs, reconnect, takeover, OAuth2, policies, phones); the phone tests also run on WebKit, the engine of every iPhone browser |
| `scripts/upstream-e2e.sh` + `scripts/compare-upstream-results.js` | upstream's whole suite against `test/upstream-e2e/known-failures.txt` |
| `scripts/upstream-gate.sh [out]` | all of the above, as the upgrade gate |

A test failure is fixed in Bruno Web, not by weakening the test. Add to `known-failures.txt` only for a real,
documented difference between a browser and Electron, with the reason on the same line.

WebKit needs system libraries that `npx playwright install --with-deps webkit` installs with root. Without root,
`apt-get download` the packages Playwright reports missing, unpack them with `dpkg-deb -x`, and copy the `.so` files
into `<playwright cache>/webkit-<rev>/minibrowser-wpe/sys/lib` (its launcher resets `LD_LIBRARY_PATH`, so setting it
does not help). A Playwright upgrade brings a new `webkit-<rev>` that needs the same.

## Where things are

- `server/electron-shim/` the stand-in `electron` module; unimplemented APIs are recorded and reported by selfcheck.
- `server/session.js`, `web/bridge.js`, `web/codec.js` the IPC transport (WebSocket, reconnect, takeover).
- `server/fs-api.js`, `web/dialogs.js` server-side file dialogs, uploads, downloads.
- `phone/` phone mode (see above); `patches/` its hook into upstream.
- `web/mobile.css`, `web/mobile.js` upstream's full interface on touch screens; they select on upstream class names.
- `test/upstream-e2e/` the adapter that runs upstream's Playwright suite against Bruno Web.
- `scripts/auto-update/` the weekly upstream upgrade job.
