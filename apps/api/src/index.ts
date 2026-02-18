import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCachedRates, getCacheAge, getLastFetchTime, getAssetCount, updateCache } from './cache'
import { aggregateRates } from './aggregator'
import { saveSnapshot } from './db'
import { getHistory } from './db'
import { runPaperTradingCycle } from './paper-trading'
import { getPaperClient } from './paper-routes'

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
    const { data: positions } = await db.from('paper_positions').select('size_usd').eq('portfolio_id', p.id).is('closed_at', null)
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
    const { data: positions } = await db.from('paper_positions').select('size_usd').eq('portfolio_id', p.id).is('closed_at', null)
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

  const { data: positions } = await db.from('paper_positions').select('*').eq('portfolio_id', id).is('closed_at', null)
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
