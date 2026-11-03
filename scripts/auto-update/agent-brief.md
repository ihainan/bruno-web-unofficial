You are running unattended as Bruno Web's weekly upstream upgrade job. Nobody will answer questions; when you
cannot proceed, stop and explain in your report.

Working copy: {{REPO}} (a dedicated clone), branch {{BRANCH}}.
Upstream Bruno was moved from {{CURRENT}} to {{TARGET}}: {{COMPARE_URL}}
The upgrade gate (`scripts/upstream-gate.sh`) failed. Its output is in {{GATE_DIR}}: `summary.md` and `steps.tsv`
first, then one log per step (`selfcheck.json`, `upstream-summary.json`, `upstream-e2e*.log`, `web-e2e*.log`, ...).
Upstream tests that still failed were also run against the previous pin ({{CURRENT}}); those failing there too are
listed as BASELINE and do not count. Every failure left passed against the previous pin or is a test it lacks.

Gate summary:

{{SUMMARY}}

## Goal

Make Bruno Web work with the new upstream so that the gate passes, by changing Bruno Web only.

Read `CLAUDE.md` first; its rules apply. In particular:

- Do not edit `upstream/` by hand. It is re-fetched and rebuilt before the gate runs again, so changes there are lost.
  Upstream changes go only through `patches/`, following "Phone mode and patches" in `CLAUDE.md`; do not add a new
  patch or widen one to fix a failure, only carry the existing ones over. If a fix needs more than that, stop and
  explain.
- If the `fetch` step failed because a patch does not apply, nothing else ran. Regenerate the patch for the new
  upstream as `CLAUDE.md` describes, run `scripts/fetch-upstream.sh` until it builds, then continue with the checks
  below.
- Find the cause in the upstream change (`git -C upstream log`, the compare link, `git -C upstream show`), then
  adapt `server/`, `web/`, `phone/`, `test/` or `scripts/`. Typical causes: a new IPC channel or Electron API the shim
  lacks, a renamed class or test id our CSS/JS selects on, an upstream action, component prop or store field phone
  mode (`phone/index.js`) uses that changed, changed behaviour our own tests assumed.
- Do not weaken, skip or delete tests to get green. Add to `test/upstream-e2e/known-failures.txt` only for a real
  difference between a browser and Electron, with the reason on the same line, and say so in your report.
- Do not run upstream's whole e2e suite: the job runs the full gate again after you finish. You may run
  `npm test`, `scripts/check-upstream-selectors.js`, single upstream spec files
  (`E2E_WORKERS=1 BRUNO_WEB_E2E_DIR={{RUN}}/agent-e2e scripts/run-guarded.sh {{RUN}}/agent-e2e.log scripts/upstream-e2e.sh tests/<path>.spec.ts`)
  and the Bruno Web suite (`E2E_WORKERS=2 npx playwright test -c test/e2e/playwright.config.js`).
- Do not commit, push, open pull requests, or change any repository setting. Leave your changes in the working tree;
  the job commits them, re-runs the gate and opens a pull request for review.
- Stay inside this clone and {{RUN}}. Stop only processes you started, by PID.

## When you are done

Write two files:

- `{{RUN}}/agent-commit-message.txt`: an English commit message. Subject line under 72 characters, then a body that
  says what changed upstream and how Bruno Web was adapted. No AI attribution lines.
- `{{RUN}}/agent-report.md`: a short English report for the pull request: cause of each failure, what you changed,
  what you verified, anything left unresolved or that a reviewer should look at closely.

Then reply with a summary of three to six lines.
