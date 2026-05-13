#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/.run-logs"
mkdir -p "$LOG_DIR"
"$ROOT/stop_dashboard.sh"

python3 "$ROOT/api_server.py" >"$LOG_DIR/api.log" 2>&1 &
API_PID="$!"

npm --prefix "$ROOT/frontend" run dev -- --hostname 0.0.0.0 --webpack >"$LOG_DIR/frontend.log" 2>&1 &
FRONTEND_PID="$!"

PI_IP="$(hostname -I | awk '{print $1}')"
echo "API gestartet:      http://$PI_IP:8080  pid=$API_PID"
echo "Dashboard gestartet: http://$PI_IP:3000  pid=$FRONTEND_PID"
echo "Logs: $LOG_DIR/api.log und $LOG_DIR/frontend.log"
