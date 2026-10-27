#!/usr/bin/env bash
# Reload the running host's copy of this plugin, then prove it reloaded.
#
# Why this exists: the harness reloads a bundle when cordis.patch.yml *changes
# content*. A plain `touch` (mtime only) does NOT trigger it, so an edit can look
# like it was applied while the host keeps executing the previous module graph —
# every API response then comes from stale code and the failure looks like a logic
# bug. This script forces a real content change and asserts the build stamp the
# host reports, so "it still fails" can never be confused with "it never ran".
#
# Usage: scripts/reload.sh [expected-build] [port]
set -u

EXPECTED="${1:-}"
PORT="${2:-${DSH_PORT:-60642}}"
PATCH="$HOME/.dsh/profiles/desktop/cordis.patch.yml"
STORE="$HOME/.dsh/archived-digest"

if [ ! -f "$PATCH" ]; then
  echo "reload: patch file not found at $PATCH" >&2
  exit 1
fi

# A unique comment line, not a touch: the watcher compares content.
cp "$PATCH" "$PATCH.reload-bak"
# Restore on any exit path, including Ctrl-C — leaving the probe line behind
# would make the next reload try to re-apply a file the user never edited.
restore() { [ -f "$PATCH.reload-bak" ] && mv "$PATCH.reload-bak" "$PATCH"; }
trap restore EXIT INT TERM
printf '\n# reload probe %s %s\n' "$(date +%s)" "$$" >> "$PATCH"

# Poll for the EXPECTED build while the probe line is still in place. Restoring
# the file immediately would hand the (debounced) watcher the original content
# again and cancel the very reload we are waiting for.
build=""
for _ in $(seq 1 40); do
  sleep 1
  status=$(curl -s --max-time 5 "http://127.0.0.1:$PORT/api/dsh-archived-digest/status" 2>/dev/null || true)
  [ -z "$status" ] && continue
  build=$(printf '%s' "$status" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.build??'undefined'));}catch{process.stdout.write('unreachable');}});" 2>/dev/null)
  if [ -z "$EXPECTED" ] || [ "$build" = "$EXPECTED" ]; then break; fi
done

restore
trap - EXIT INT TERM
# Give the restore its own debounce window so it cannot race the next run.
sleep 3

echo "reload: host reports build=$build (store: $STORE)"
if [ -n "$EXPECTED" ]; then
  if [ "$build" = "$EXPECTED" ]; then
    echo "reload: OK"
    exit 0
  fi
  echo "reload: MISMATCH — expected build=$EXPECTED, host is running $build" >&2
  echo "reload: the host did NOT pick up the edit; do not trust API results." >&2
  exit 2
fi
