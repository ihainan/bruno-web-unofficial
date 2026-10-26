#!/usr/bin/env bash
# Every check an upstream upgrade has to pass, in one command.
#
#   scripts/upstream-gate.sh [out-dir]
#
# Tests the checkout as it is (UPSTREAM_COMMIT, server/, web/, test/):
#   fetch     fetch and build upstream at UPSTREAM_COMMIT
#   unit      npm test
#   selectors upstream class names / test ids our CSS and JS rely on still exist
#   selfcheck start a server and require /bruno-web/selfcheck to answer 200
#             (IPC channel coverage, unimplemented Electron APIs, sandbox, HTTP)
#   web-e2e   Bruno Web's own Playwright suite
#   upstream  upstream's whole e2e suite; files with unexpected failures are run
#             once more, then judged against test/upstream-e2e/known-failures.txt.
#             With GATE_BASELINE_COMMIT, files still failing are also run against
#             that (previously pinned) upstream; a test that does not pass there
#             either was not broken by the upgrade and does not fail the gate.
#
# Writes <out-dir>/summary.md, steps.tsv and one log per step; exits non-zero if
# any step failed. Heavy steps run under scripts/run-guarded.sh.
#
# Environment:
#   BRUNO_WEB_UPSTREAM     upstream checkout (default ./upstream)
#   E2E_WORKERS            parallel workers for the e2e suites (default 3)
#   GATE_SKIP_UPSTREAM_E2E 1 skips the upstream suite (quick iteration only)
#   GATE_SKIP_FETCH        1 reuses the upstream checkout as it is
#   GATE_BASELINE_COMMIT   upstream commit to compare remaining failures with
#   GATE_BASELINE_DIR      where to build it (default ./upstream-baseline)
#   GATE_UPSTREAM_ARGS     run only these upstream spec files (testing the gate only)
set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mkdir -p "${1:-$REPO/gate-results}" && cd "${1:-$REPO/gate-results}" && pwd)
export BRUNO_WEB_UPSTREAM=${BRUNO_WEB_UPSTREAM:-$REPO/upstream}
export E2E_WORKERS=${E2E_WORKERS:-3}
GUARD="$REPO/scripts/run-guarded.sh"
cd "$REPO"
: > "$OUT/steps.tsv"
FAILED=0

# step <name> <command...>: run, log to $OUT/<name>.log, record the result.
step() {
  local name=$1; shift
  local start=$SECONDS
  echo "[gate] $name ..."
  "$@" > "$OUT/$name.log" 2>&1
  local code=$?
  printf '%s\t%s\t%ss\n' "$name" "$code" "$((SECONDS - start))" >> "$OUT/steps.tsv"
  if [ "$code" != 0 ]; then FAILED=1; echo "[gate] $name FAILED ($code), see $OUT/$name.log"; fi
  return "$code"
}

selfcheck() {
  local data port pid code
  data=$(mktemp -d)
  port=$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
  HOST=127.0.0.1 PORT=$port BRUNO_WEB_AUTH=none BRUNO_WEB_DATA=$data \
    node --require ./server/install-shim.js server/index.js > "$OUT/selfcheck-server.log" 2>&1 &
  pid=$!
  for _ in $(seq 1 120); do
    curl -sf "http://127.0.0.1:$port/bruno-web/healthz" > /dev/null && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  code=$(curl -s -o "$OUT/selfcheck.json" -w '%{http_code}' "http://127.0.0.1:$port/bruno-web/selfcheck")
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  rm -rf "$data"
  cat "$OUT/selfcheck.json"; echo
  echo "HTTP $code"
  [ "$code" = 200 ]
}

upstream_e2e() {
  local run="$OUT/upstream-run" files base code
  # shellcheck disable=SC2086 # GATE_UPSTREAM_ARGS is a list of spec files
  BRUNO_WEB_E2E_DIR="$run" "$GUARD" "$OUT/upstream-e2e-full.log" scripts/upstream-e2e.sh ${GATE_UPSTREAM_ARGS:-}
  cp "$run/results.json" "$OUT/upstream-results.json" 2>/dev/null || { echo "no results.json from the full run"; return 2; }
  if node scripts/compare-upstream-results.js "$OUT/upstream-results.json" --failed-files "$OUT/upstream-failed-files.txt" > "$OUT/upstream-first-pass.txt"; then
    cat "$OUT/upstream-first-pass.txt"
    node scripts/compare-upstream-results.js "$OUT/upstream-results.json" --json "$OUT/upstream-summary.json" > /dev/null
    return 0
  fi
  # A long run sometimes loses upstream's fixture server (:8081) halfway and
  # whole groups fail together; run the affected files once more on their own.
  mapfile -t files < "$OUT/upstream-failed-files.txt"
  echo "rerunning ${#files[@]} file(s) with unexpected failures"
  BRUNO_WEB_E2E_DIR="$run" E2E_WORKERS=2 "$GUARD" "$OUT/upstream-e2e-rerun.log" scripts/upstream-e2e.sh "${files[@]}"
  cp "$run/results.json" "$OUT/upstream-rerun-results.json" 2>/dev/null || { echo "no results.json from the rerun"; return 2; }
  node scripts/compare-upstream-results.js "$OUT/upstream-results.json" "$OUT/upstream-rerun-results.json" \
    --json "$OUT/upstream-summary.json" --failed-files "$OUT/upstream-failed-files.txt" > "$OUT/upstream-second-pass.txt"
  code=$?
  if [ "$code" != 1 ] || [ -z "${GATE_BASELINE_COMMIT:-}" ]; then
    cat "$OUT/upstream-second-pass.txt"
    return "$code"
  fi
  # Timing-sensitive upstream tests fail on a loaded machine whatever the
  # version. Run what still fails against the previously pinned upstream: only
  # tests that pass there count as broken by the upgrade.
  base=${GATE_BASELINE_DIR:-$REPO/upstream-baseline}
  mapfile -t files < "$OUT/upstream-failed-files.txt"
  echo "running ${#files[@]} file(s) against the baseline upstream $GATE_BASELINE_COMMIT"
  if ! scripts/fetch-upstream.sh "$base" "$GATE_BASELINE_COMMIT" > "$OUT/upstream-baseline-fetch.log" 2>&1; then
    echo "could not build the baseline, see $OUT/upstream-baseline-fetch.log"
    cat "$OUT/upstream-second-pass.txt"
    return 1
  fi
  BRUNO_WEB_UPSTREAM="$base" BRUNO_WEB_E2E_DIR="$run" E2E_WORKERS=2 "$GUARD" "$OUT/upstream-e2e-baseline.log" scripts/upstream-e2e.sh "${files[@]}"
  cp "$run/results.json" "$OUT/upstream-baseline-results.json" 2>/dev/null || { echo "no results.json from the baseline run"; cat "$OUT/upstream-second-pass.txt"; return 2; }
  node scripts/compare-upstream-results.js "$OUT/upstream-results.json" "$OUT/upstream-rerun-results.json" \
    --baseline "$OUT/upstream-baseline-results.json" --json "$OUT/upstream-summary.json"
}

if [ "${GATE_SKIP_FETCH:-0}" = 1 ]; then
  printf 'fetch\tskipped\t0s\n' >> "$OUT/steps.tsv"
else
  step fetch scripts/fetch-upstream.sh "$BRUNO_WEB_UPSTREAM" || { echo "[gate] cannot continue without upstream"; }
fi
if ! grep -q $'^fetch\t[1-9]' "$OUT/steps.tsv"; then
  step deps bash -c 'npm ci --no-audit --no-fund && npx playwright install chromium'
  step unit npm test
  step selectors node scripts/check-upstream-selectors.js
  step selfcheck selfcheck
  step web-e2e "$GUARD" "$OUT/web-e2e-playwright.log" npx playwright test -c test/e2e/playwright.config.js
  if [ "${GATE_SKIP_UPSTREAM_E2E:-0}" = 1 ]; then
    printf 'upstream-e2e\tskipped\t0s\n' >> "$OUT/steps.tsv"
  else
    step upstream-e2e upstream_e2e
  fi
fi

{
  echo "## Upgrade gate"
  echo
  echo "Upstream commit: \`$(tr -d '[:space:]' < UPSTREAM_COMMIT)\`"
  echo
  echo "| Step | Result | Time |"
  echo "| --- | --- | --- |"
  while IFS=$'\t' read -r name code took; do
    case "$code" in 0) r=passed ;; skipped) r=skipped ;; *) r="**failed ($code)**" ;; esac
    echo "| $name | $r | $took |"
  done < "$OUT/steps.tsv"
  if [ -f "$OUT/upstream-e2e.log" ]; then
    echo
    echo '```'
    grep -E '^upstream e2e:|^  (passed|known|fail on|NEW|did not|skipped|FAILED|NOT RUN|BASELINE|flaky|listed)' "$OUT/upstream-e2e.log" | head -60
    echo '```'
  fi
  if [ -f "$OUT/selfcheck.json" ]; then
    echo
    echo "Selfcheck: \`$(head -c 1500 "$OUT/selfcheck.json")\`"
  fi
} > "$OUT/summary.md"
cat "$OUT/summary.md"
exit "$FAILED"
