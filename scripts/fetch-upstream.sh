#!/usr/bin/env bash
# Fetch upstream Bruno at the pinned commit (UPSTREAM_COMMIT), install it and
# build the renderer. Bruno Web does not modify upstream; patches/ is applied
# if it ever has to (currently empty).
#   scripts/fetch-upstream.sh [target-dir]   (default: ./upstream)
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
DEST=${1:-$REPO/upstream}
COMMIT=$(tr -d '[:space:]' < "$REPO/UPSTREAM_COMMIT")

if [ ! -d "$DEST/.git" ]; then
  git init -q "$DEST"
  git -C "$DEST" remote add origin https://github.com/usebruno/bruno.git
fi
git -C "$DEST" fetch -q --depth 1 origin "$COMMIT"
git -C "$DEST" checkout -q --force "$COMMIT"

if compgen -G "$REPO/patches/*.patch" > /dev/null; then
  for p in "$REPO"/patches/*.patch; do git -C "$DEST" apply "$p"; done
fi

cd "$DEST"
# The Electron and Playwright browser binaries are not needed to run in Node.
export ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm run setup
npm run build:web

BRUNO_WEB_UPSTREAM="$DEST" node "$REPO/scripts/extract-channels.js"
echo "upstream $COMMIT ready in $DEST"
