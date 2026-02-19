import { getCachedRates } from './cache'
import type { FundingSpread } from '../../../packages/shared/src/types'

// Service-role client for writes
let serviceClient: any = null

async function getServiceClient() {
  if (serviceClient) return serviceClient
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.warn('[Paper] SUPABASE_SERVICE_ROLE_KEY not set — paper trading disabled')
    return null
  }
  const { createClient } = await import('@supabase/supabase-js')
  serviceClient = createClient(url, key)
  return serviceClient
}

interface Portfolio {
  id: string
  strategy_name: string
  strategy_config: any
  cash_balance: number
  initial_balance: number
  is_active: boolean
  created_at: string
}

interface Position {
  id: string
  portfolio_id: string
  asset: string
  side: string // 'short_perp' | 'long_perp'
  size_usd: number
  entry_rate_8h: number
  total_funding_collected: number
  last_funding_collected: string
  opened_at: string
}

const TRADING_FEE = 0.0005 // 0.05%
const FUNDING_PERIOD_MS = 60 * 60 * 1000 // 1 hour (HL pays hourly)

export async function runPaperTradingCycle(): Promise<void> {
  const db = await getServiceClient()
  if (!db) return

  const cachedResult = await getCachedRates()
  if (!cachedResult || cachedResult.spreads.length === 0) return

  const spreadsMap = new Map<string, FundingSpread>()
  for (const s of cachedResult.spreads) spreadsMap.set(s.asset, s)

  // Load active portfolios
  const { data: portfolios, error: pErr } = await db
    .from('paper_portfolios')
    .select('*')
    .eq('is_active', true)

  if (pErr || !portfolios?.length) {
    if (pErr) console.error('[Paper] Load portfolios error:', pErr.message)
    return
  }

  for (const portfolio of portfolios as Portfolio[]) {
    try {
      await processPortfolio(db, portfolio, spreadsMap, cachedResult.spreads)
    } catch (err: any) {
      console.error(`[Paper] Error processing '${portfolio.strategy_name}':`, err.message)
    }
  }
}

async function processPortfolio(
  db: any,
  portfolio: Portfolio,
  spreadsMap: Map<string, FundingSpread>,
  allSpreads: FundingSpread[]
) {
  const config = portfolio.strategy_config
  const now = new Date()

  // Load open positions
  const { data: positions, error: posErr } = await db
    .from('paper_positions')
    .select('*')
    .eq('portfolio_id', portfolio.id)
    .eq('is_open', true)

  if (posErr) {
    console.error(`[Paper] Load positions error for '${portfolio.strategy_name}':`, posErr.message)
    return
  }

  const openPositions = (positions ?? []) as Position[]
  let cashBalance = portfolio.cash_balance

  // Step 1: Collect funding on open positions
  for (const pos of openPositions) {
    const spread = spreadsMap.get(pos.asset)
    if (!spread || !spread.hl) continue

    const lastCollected = new Date(pos.last_funding_collected).getTime()
    const elapsed = now.getTime() - lastCollected
    const periodsElapsed = Math.floor(elapsed / FUNDING_PERIOD_MS)

    if (periodsElapsed <= 0) continue

    const currentRate8h = spread.hl.rate8h
    const hourlyRate = currentRate8h / 8

    // short_perp: positive rate = we collect; long_perp: opposite
    const direction = pos.side === 'short_perp' ? 1 : -1
    const fundingEarned = pos.size_usd * hourlyRate * periodsElapsed * direction

    if (Math.abs(fundingEarned) < 0.001) continue

    // Update position
    const newFundingCollected = pos.total_funding_collected + fundingEarned
    const newLastCollected = new Date(lastCollected + periodsElapsed * FUNDING_PERIOD_MS).toISOString()

    await db.from('paper_positions').update({
      total_funding_collected: newFundingCollected,
      last_funding_collected: newLastCollected,
    }).eq('id', pos.id)

    // Insert funding transaction
    await db.from('paper_transactions').insert({
      portfolio_id: portfolio.id,
      position_id: pos.id,
      type: 'funding',
      asset: pos.asset,
      amount: fundingEarned,
      description: `Funding ${fundingEarned > 0 ? 'collected' : 'paid'}: ${pos.asset} ${periodsElapsed}h`,
    })

    cashBalance += fundingEarned
    pos.total_funding_collected = newFundingCollected
    pos.last_funding_collected = newLastCollected

    if (Math.abs(fundingEarned) > 1) {
      console.log(`[Paper] '${portfolio.strategy_name}': ${fundingEarned > 0 ? 'collected' : 'paid'} $${Math.abs(fundingEarned).toFixed(2)} funding on ${pos.asset}`)
    }
  }

  // Step 2: Check exit conditions
  const positionsToRemove: string[] = []
  for (const pos of openPositions) {
    const spread = spreadsMap.get(pos.asset)
    if (!spread) continue

    let shouldExit = false

    if (portfolio.strategy_name === 'negative_fade') {
      const hlRate = spread.hl?.rate8h ?? 0
      const exitThreshold = config.exit_rate_threshold ?? -0.01
      shouldExit = hlRate > exitThreshold
    } else {
      const currentSpread = spread.maxSpread
      const exitSpread = config.exit_spread_threshold ?? 0.01
      shouldExit = currentSpread < exitSpread
    }

    if (shouldExit) {
      const fee = pos.size_usd * TRADING_FEE
      // Return position size minus exit fee
      cashBalance += pos.size_usd - fee

      await db.from('paper_positions').update({ is_open: false }).eq('id', pos.id)

      await db.from('paper_transactions').insert([
        {
          portfolio_id: portfolio.id,
          position_id: pos.id,
          type: 'close',
          asset: pos.asset,
          amount: pos.size_usd - fee,
          note: `Closed ${pos.asset} $${pos.size_usd.toFixed(0)}, fee: $${fee.toFixed(2)}`,
        },
      ])

      positionsToRemove.push(pos.id)

      console.log(`[Paper] '${portfolio.strategy_name}': closed ${pos.asset} position $${pos.size_usd.toFixed(0)}, funding collected: $${pos.total_funding_collected.toFixed(2)}`)
    }
  }

  const remainingPositions = openPositions.filter(p => !positionsToRemove.includes(p.id))

  // Step 3: Check entry conditions
  const totalPositionValue = remainingPositions.reduce((sum, p) => sum + p.size_usd, 0)
  const totalValue = cashBalance + totalPositionValue
  // config stores as decimal (0.20 = 20%), so multiply directly (no /100)
  const maxPositionSize = totalValue * (config.max_position_size_pct ?? 0.20)
  const maxPositions = config.max_positions ?? 5
  const openAssets = new Set(remainingPositions.map(p => p.asset))

  if (remainingPositions.length < maxPositions && cashBalance > maxPositionSize * 0.5) {
    let candidates: FundingSpread[]

    if (portfolio.strategy_name === 'negative_fade') {
      // Long when HL rate is deeply negative
      const entryThreshold = config.entry_rate_threshold ?? -0.05
      candidates = allSpreads.filter(s =>
        s.hl && s.hl.rate8h < entryThreshold && !openAssets.has(s.asset)
      ).sort((a, b) => (a.hl?.rate8h ?? 0) - (b.hl?.rate8h ?? 0))
    } else if (portfolio.strategy_name === 'conservative') {
      const allowedAssets = config.allowed_assets ?? ['BTC', 'ETH']
      const entrySpread = config.entry_spread_threshold ?? 0.05
      candidates = allSpreads.filter(s =>
        allowedAssets.includes(s.asset) && s.maxSpread > entrySpread && !openAssets.has(s.asset)
      ).sort((a, b) => b.maxSpread - a.maxSpread)
    } else if (portfolio.strategy_name === 'diversified') {
      const topN = config.top_n_by_oi ?? 20
      const entrySpread = config.entry_spread_threshold ?? 0.04
      // Filter by top OI
      const withOI = allSpreads
        .filter(s => s.hl?.openInterest)
        .sort((a, b) => (b.hl?.openInterest ?? 0) - (a.hl?.openInterest ?? 0))
        .slice(0, topN)
      candidates = withOI.filter(s =>
        s.maxSpread > entrySpread && !openAssets.has(s.asset)
      ).sort((a, b) => b.maxSpread - a.maxSpread)
    } else {
      // aggressive
      const entrySpread = config.entry_spread_threshold ?? 0.03
      candidates = allSpreads.filter(s =>
        s.maxSpread > entrySpread && !openAssets.has(s.asset)
      ).sort((a, b) => b.maxSpread - a.maxSpread)
    }

    for (const candidate of candidates) {
      if (remainingPositions.length + positionsToRemove.length >= maxPositions) break // recount
      if (openAssets.size >= maxPositions) break

      const positionSize = Math.min(maxPositionSize, cashBalance - maxPositionSize * TRADING_FEE)
      if (positionSize < 100) break // minimum position

      const fee = positionSize * TRADING_FEE
      if (cashBalance < positionSize + fee) break

      const side = portfolio.strategy_name === 'negative_fade' ? 'long_perp' : 'short_perp'
      const hlRate = candidate.hl?.rate8h ?? 0

      const { error: insertErr } = await db.from('paper_positions').insert({
        portfolio_id: portfolio.id,
        asset: candidate.asset,
        side,
        size_usd: positionSize,
        entry_rate_8h: hlRate,
        entry_spread: candidate.maxSpread,
        total_funding_collected: 0,
        last_funding_collected: now.toISOString(),
        opened_at: now.toISOString(),
      })

      if (insertErr) {
        console.error(`[Paper] Insert position error:`, insertErr.message)
        continue
      }

      cashBalance -= (positionSize + fee)

      await db.from('paper_transactions').insert([
        {
          portfolio_id: portfolio.id,
          type: 'open',
          asset: candidate.asset,
          amount: -positionSize,
          description: `Opened ${side} ${candidate.asset} $${positionSize.toFixed(0)} @ spread ${(candidate.maxSpread * 100).toFixed(4)}%`,
        },
        {
          portfolio_id: portfolio.id,
          type: 'fee',
          asset: candidate.asset,
          amount: -fee,
          description: `Entry fee ${candidate.asset}: $${fee.toFixed(2)}`,
        },
      ])

      openAssets.add(candidate.asset)
      console.log(`[Paper] '${portfolio.strategy_name}': opened ${candidate.asset} position $${positionSize.toFixed(0)}`)
    }
  }

  // Update portfolio cash balance
  const { error: updateErr } = await db
    .from('paper_portfolios')
    .update({ cash_balance: cashBalance, updated_at: new Date().toISOString() })
    .eq('id', portfolio.id)
  if (updateErr) {
    console.error(`[Paper] Failed to update cash balance for '${portfolio.strategy_name}':`, updateErr.message)
  } else {
    console.log(`[Paper] '${portfolio.strategy_name}' cash balance updated: $${cashBalance.toFixed(2)}`)
  }
}
