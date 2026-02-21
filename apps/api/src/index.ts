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

/** Compute Sharpe ratio (annualized hourly) and Max Drawdown from a list of snapshot values */
function computeSharpeAndDrawdown(values: number[]): { sharpe: number | null; max_drawdown: number | null } {
  if (values.length < 2) return { sharpe: null, max_drawdown: null }

  // Hourly returns
  const returns: number[] = []
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) {
      returns.push((values[i] - values[i - 1]) / values[i - 1])
    }
  }
  if (returns.length < 2) return { sharpe: null, max_drawdown: null }

  const n = returns.length
  const mean = returns.reduce((s, r) => s + r, 0) / n
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1)
  const std = Math.sqrt(variance)
  const sharpe = std > 0 ? Number(((mean / std) * Math.sqrt(8760)).toFixed(3)) : null

  // Max drawdown
  let peak = values[0]
  let maxDD = 0
  for (const v of values) {
    if (v > peak) peak = v
    if (peak > 0) {
      const dd = (peak - v) / peak
      if (dd > maxDD) maxDD = dd
    }
  }
  const max_drawdown = maxDD > 0 ? Number((-maxDD).toFixed(5)) : 0

  return { sharpe, max_drawdown }
}

/** Compute unrealized P&L for a paper position given current mark price */
function computePaperUnrealizedPnl(pos: any, currentPrice: number | null): number {
  if (!currentPrice || !pos.entry_price) return 0
  if (pos.side === 'long_perp') {
    return (currentPrice - pos.entry_price) / pos.entry_price * pos.size_usd
  } else {
    // short_perp
    return (pos.entry_price - currentPrice) / pos.entry_price * pos.size_usd
  }
}

// Paper trading routes
app.get('/api/paper/portfolios', async (c) => {
  const db = await getPaperClient()
  if (!db) return c.json({ error: 'DB not configured' }, 500)

  const { data: portfolios, error } = await db.from('paper_portfolios').select('*')
  if (error) return c.json({ error: error.message }, 500)

  const cachedResult = await getCachedRates()
  const spreadsMap = new Map(cachedResult.spreads.map((s: any) => [s.asset, s]))

  const results = await Promise.all((portfolios ?? []).map(async (p: any) => {
    const { data: positions } = await db.from('paper_positions').select('*').eq('portfolio_id', p.id).eq('is_open', true)
    const { data: fundingTxns } = await db.from('paper_transactions').select('amount').eq('portfolio_id', p.id).eq('type', 'funding')
    const { data: snaps } = await db.from('paper_snapshots').select('total_value').eq('portfolio_id', p.id).order('snapshot_at', { ascending: true })

    // Mark-to-market: size_usd + unrealized_pnl + total_funding_collected per position
    const positionValue = (positions ?? []).reduce((s: number, pos: any) => {
      const spread = spreadsMap.get(pos.asset) as any
      const currentPrice = spread?.hl?.markPrice ?? null
      const unrealizedPnl = computePaperUnrealizedPnl(pos, currentPrice)
      return s + pos.size_usd + unrealizedPnl + (pos.total_funding_collected ?? 0)
    }, 0)

    const totalFunding = (fundingTxns ?? []).reduce((s: number, t: any) => s + t.amount, 0)
    const totalValue = p.cash_balance + positionValue
    const totalPnl = totalValue - p.initial_balance
    const daysRunning = Math.max(1, Math.floor((Date.now() - new Date(p.created_at).getTime()) / 86400000))

    const snapValues = (snaps ?? []).map((s: any) => Number(s.total_value))
    const { sharpe, max_drawdown } = computeSharpeAndDrawdown(snapValues)

    return {
      ...p,
      total_value: totalValue,
      total_pnl: totalPnl,
      pnl_pct: (totalPnl / p.initial_balance) * 100,
      open_positions_count: (positions ?? []).length,
      total_funding_collected: totalFunding,
      days_running: daysRunning,
      mark_to_market: true,
      sharpe,
      max_drawdown,
    }
  }))

  return c.json(results)
})

app.get('/api/paper/leaderboard', async (c) => {
  const db = await getPaperClient()
  if (!db) return c.json({ error: 'DB not configured' }, 500)

  const { data: portfolios } = await db.from('paper_portfolios').select('*')
  const cachedResult = await getCachedRates()
  const spreadsMap = new Map(cachedResult.spreads.map((s: any) => [s.asset, s]))

  const results = await Promise.all((portfolios ?? []).map(async (p: any) => {
    const { data: positions } = await db.from('paper_positions').select('*').eq('portfolio_id', p.id).eq('is_open', true)
    // Mark-to-market position value
    const positionValue = (positions ?? []).reduce((s: number, pos: any) => {
      const spread = spreadsMap.get(pos.asset) as any
      const currentPrice = spread?.hl?.markPrice ?? null
      const unrealizedPnl = computePaperUnrealizedPnl(pos, currentPrice)
      return s + pos.size_usd + unrealizedPnl + (pos.total_funding_collected ?? 0)
    }, 0)
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
      mark_to_market: true,
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
  const { data: closedPositions } = await db.from('paper_positions').select('*').eq('portfolio_id', id).eq('is_open', false).order('opened_at', { ascending: false }).limit(20)
  const { data: transactions } = await db.from('paper_transactions').select('*').eq('portfolio_id', id).order('created_at', { ascending: false }).limit(50)
  const { data: fundingTxns } = await db.from('paper_transactions').select('amount').eq('portfolio_id', id).eq('type', 'funding')

  // Get close timestamps from transactions for closed positions
  const closedIds = (closedPositions ?? []).map((p: any) => p.id).filter(Boolean)
  let closeTxnMap = new Map<string, any>()
  if (closedIds.length > 0) {
    const { data: closeTxns } = await db.from('paper_transactions').select('position_id, amount, created_at').in('position_id', closedIds).eq('type', 'close')
    for (const t of closeTxns ?? []) {
      closeTxnMap.set(t.position_id, t)
    }
  }
  const closedEnriched = (closedPositions ?? []).map((pos: any) => {
    const closeTxn = closeTxnMap.get(pos.id)
    // Use stored realized_pnl if available, fall back to funding as estimate
    const realizedPnl = pos.realized_pnl !== null && pos.realized_pnl !== undefined
      ? pos.realized_pnl
      : (pos.total_funding_collected ?? null)
    return {
      id: pos.id,
      asset: pos.asset,
      side: pos.side,
      size_usd: pos.size_usd,
      entry_price: pos.entry_price ?? null,
      entry_rate_8h: pos.entry_rate_8h,
      total_funding_collected: pos.total_funding_collected,
      opened_at: pos.opened_at,
      closed_at: pos.closed_at ?? closeTxn?.created_at ?? null,
      exit_price: pos.exit_price ?? null,
      realized_pnl: realizedPnl,
      pnl: realizedPnl, // backward compat
      fees_paid: pos.fees_paid ?? null,
    }
  })

  const cachedResult = await getCachedRates()
  const spreadsMap = new Map(cachedResult.spreads.map(s => [s.asset, s]))

  const stopLossPct: number = (portfolio as any).strategy_config?.stop_loss_pct ?? 0.10

  const enrichedPositions = (positions ?? []).map((pos: any) => {
    const spread = spreadsMap.get(pos.asset) as any
    const currentPrice: number | null = spread?.hl?.markPrice ?? null
    const unrealizedPnl = computePaperUnrealizedPnl(pos, currentPrice)
    const unrealizedPnlPct = pos.size_usd > 0 ? (unrealizedPnl / pos.size_usd) * 100 : 0
    const fundingCollected = pos.total_funding_collected ?? 0
    const unrealizedPnlTotal = unrealizedPnl + fundingCollected

    // Distance to stop loss (positive = buffer remaining, negative = already past stop)
    let unrealizedPricePct: number | null = null
    let distanceToStop: number | null = null
    if (currentPrice && pos.entry_price && pos.entry_price > 0) {
      if (pos.side === 'short_perp') {
        unrealizedPricePct = (pos.entry_price - currentPrice) / pos.entry_price
      } else {
        unrealizedPricePct = (currentPrice - pos.entry_price) / pos.entry_price
      }
      // distance_to_stop: how much further price can move against us before stop triggers
      // e.g. unrealizedPricePct = -0.032, stopLossPct = 0.15 → distanceToStop = 0.118 (11.8% buffer)
      distanceToStop = stopLossPct + unrealizedPricePct // positive = still have buffer
    }

    return {
      ...pos,
      current_price: currentPrice,
      current_rate_8h: spread?.hl?.rate8h ?? null,
      current_spread: spread?.maxSpread ?? null,
      unrealized_pnl: unrealizedPnl,
      unrealized_pnl_pct: unrealizedPnlPct,
      unrealized_pnl_total: unrealizedPnlTotal,
      total_position_value: pos.size_usd + unrealizedPnl + fundingCollected,
      stop_loss_pct: stopLossPct,
      unrealized_price_pct: unrealizedPricePct,
      distance_to_stop: distanceToStop,
    }
  })

  // Mark-to-market: sum(size_usd + unrealized_pnl + total_funding_collected) per position
  const positionValue = enrichedPositions.reduce((s: number, pos: any) => s + pos.total_position_value, 0)
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
    mark_to_market: true,
    stop_loss_pct: stopLossPct,
    positions: enrichedPositions,
    closed_positions: closedEnriched,
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
    const { data: snaps } = await db.from('ai_snapshots').select('total_value').eq('trader_id', t.id).order('snapshot_at', { ascending: true })

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

    const snapValues = (snaps ?? []).map((s: any) => Number(s.total_value))
    const { sharpe, max_drawdown } = computeSharpeAndDrawdown(snapValues)

    return {
      ...t,
      total_value: totalValue,
      total_pnl: totalPnl,
      pnl_pct: totalPnl / 10000 * 100,
      open_positions_count: (positions ?? []).length,
      total_funding_collected: totalFunding,
      last_decision: decisions?.[0] ?? null,
      sharpe,
      max_drawdown,
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

// Color maps for consistent series colors
const PORTFOLIO_COLORS: Record<string, string> = {
  aggressive: '#10b981',
  conservative: '#3b82f6',
  diversified: '#f59e0b',
  'negative fade': '#8b5cf6',
  'negative_fade': '#8b5cf6',
}

const TRADER_COLORS: Record<string, string> = {
  opus: '#a78bfa',
  flash: '#fbbf24',
  deepseek: '#f87171',
  sonnet: '#34d399',
}

function getPortfolioColor(name: string): string {
  const lower = name.toLowerCase()
  for (const [key, color] of Object.entries(PORTFOLIO_COLORS)) {
    if (lower.includes(key)) return color
  }
  return '#6b7280'
}

function getTraderColor(name: string): string {
  const lower = name.toLowerCase()
  for (const [key, color] of Object.entries(TRADER_COLORS)) {
    if (lower.includes(key)) return color
  }
  return '#6b7280'
}

// GET /api/paper/snapshots?days=7
app.get('/api/paper/snapshots', async (c) => {
  const db = await getPaperClient()
  if (!db) return c.json({ error: 'DB not configured' }, 500)

  const days = Math.min(Math.max(Number(c.req.query('days') || 7), 1), 90)
  const since = new Date(Date.now() - days * 86400000).toISOString()

  const { data: portfolios, error: pErr } = await db.from('paper_portfolios').select('id, strategy_name')
  if (pErr) return c.json({ error: pErr.message }, 500)

  const series = await Promise.all((portfolios ?? []).map(async (p: any) => {
    const { data: snaps } = await db
      .from('paper_snapshots')
      .select('snapshot_at, total_value')
      .eq('portfolio_id', p.id)
      .gte('snapshot_at', since)
      .order('snapshot_at', { ascending: true })

    const baseline = 10000
    const data = (snaps ?? []).map((s: any) => ({
      time: s.snapshot_at,
      value: Number(s.total_value),
      pnl_pct: ((Number(s.total_value) - baseline) / baseline) * 100,
    }))

    return {
      id: p.id,
      name: p.strategy_name,
      color: getPortfolioColor(p.strategy_name),
      data,
    }
  }))

  return c.json({ series })
})

// GET /api/ai/snapshots?days=7
app.get('/api/ai/snapshots', async (c) => {
  const db = await getPaperClient()
  if (!db) return c.json({ error: 'DB not configured' }, 500)

  const days = Math.min(Math.max(Number(c.req.query('days') || 7), 1), 90)
  const since = new Date(Date.now() - days * 86400000).toISOString()

  const { data: traders, error: tErr } = await db.from('ai_traders').select('id, name').order('name')
  if (tErr) return c.json({ error: tErr.message }, 500)

  const series = await Promise.all((traders ?? []).map(async (t: any) => {
    const { data: snaps } = await db
      .from('ai_snapshots')
      .select('snapshot_at, total_value')
      .eq('trader_id', t.id)
      .gte('snapshot_at', since)
      .order('snapshot_at', { ascending: true })

    const baseline = 10000
    const data = (snaps ?? []).map((s: any) => ({
      time: s.snapshot_at,
      value: Number(s.total_value),
      pnl_pct: ((Number(s.total_value) - baseline) / baseline) * 100,
    }))

    return {
      id: t.id,
      name: t.name,
      color: getTraderColor(t.name),
      data,
    }
  }))

  return c.json({ series })
})

// POST /api/internal/snapshot — called hourly by cron
app.post('/api/internal/snapshot', async (c) => {
  const db = await getPaperClient()
  if (!db) return c.json({ error: 'DB not configured' }, 500)

  let snapshotted = 0
  const now = new Date().toISOString()

  // ── Paper portfolios ──
  const { data: portfolios } = await db.from('paper_portfolios').select('*')
  const cachedResult = await getCachedRates()
  const spreadsMap = new Map(cachedResult.spreads.map((s: any) => [s.asset, s]))

  await Promise.all((portfolios ?? []).map(async (p: any) => {
    const { data: positions } = await db.from('paper_positions').select('*').eq('portfolio_id', p.id).eq('is_open', true)
    const { data: fundingTxns } = await db.from('paper_transactions').select('amount').eq('portfolio_id', p.id).eq('type', 'funding')

    const positionValue = (positions ?? []).reduce((s: number, pos: any) => {
      const spread = spreadsMap.get(pos.asset) as any
      const currentPrice = spread?.hl?.markPrice ?? null
      const unrealizedPnl = computePaperUnrealizedPnl(pos, currentPrice)
      return s + pos.size_usd + unrealizedPnl + (pos.total_funding_collected ?? 0)
    }, 0)

    const totalFunding = (fundingTxns ?? []).reduce((s: number, t: any) => s + t.amount, 0)
    const totalValue = p.cash_balance + positionValue
    const unrealizedPnl = (positions ?? []).reduce((s: number, pos: any) => {
      const spread = spreadsMap.get(pos.asset) as any
      const currentPrice = spread?.hl?.markPrice ?? null
      return s + computePaperUnrealizedPnl(pos, currentPrice)
    }, 0)

    await db.from('paper_snapshots').insert({
      portfolio_id: p.id,
      snapshot_at: now,
      total_value: totalValue,
      cash_balance: p.cash_balance,
      unrealized_pnl: unrealizedPnl,
      funding_collected: totalFunding,
      open_positions: (positions ?? []).length,
    })
    snapshotted++
  }))

  // ── AI traders ──
  const { data: traders } = await db.from('ai_traders').select('*')

  await Promise.all((traders ?? []).map(async (t: any) => {
    const { data: positions } = await db.from('ai_positions').select('*').eq('trader_id', t.id).eq('is_open', true)
    const { data: allPositions } = await db.from('ai_positions').select('funding_collected').eq('trader_id', t.id)

    const totalPositionValue = (positions ?? []).reduce((s: number, p: any) => {
      const spread = spreadsMap.get(p.asset) as any
      const currentPrice = spread?.hl?.markPrice ?? null
      const unrealizedPnl = computeAiUnrealizedPnl(p, currentPrice)
      return s + p.size_usd + unrealizedPnl + (p.funding_collected ?? 0)
    }, 0)

    const totalFunding = (allPositions ?? []).reduce((s: number, p: any) => s + (p.funding_collected ?? 0), 0)
    const totalValue = t.cash_balance + totalPositionValue
    const unrealizedPnl = (positions ?? []).reduce((s: number, p: any) => {
      const spread = spreadsMap.get(p.asset) as any
      const currentPrice = spread?.hl?.markPrice ?? null
      return s + computeAiUnrealizedPnl(p, currentPrice)
    }, 0)

    await db.from('ai_snapshots').insert({
      trader_id: t.id,
      snapshot_at: now,
      total_value: totalValue,
      cash_balance: t.cash_balance,
      unrealized_pnl: unrealizedPnl,
      funding_collected: totalFunding,
      open_positions: (positions ?? []).length,
    })
    snapshotted++
  }))

  return c.json({ ok: true, snapshotted })
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
