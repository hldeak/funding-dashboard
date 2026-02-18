# HLDesk — Funding Rate Dashboard

Real-time funding rate comparison across Hyperliquid, Binance, Bybit, and OKX. Surface arb opportunities, set alerts, and backtest funding strategies.

## Features

- 📊 Live funding rates across 4 exchanges, normalized to 8h-equivalent
- 🎯 Spread highlighting — biggest arb opportunities at a glance
- 🔔 Telegram alerts when rates cross your threshold
- 📈 Historical charts (Pro)
- 🧪 Backtesting engine — test strategies on historical data (Pro)
- 📝 Paper trading — run strategies with simulated capital (Pro)

## Stack

- **Backend:** Bun + Hono
- **Frontend:** Next.js
- **Cache:** Upstash Redis
- **Database:** Supabase (Postgres)
- **Hosting:** Fly.io (backend) + Vercel (frontend)
- **Payments:** Stripe

## Development

```bash
# Install dependencies
bun install

# Run backend
cd apps/api && bun dev

# Run frontend
cd apps/web && bun dev
```

## Structure

```
apps/
  api/          # Bun + Hono backend
  web/          # Next.js frontend
packages/
  shared/       # Shared types and utilities
docs/
  spec.md       # Full technical spec
```

## Pricing

| Tier | Price | Features |
|------|-------|---------|
| Free | $0 | 30s refresh, top 20 assets, 1 alert |
| Pro | $15/mo | 5s refresh, all assets, unlimited alerts, backtesting, paper trading |
| API | $49/mo | REST API, 1s refresh, webhooks |

---

*Built by [HLDesk](https://github.com/hldeak)*
