#!/usr/bin/env bash
# Fetch upstream Bruno at the pinned commit (UPSTREAM_COMMIT), apply
# patches/, copy phone/ into the renderer source, install and build the
# renderer.
#   scripts/fetch-upstream.sh [target-dir] [commit]   (default: ./upstream, UPSTREAM_COMMIT)
# Only the pinned commit regenerates web/channels.json; another commit (the
# upgrade gate's baseline) is just built.
# BRUNO_WEB_PLAIN=1 builds upstream as it is, without patches/ and phone/: the
# gate's baseline is an older commit the current patches may not apply to, and
# the patches change nothing outside phone mode.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
DEST=${1:-$REPO/upstream}
PINNED=$(tr -d '[:space:]' < "$REPO/UPSTREAM_COMMIT")
COMMIT=${2:-$PINNED}
channels() { if [ "$COMMIT" = "$PINNED" ]; then BRUNO_WEB_UPSTREAM="$DEST" node "$REPO/scripts/extract-channels.js"; fi; }

PLAIN=${BRUNO_WEB_PLAIN:-0}
PHONE_DEST="$DEST/packages/bruno-app/src/bruno-web-phone"

# Already fetched and built at this commit, with these patches and this phone/:
# nothing to do. The stamp also records what the checkout then looked like, so
# a hand edit to it or to the copied phone/ forces a rebuild too.
# Delete $DEST/.bruno-web-built to force a rebuild.
STAMP="$DEST/.bruno-web-built"
if [ "$PLAIN" = 1 ]; then
  WANT="$COMMIT plain"
else
  PATCHES=$({ compgen -G "$REPO/patches/*.patch" || true; } | sort | xargs -r cat | sha256sum | cut -c1-16)
  PHONE=$(cd "$REPO" && find phone -type f | sort | xargs -r sha256sum | sha256sum | cut -c1-16)
  WANT="$COMMIT $PATCHES $PHONE"
fi
checkout_state() {
  { git -C "$DEST" diff HEAD; if [ -d "$PHONE_DEST" ]; then (cd "$PHONE_DEST" && find . -type f | sort | xargs -r sha256sum); fi; } 2>/dev/null | sha256sum | cut -c1-16
}
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$WANT $(checkout_state)" ]; then
  channels
  echo "upstream $COMMIT already built in $DEST"
  exit 0
fi
rm -f "$STAMP"

if [ ! -d "$DEST/.git" ]; then
  git init -q "$DEST"
  git -C "$DEST" remote add origin https://github.com/usebruno/bruno.git
fi
git -C "$DEST" fetch -q --depth 1 origin "$COMMIT"
git -C "$DEST" checkout -q --force "$COMMIT"

# Phone mode (phone/) is built as part of the renderer. Replace the directory
# wholesale so files deleted or renamed in phone/ do not linger.
rm -rf "$PHONE_DEST"
if [ "$PLAIN" != 1 ]; then
  for p in "$REPO"/patches/*.patch; do
    [ -e "$p" ] || continue
    git -C "$DEST" apply "$p" || { echo "patch $(basename "$p") does not apply to upstream $COMMIT; see CLAUDE.md, \"Patches\""; exit 1; }
  done
  cp -r "$REPO/phone" "$PHONE_DEST"
fi

cd "$DEST"
# The Electron and Playwright browser binaries are not needed to run in Node.
export ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm run setup
npm run build:web

channels
echo "$WANT $(checkout_state)" > "$STAMP"
echo "upstream $COMMIT ready in $DEST"
