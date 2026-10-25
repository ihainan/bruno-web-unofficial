#!/usr/bin/env bash
# Run upstream Bruno's Playwright e2e suite against Bruno Web.
#   scripts/upstream-e2e.sh [playwright test args...]   e.g. tests/request --project=default
# Builds a run directory with a copy of upstream's tests and fixtures, where
# only playwright/index.ts is replaced (test/upstream-e2e/index.ts).
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
UPSTREAM=${BRUNO_WEB_UPSTREAM:-$REPO/upstream}
RUN=${BRUNO_WEB_E2E_DIR:-$HOME/tmp/bruno-web-e2e}

rm -rf "$RUN"
mkdir -p "$RUN/playwright"
cp -r "$UPSTREAM/tests" "$RUN/tests"
cp "$UPSTREAM/playwright/index.ts" "$RUN/playwright/upstream-index.ts"
cp "$REPO/test/upstream-e2e/index.ts" "$REPO/test/upstream-e2e/web-electron.ts" "$RUN/playwright/"
cp "$REPO/test/upstream-e2e/playwright.config.ts" "$RUN/"
ln -s "$UPSTREAM/packages" "$RUN/packages"
ln -s "$UPSTREAM/node_modules" "$RUN/node_modules"
[ -f "$UPSTREAM/tsconfig.json" ] && cp "$UPSTREAM/tsconfig.json" "$RUN/"

# Some specs restore committed fixtures with `git checkout`.
git -C "$RUN" init -q && git -C "$RUN" add tests >/dev/null && git -C "$RUN" -c user.name=e2e -c user.email=e2e@localhost commit -qm fixtures

cd "$RUN"
export BRUNO_WEB_REPO="$REPO" BRUNO_WEB_UPSTREAM="$UPSTREAM"
export NODE_OPTIONS="${NODE_OPTIONS:-} --require=$REPO/test/upstream-e2e/electron-path-stub.js"
exec "$UPSTREAM/node_modules/.bin/playwright" test "$@"
