#!/usr/bin/env bash
# Sync this repo (local wins) into https://github.com/liwuaa/AITemp Exp-vocat/
# Usage (from repo root, Git Bash):
#   ./scripts/sync_to_aitemp.sh
#   git sync-aitemp

set -euo pipefail

REPO_URL="https://github.com/liwuaa/AITemp.git"
REMOTE_PREFIX="Exp-vocat"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${TEMP:-/tmp}/AITemp-sync"

echo "Source : $SRC"
echo "Target : $REPO_URL/$REMOTE_PREFIX (local wins)"

if [[ -d "$WORK/.git" ]]; then
  git -C "$WORK" fetch origin
  git -C "$WORK" checkout main
  git -C "$WORK" reset --hard origin/main
else
  rm -rf "$WORK"
  git clone "$REPO_URL" "$WORK"
fi

DST="$WORK/$REMOTE_PREFIX"
rm -rf "$DST"
mkdir -p "$DST"

# Prefer robocopy on Windows Git Bash; fall back to rsync/cp.
if command -v robocopy >/dev/null 2>&1; then
  robocopy "$SRC" "$DST" /E \
    /XD .git build managed_components .vscode .devcontainer .cache releases tmp \
    /XF sdkconfig sdkconfig.old dependencies.lock .env \
    /NFL /NDL /NJH /NJS /nc /ns /np || [[ $? -lt 8 ]]
elif command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude .git --exclude build --exclude managed_components \
    --exclude .vscode --exclude .devcontainer --exclude .cache \
    --exclude releases --exclude tmp \
    --exclude sdkconfig --exclude sdkconfig.old \
    --exclude dependencies.lock --exclude .env \
    "$SRC"/ "$DST"/
else
  echo "Need robocopy or rsync" >&2
  exit 1
fi

cd "$WORK"
git add -- "$REMOTE_PREFIX"
if git diff --cached --quiet -- "$REMOTE_PREFIX"; then
  echo "Already up to date with GitHub."
  exit 0
fi

stamp="$(date '+%Y-%m-%d %H:%M:%S')"
git commit --no-verify -m "Sync Exp-vocat from local ($stamp)"

# This environment often needs local proxy + HTTP/1.1 for GitHub.
if ! git -c http.proxy=http://127.0.0.1:10809 -c https.proxy=http://127.0.0.1:10809 -c http.version=HTTP/1.1 push origin main; then
  git push origin main
fi
echo "Pushed to $REPO_URL ($REMOTE_PREFIX)."
