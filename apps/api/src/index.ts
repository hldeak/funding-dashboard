import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCachedRates, getCacheAge, getLastFetchTime, getAssetCount, updateCache } from './cache'
import { aggregateRates } from './aggregator'
import { saveSnapshot } from './db'
import { getHistory } from './db'
import { runPaperTradingCycle } from './paper-trading'
import { getPaperClient } from './paper-routes'
import { runAiTraderCycle } from './ai-trading'

const app = new Hono()

app.use('*', cors())

app.get('/', (c) => c.json({ status: 'ok', service: 'hldesk-api' }))

app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    lastFetch: getLastFetchTime(),
    assetCount: getAssetCount(),
    cacheAge: getCacheAge(),
  })
})

// History must be before :asset to avoid route conflict
app.get('/api/funding/history', async (c) => {
  const asset = c.req.query('asset')
  const exchange = c.req.query('exchange')
  const from = Number(c.req.query('from') || 0)
  const to = Number(c.req.query('to') || Date.now())
  if (!asset || !exchange) {
    return c.json({ error: 'asset and exchange query params required' }, 400)
  }
  const data = await getHistory(asset, exchange, from, to)
  return c.json(data)
})

app.get('/api/funding/:asset', async (c) => {
  const asset = c.req.param('asset').toUpperCase()
  const result = await getCachedRates()
  const spread = result.spreads.find((s) => s.asset === asset)
  if (!spread) return c.json({ error: 'Asset not found' }, 404)
  return c.json(spread)
})

app.get('/api/funding', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') || 20), 1), 100)
  const result = await getCachedRates()
  return c.json(result.spreads.slice(0, limit))
})

// Paper trading routes
app.get('/api/paper/portfolios', async (c) => {
  const db = await getPaperClient()
  if (!db) return c.json({ error: 'DB not configured' }, 500)

  const { data: portfolios, error } = await db.from('paper_portfolios').select('*')
  if (error) return c.json({ error: error.message }, 500)

  const results = await Promise.all((portfolios ?? []).map(async (p: any) => {
    const { data: positions } = await db.from('paper_positions').select('size_usd').eq('portfolio_id', p.id).eq('is_open', true)
    const { data: fundingTxns } = await db.from('paper_transactions').select('amount').eq('portfolio_id', p.id).eq('type', 'funding')

    const positionValue = (positions ?? []).reduce((s: number, pos: any) => s + pos.size_usd, 0)
    const totalFunding = (fundingTxns ?? []).reduce((s: number, t: any) => s + t.amount, 0)
    const totalValue = p.cash_balance + positionValue
    const totalPnl = totalValue - p.initial_balance
    const daysRunning = Math.max(1, Math.floor((Date.now() - new Date(p.created_at).getTime()) / 86400000))

    return {
      ...p,
      total_value: totalValue,
      total_pnl: totalPnl,
      pnl_pct: (totalPnl / p.initial_balance) * 100,
      open_positions_count: (positions ?? []).length,
      total_funding_collected: totalFunding,
      days_running: daysRunning,
    }
  }))

  return c.json(results)
})

app.get('/api/paper/leaderboard', async (c) => {
  const db = await getPaperClient()
  if (!db) return c.json({ error: 'DB not configured' }, 500)

  const { data: portfolios } = await db.from('paper_portfolios').select('*')
  const results = await Promise.all((portfolios ?? []).map(async (p: any) => {
    const { data: positions } = await db.from('paper_positions').select('size_usd').eq('portfolio_id', p.id).eq('is_open', true)
    const positionValue = (positions ?? []).reduce((s: number, pos: any) => s + pos.size_usd, 0)
    const totalValue = p.cash_balance + positionValue
    const totalPnl = totalValue - p.initial_balance
    return {
      id: p.id,
      strategy_name: p.strategy_name,
      description: p.description,
      total_value: totalValue,
      total_pnl: totalPnl,
      pnl_pct: (totalPnl / p.initial_balance) * 100,
      open_positions_count: (positions ?? []).length,
      days_running: Math.max(1, Math.floor((Date.now() - new Date(p.created_at).getTime()) / 86400000)),
    }
  }))

  results.sort((a, b) => b.pnl_pct - a.pnl_pct)
  return c.json(results)
})

app.get('/api/paper/portfolios/:id', async (c) => {
  const db = await getPaperClient()
  if (!db) return c.json({ error: 'DB not configured' }, 500)

  const id = c.req.param('id')
  const { data: portfolio, error } = await db.from('paper_portfolios').select('*').eq('id', id).single()
  if (error || !portfolio) return c.json({ error: 'Not found' }, 404)

  const { data: positions } = await db.from('paper_positions').select('*').eq('portfolio_id', id).eq('is_open', true)
  const { data: transactions } = await db.from('paper_transactions').select('*').eq('portfolio_id', id).order('created_at', { ascending: false }).limit(50)
  const { data: fundingTxns } = await db.from('paper_transactions').select('amount').eq('portfolio_id', id).eq('type', 'funding')

  const cachedResult = await getCachedRates()
  const spreadsMap = new Map(cachedResult.spreads.map(s => [s.asset, s]))

  const enrichedPositions = (positions ?? []).map((pos: any) => {
    const spread = spreadsMap.get(pos.asset)
    return {
      ...pos,
      current_rate_8h: spread?.hl?.rate8h ?? null,
      current_spread: spread?.maxSpread ?? null,
    }
  })

  const positionValue = (positions ?? []).reduce((s: number, p: any) => s + p.size_usd, 0)
  const totalFunding = (fundingTxns ?? []).reduce((s: number, t: any) => s + t.amount, 0)
  const totalValue = (portfolio as any).cash_balance + positionValue
  const totalPnl = totalValue - (portfolio as any).initial_balance
  const p = portfolio as any

  return c.json({
    ...p,
    total_value: totalValue,
    total_pnl: totalPnl,
    pnl_pct: (totalPnl / p.initial_balance) * 100,
    open_positions_count: enrichedPositions.length,
    total_funding_collected: totalFunding,
    days_running: Math.max(1, Math.floor((Date.now() - new Date(p.created_at).getTime()) / 86400000)),
    positions: enrichedPositions,
    recent_transactions: transactions ?? [],
  })
})

/** Compute unrealized P&L for a position given current mark price */
function computeAiUnrealizedPnl(pos: any, currentPrice: number | null): number {
  if (!currentPrice || !pos.entry_price_approx) return 0
  if (pos.direction === 'long') {
    return (currentPrice - pos.entry_price_approx) / pos.entry_price_approx * pos.size_usd
  } else {
    return (pos.entry_price_approx - currentPrice) / pos.entry_price_approx * pos.size_usd
  }
}

// AI Traders routes
app.get('/api/ai/traders', async (c) => {
  const db = await getPaperClient()
  if (!db) return c.json({ error: 'DB not configured' }, 500)

  const { data: traders, error } = await db.from('ai_traders').select('*').order('name')
  if (error) return c.json({ error: error.message }, 500)

  const cachedResult = await getCachedRates()
  const spreadsMap = new Map(cachedResult.spreads.map((s: any) => [s.asset, s]))

  const results = await Promise.all((traders ?? []).map(async (t: any) => {
    const { data: positions } = await db.from('ai_positions').select('*').eq('trader_id', t.id).eq('is_open', true)
    const { data: allPositions } = await db.from('ai_positions').select('funding_collected').eq('trader_id', t.id)
    const { data: decisions } = await db.from('ai_decisions').select('action, reasoning, asset, created_at').eq('trader_id', t.id).order('created_at', { ascending: false }).limit(1)

    // Mark-to-market: size_usd + unrealized_pnl + funding_collected per position
    const totalPositionValue = (positions ?? []).reduce((s: number, p: any) => {
      const spread = spreadsMap.get(p.asset) as any
      const currentPrice = spread?.hl?.markPrice ?? null
      const unrealizedPnl = computeAiUnrealizedPnl(p, currentPrice)
      return s + p.size_usd + unrealizedPnl + (p.funding_collected ?? 0)
    }, 0)

    const totalFunding = (allPositions ?? []).reduce((s: number, p: any) => s + (p.funding_collected ?? 0), 0)
    const totalValue = t.cash_balance + totalPositionValue
    const totalPnl = totalValue - 10000

    return {
      ...t,
      total_value: totalValue,
      total_pnl: totalPnl,
      pnl_pct: totalPnl / 10000 * 100,
      open_positions_count: (positions ?? []).length,
      total_funding_collected: totalFunding,
      last_decision: decisions?.[0] ?? null,
    }
  }))

  results.sort((a, b) => b.pnl_pct - a.pnl_pct)
  return c.json(results)
})

app.get('/api/ai/traders/:name', async (c) => {
  const db = await getPaperClient()
  if (!db) return c.json({ error: 'DB not configured' }, 500)

  const name = c.req.param('name')
  const { data: trader, error } = await db.from('ai_traders').select('*').eq('name', name).single()
  if (error || !trader) return c.json({ error: 'Not found' }, 404)

  const t = trader as any
  const { data: positions } = await db.from('ai_positions').select('*').eq('trader_id', t.id).eq('is_open', true)
  const { data: allPositions } = await db.from('ai_positions').select('funding_collected').eq('trader_id', t.id)
  const { data: decisions } = await db.from('ai_decisions').select('*').eq('trader_id', t.id).order('created_at', { ascending: false }).limit(20)

  const totalFunding = (allPositions ?? []).reduce((s: number, p: any) => s + (p.funding_collected ?? 0), 0)

  // Enrich positions with current price and mark-to-market unrealized P&L
  const cachedResult = await getCachedRates()
  const spreadsMap = new Map(cachedResult.spreads.map((s: any) => [s.asset, s]))
  const enrichedPositions = (positions ?? []).map((p: any) => {
    const spread = spreadsMap.get(p.asset) as any
    const currentPrice = spread?.hl?.markPrice ?? null
    const unrealizedPnl = computeAiUnrealizedPnl(p, currentPrice)
    return {
      ...p,
      current_price: currentPrice,
      unrealized_pnl: unrealizedPnl,
      current_rate_8h: spread?.hl?.rate8h ?? null,
    }
  })

  // Mark-to-market total value
  const totalPositionValue = enrichedPositions.reduce((s: number, p: any) => {
    return s + p.size_usd + (p.unrealized_pnl ?? 0) + (p.funding_collected ?? 0)
  }, 0)

  const totalValue = t.cash_balance + totalPositionValue
  const totalPnl = totalValue - 10000

  return c.json({
    ...t,
    total_value: totalValue,
    total_pnl: totalPnl,
    pnl_pct: totalPnl / 10000 * 100,
    open_positions_count: enrichedPositions.length,
    total_funding_collected: totalFunding,
    last_decision: decisions?.[0] ?? null,
    positions: enrichedPositions,
    recent_decisions: decisions ?? [],
  })
})

app.post('/api/ai/run/:name', async (c) => {
  const name = c.req.param('name')
  try {
    const decision = await runAiTraderCycle(name)
    return c.json({ ok: true, ...decision })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Background polling — fetch every 30 seconds
async function poll() {
  try {
    const result = await aggregateRates()
    updateCache(result)
    // Fire and forget DB save
    saveSnapshot(result.allRates).catch((err) => console.error('[Poll] DB save error:', err))
    // Run paper trading cycle
    runPaperTradingCycle().catch((err) => console.error('[Poll] Paper trading error:', err))
  } catch (err) {
    console.error('[Poll] Error:', err)
  }
}

// Initial fetch + recurring
poll()
setInterval(poll, 30_000)

const port = Number(process.env.PORT || 3001)
console.log(`[API] Starting on port ${port}`)

export default {
  port,
  fetch: app.fetch,
}
