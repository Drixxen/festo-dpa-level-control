#!/usr/bin/env bash
# Wird von systemd gestartet – läuft im Vordergrund (kein &-wait nötig)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/.run-logs"
mkdir -p "$LOG_DIR"

PYTHON="$ROOT/venv/bin/python3"
NODE_BIN="$(which npm)"

cleanup() {
    kill "$API_PID" "$FRONTEND_PID" 2>/dev/null || true
    wait "$API_PID" "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup EXIT TERM INT

"$PYTHON" "$ROOT/api_server.py" --host 0.0.0.0 >"$LOG_DIR/api.log" 2>&1 &
API_PID="$!"

"$NODE_BIN" --prefix "$ROOT/frontend" run start -- --hostname 0.0.0.0 --port 3000 >"$LOG_DIR/frontend.log" 2>&1 &
FRONTEND_PID="$!"

echo "API PID=$API_PID  Frontend PID=$FRONTEND_PID"
wait "$API_PID" "$FRONTEND_PID"
