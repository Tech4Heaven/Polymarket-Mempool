#!/usr/bin/env bash
#
# start-bot.sh — start the copy bot under PM2 with an interactively-entered passphrase.
#
# The passphrase is read with `read -s` (hidden input, no shell-history entry), exported
# into the environment only for the duration of `pm2 start`, then unset. PM2's daemon
# captures it for the bot process so crash-restarts work without re-prompting. It is
# never written to any file.
#
# Usage:  ./start-bot.sh

set -euo pipefail

read -srp "Wallet passphrase: " COPY_WALLET_KEY_PASSPHRASE
echo

if [[ -z "$COPY_WALLET_KEY_PASSPHRASE" ]]; then
  echo "Empty passphrase; aborting."
  exit 1
fi

export COPY_WALLET_KEY_PASSPHRASE

# --update-env forces PM2 to refresh the cached env for this app from the current shell
# (without it, PM2 silently reuses a previous run's env if it had one).
pm2 start ecosystem.config.cjs --update-env

unset COPY_WALLET_KEY_PASSPHRASE

echo
echo "Started."
echo "Logs:    pm2 logs bot --lines 30"
echo "Stop:    pm2 stop bot"
echo "Restart: pm2 restart bot   (reuses cached passphrase)"
