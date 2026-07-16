# Commands Reference

---

## 1. Latency: VPS → Polymarket CLOB API (uncached, real backend)

Run these from your VPS. They hit `/midpoint` which is `cf-cache-status: DYNAMIC` — every request goes through Cloudflare's edge to Polymarket's London backend and back. The number you care about is **`TTFB`** (time-to-first-byte).

### Confirm the endpoint is NOT cached

```bash
curl -sI "https://clob.polymarket.com/midpoint?token_id=21742633143463906290569050155826241533067272736897614950488156847949938836455" \
  | grep -iE "cf-cache-status|cf-ray|cache-control"
```

Expected output:
```
cf-cache-status: DYNAMIC
CF-RAY: ...
```

`DYNAMIC` = no caching, every request reaches the origin. (`HIT` would mean cached and the number would be meaningless.)

### Measure round-trip latency (run 5+ times to get a stable median)

```bash
for i in 1 2 3 4 5; do
  curl -o /dev/null -s -w "TCP=%{time_connect}s TLS=%{time_appconnect}s TTFB=%{time_starttransfer}s total=%{time_total}s\n" \
    "https://clob.polymarket.com/midpoint?token_id=21742633143463906290569050155826241533067272736897614950488156847949938836455"
done
```

### Interpretation

| Region | TCP | TTFB (warm) | Verdict |
|---|---|---|---|
| Dublin / London | ~2–5 ms | **~40–50 ms** | Excellent — co-located with Polymarket origin |
| Frankfurt / Amsterdam | ~5–10 ms | ~60–90 ms | Good |
| US East | ~15–20 ms | ~100–150 ms | OK |
| US West | ~25–40 ms | ~180–220 ms | Slow |
| Asia (SG/Tokyo) | ~10–15 ms | ~180–230 ms | Slow (Cloudflare edge is close but backend round-trip is ~150 ms) |

What "TTFB minus TLS" tells you: that's the **pure backend round-trip** — Cloudflare edge → London origin → back. Anything above ~30 ms means you're paying real distance to the Polymarket backend.

### Other uncached CLOB endpoints (same probe pattern)

Replace the URL above with any of these. All are `cf-cache-status: DYNAMIC`:
```
https://clob.polymarket.com/midpoint?token_id=<id>
https://clob.polymarket.com/book?token_id=<id>
https://clob.polymarket.com/price?token_id=<id>&side=BUY
```

Avoid `/markets` for latency tests — it's `cf-cache-status: HIT` with `max-age=30` and gives falsely fast numbers.

---

## 2. Is the target worth copying?

```bash
# Default: treats dry-run + live posts as executed
npm run analyze-target -- logs/<file>.log

# Dry-run only / live only
npm run analyze-target -- logs/<file>.log --mode dry
npm run analyze-target -- logs/<file>.log --mode live

# Include hypothetical PnL on drift+underbid skips
npm run analyze-target -- logs/<file>.log --include-skips
```

Prints verdict: `COPYABLE` / `MARGINAL` / `AVOID` / `INSUFFICIENT DATA`, plus win rate, return on capital, and capital deployed.

---

## 3. Bot lifecycle (Linux VPS, PM2)

```bash
# Start with interactive passphrase prompt (never written to disk)
./start-bot.sh

# Status & control
pm2 status
pm2 logs bot --lines 100
pm2 restart bot               # picks up code changes after git pull
pm2 stop bot
pm2 delete bot

# Pull updates and apply
git pull && pm2 restart bot
```

---

## 4. Wallet management

```bash
# Validate wallet JSON without printing secrets
npm run check-wallet

# Encrypt a plaintext wallet JSON
npm run encrypt-wallet
```

---

## 5. Sell / flatten positions

Manually liquidate the copy wallet's positions (independent of copy targets). **Preview-first** — without `--execute` it only prints what it would sell.

```bash
# Preview ALL open positions the wallet holds (places nothing)
npm run sell-all

# Actually sell everything, marketable at the best bid
npm run sell-all -- --execute

# Sell an INDIVIDUAL market/position (preview, then add --execute to sell):
npm run sell-all -- --slug btc-updown-5m-1782372900     # by market / event slug (substring)
npm run sell-all -- --market "Bitcoin Up or Down"       # by market title / outcome text (substring)
npm run sell-all -- --token 100313866500070...          # by exact outcome token

# Skip tiny positions (default $0.01)
npm run sell-all -- --min-usd 1
```

Uses the copy wallet (`FUNDER_ADDRESS`, same key/signature as copy trading). Resolved markets (no live book) are **skipped** — redeem those separately. Thin books may only fill the top bid level; re-run to sweep the remainder.

---

## 6. Quick log greps

```bash
# Event type counts in a per-target log
grep -oE "(copy posted|copy skip · [a-z]+|\[DRY RUN\])" logs/<file>.log | sort | uniq -c | sort -rn

# Drift skips with numbers
grep "price drift buy" logs/<file>.log

# Recent disconnect / reconnect cycles
grep -E "websocket (close|error)|reconnected" logs/pm2-out.log | tail -50

# Heartbeat-detected zombie connections
grep "heartbeat timeout" logs/pm2-out.log
```

---

## 7. Polymarket API lookups (replace `0x...` with target address)

```bash
curl -s "https://lb-api.polymarket.com/profit?window=all&address=0x..." | jq
curl -s "https://lb-api.polymarket.com/volume?window=all&address=0x..." | jq
curl -s "https://data-api.polymarket.com/positions?user=0x..." | jq
curl -s "https://data-api.polymarket.com/trades?user=0x...&limit=50" | jq
curl -s "https://gamma-api.polymarket.com/public-profile?address=0x..." | jq
```
