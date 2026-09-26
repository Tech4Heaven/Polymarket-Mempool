#!/usr/bin/env bash
#
# start-buy-ui.sh — start the BTC Manual Buy web UI under PM2 (separate from the copy bot).
#
# Loads `.env` into the shell so BUY_UI_* overrides apply, then starts/reloads only `buy-ui`.
# The process also reads `.env` via dotenv for wallet/funder/CLOB settings.
#
# Usage:  ./start-buy-ui.sh
# URL:    http://127.0.0.1:3847  (or BUY_UI_HOST / BUY_UI_PORT)

set -euo pipefail

cd "$(dirname "$0")"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Free the port only if something non-pm2 is holding it (optional cleanup of old manual runs).
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${BUY_UI_PORT:-3847}/tcp" 2>/dev/null || true
  sleep 1
fi

if pm2 describe buy-ui >/dev/null 2>&1; then
  pm2 restart buy-ui --update-env
else
  pm2 start ecosystem.config.cjs --only buy-ui --update-env
fi

pm2 save

echo
echo "buy-ui online (alongside copy bot — separate PM2 process)."
echo "URL:     http://${BUY_UI_HOST:-127.0.0.1}:${BUY_UI_PORT:-3847}"
echo "Logs:    pm2 logs buy-ui --lines 30"
echo "Stop:    pm2 stop buy-ui"
echo "Restart: pm2 restart buy-ui"
