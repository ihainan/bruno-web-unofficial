# Bruno Web: notes for coding agents

Bruno Web runs the unmodified Bruno desktop app's main process on Node behind a stand-in `electron` module, and serves
Bruno's renderer to the browser with a WebSocket `ipcRenderer`. See README.md, and docs/DESIGN.md (Chinese) for the
design and its trade-offs.

## Ground rules

- **Never modify `upstream/`.** It is a pinned, unmodified checkout of usebruno/bruno (gitignored). Adapt Bruno Web
  (`server/`, `web/`, `test/`, `scripts/`) instead. If something truly cannot be done without changing upstream,
  stop and say so; `patches/` exists for that case but is empty on purpose.
- Upstream is pinned by `UPSTREAM_COMMIT`. After changing it run `scripts/fetch-upstream.sh`, which also regenerates
  `web/channels.json` (commit that file with the bump).
- Do not commit `data/`, `gate-results/`, test output, or anything from a user's collections.
- Commit messages in English; no AI attribution lines.

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
| `npx playwright test -c test/e2e/playwright.config.js` | Bruno Web's own flows (dialogs, reconnect, takeover, OAuth2, policies, phones) |
| `scripts/upstream-e2e.sh` + `scripts/compare-upstream-results.js` | upstream's whole suite against `test/upstream-e2e/known-failures.txt` |
| `scripts/upstream-gate.sh [out]` | all of the above, as the upgrade gate |

A test failure is fixed in Bruno Web, not by weakening the test. Add to `known-failures.txt` only for a real,
documented difference between a browser and Electron, with the reason on the same line.

## Where things are

- `server/electron-shim/` the stand-in `electron` module; unimplemented APIs are recorded and reported by selfcheck.
- `server/session.js`, `web/bridge.js`, `web/codec.js` the IPC transport (WebSocket, reconnect, takeover).
- `server/fs-api.js`, `web/dialogs.js` server-side file dialogs, uploads, downloads.
- `web/mobile.css`, `web/mobile.js` touch-screen layout; they select on upstream class names.
- `test/upstream-e2e/` the adapter that runs upstream's Playwright suite against Bruno Web.
- `scripts/auto-update/` the weekly upstream upgrade job.
