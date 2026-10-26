#!/usr/bin/env bash
# Run a command in its own process group and stop the whole group if the
# machine runs low on memory (each upstream e2e worker can take ~1.5 GB).
#   scripts/run-guarded.sh <log file> <command...>     MIN_MB (default 3072)
# Exit status is the command's, or 137 when the guard stopped it.
LOG=$1; shift
MIN_MB=${MIN_MB:-3072}
setsid "$@" > "$LOG" 2>&1 &
PID=$!
STOPPED=0
while kill -0 "$PID" 2>/dev/null; do
  AVAIL=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  if [ "$AVAIL" -lt "$MIN_MB" ]; then
    echo "[guard] MemAvailable ${AVAIL}MB < ${MIN_MB}MB, stopping process group $PID" >> "$LOG"
    kill -TERM -- "-$PID"; sleep 10; kill -KILL -- "-$PID" 2>/dev/null
    STOPPED=1
    break
  fi
  sleep 5
done
wait "$PID"; CODE=$?
[ "$STOPPED" = 1 ] && CODE=137
echo "EXIT=$CODE" >> "$LOG"
exit "$CODE"
