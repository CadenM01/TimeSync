#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${HOME}/TimeSync"
APP_FILE="app.py"
VENV_DIR="${APP_DIR}/.venv"
PY="${VENV_DIR}/bin/python"
LOG_FILE="${APP_DIR}/log.txt"

cd "$APP_DIR"

# Keep remote in sync with GitHub main.
git fetch origin main
git checkout main
git pull --ff-only origin main

# Ensure virtualenv and dependencies.
if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi

"$PY" -m pip install --upgrade pip
"$PY" -m pip install -r requirements.txt

# Load runtime environment variables if present.
if [ -f ".env" ]; then
  set -a
  . "$APP_DIR/.env"
  set +a
fi

export FLASK_ENV=production
export FLASK_DEBUG=0
export PORT="${PORT:-8080}"

# Replace previous app process.
pkill -f "$PY $APP_FILE" || true

# Start detached process and append logs.
nohup "$PY" "$APP_FILE" >> "$LOG_FILE" 2>&1 &

echo "TimeSync started on port ${PORT}."
echo "Logs: $LOG_FILE"
tail -n 50 "$LOG_FILE" || true
