#!/usr/bin/env bash
set -euo pipefail

stop_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti "tcp:$port" || true)"
  if [[ -z "$pids" ]]; then
    echo "Port $port ist frei."
    return
  fi

  echo "Stoppe Port $port: $pids"
  kill $pids 2>/dev/null || true
  sleep 0.6

  pids="$(lsof -ti "tcp:$port" || true)"
  if [[ -n "$pids" ]]; then
    echo "Erzwinge Stop auf Port $port: $pids"
    kill -9 $pids 2>/dev/null || true
  fi
}

curl -s -X POST "http://127.0.0.1:8080/api/stop" \
  -H "Content-Type: application/json" \
  -d "{}" >/dev/null 2>&1 || true

stop_port 8080
stop_port 3000

echo "Dashboard/API gestoppt."
