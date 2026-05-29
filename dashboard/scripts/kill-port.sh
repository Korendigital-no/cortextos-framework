#!/usr/bin/env bash
# Pre-start cleanup: kill any process holding the target port.
# Runs automatically via the predev npm hook so PM2 restarts don't crash-loop
# on orphaned next-server children that survived the last shutdown.
set -uo pipefail

PORT="${PORT:-3000}"

# Find PIDs listening on the port (TCP)
# -t: only PIDs, -i:<port>: filter, -sTCP:LISTEN: only listeners (avoids killing curl/http clients)
PIDS=$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)

if [ -z "$PIDS" ]; then
  echo "[kill-port] Port $PORT is free."
  exit 0
fi

# Filter out our own PID and our parent (the npm process running this hook)
# so we don't accidentally kill ourselves on a race.
OWN_PID=$$
PARENT_PID=$PPID

SAFE_TO_KILL=""
for pid in $PIDS; do
  if [ "$pid" = "$OWN_PID" ] || [ "$pid" = "$PARENT_PID" ]; then
    continue
  fi
  # Only kill node/next processes — refuse to kill arbitrary listeners
  # (postgres, redis, another dev server, etc.) that happen to be on this port.
  CMD=$(ps -o comm= -p "$pid" 2>/dev/null || true)
  case "$CMD" in
    *node*|*next*)
      SAFE_TO_KILL="$SAFE_TO_KILL $pid"
      ;;
    *)
      echo "[kill-port] Refusing to kill non-node process on port $PORT: pid=$pid comm=$CMD" >&2
      ;;
  esac
done

if [ -z "$SAFE_TO_KILL" ]; then
  echo "[kill-port] Port $PORT held only by self/parent — nothing to clean up."
  exit 0
fi

echo "[kill-port] Killing orphaned process(es) on port $PORT:$SAFE_TO_KILL"
for pid in $SAFE_TO_KILL; do
  kill "$pid" 2>/dev/null || true
done

# Give them 2 seconds to exit cleanly, then SIGKILL anyone left.
sleep 2
STILL_ALIVE=""
for pid in $SAFE_TO_KILL; do
  if kill -0 "$pid" 2>/dev/null; then
    STILL_ALIVE="$STILL_ALIVE $pid"
  fi
done

if [ -n "$STILL_ALIVE" ]; then
  echo "[kill-port] Force-killing stubborn process(es):$STILL_ALIVE"
  for pid in $STILL_ALIVE; do
    kill -9 "$pid" 2>/dev/null || true
  done
fi

# Final check
sleep 1
if lsof -ti tcp:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[kill-port] WARNING: port $PORT is still held after cleanup. Continuing anyway." >&2
else
  echo "[kill-port] Port $PORT is now free."
fi
