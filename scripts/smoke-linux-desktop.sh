#!/usr/bin/env bash
set -euo pipefail

# The package has already been installed on a native Linux runner. A successful
# bundle build alone cannot show whether the installed GUI actually starts.
export WEBKIT_DISABLE_COMPOSITING_MODE=1
runtime_log="${RUNNER_TEMP:-/tmp}/braavolabs-linux-smoke.log"
/usr/bin/braavolabs-desktop >"$runtime_log" 2>&1 &
app_pid=$!
trap 'kill "$app_pid" 2>/dev/null || true; wait "$app_pid" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  window_id=$(xdotool search --name '^Braavolabs' 2>/dev/null | head -n 1 || true)
  if [[ -n "$window_id" ]]; then
    echo "Native Linux window opened: $(xdotool getwindowname "$window_id")"
    exit 0
  fi

  if ! kill -0 "$app_pid" 2>/dev/null; then
    echo 'Braavolabs exited before its window appeared.' >&2
    tail -n 40 "$runtime_log" >&2
    exit 1
  fi
  sleep 1
done

echo 'Braavolabs remained running but opened no matching window in 30 seconds.' >&2
tail -n 40 "$runtime_log" >&2
exit 1
