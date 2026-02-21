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
  entry_price: number | null
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
    let exitReason = 'strategy'

    // --- Stop loss check (runs BEFORE strategy-specific logic) ---
    const currentExitPrice = spread?.hl?.markPrice ?? null
    const entryPriceForSL = pos.entry_price ?? null
    const stopLossPct = config.stop_loss_pct ?? 0.10

    if (currentExitPrice && entryPriceForSL && entryPriceForSL > 0) {
      let unrealizedPricePct = 0
      if (pos.side === 'short_perp') {
        unrealizedPricePct = (entryPriceForSL - currentExitPrice) / entryPriceForSL // positive = profit
      } else {
        unrealizedPricePct = (currentExitPrice - entryPriceForSL) / entryPriceForSL // positive = profit
      }

      if (unrealizedPricePct < -stopLossPct) {
        shouldExit = true
        exitReason = 'stop_loss'
        console.log(`[Paper] STOP LOSS triggered: ${pos.asset} ${pos.side} unrealized ${(unrealizedPricePct * 100).toFixed(2)}% < -${(stopLossPct * 100).toFixed(0)}%`)
      }
    }

    // --- Strategy-specific exit logic (only if stop loss not already triggered) ---
    if (!shouldExit) {
      if (portfolio.strategy_name === 'negative_fade') {
        const hlRate = spread.hl?.rate8h ?? 0
        const exitThreshold = config.exit_rate_threshold ?? -0.01
        shouldExit = hlRate > exitThreshold
      } else if (portfolio.strategy_name === 'regime_adaptive') {
        const hlRate = spread.hl?.rate8h ?? 0
        const exitThreshold = config.exit_rate_threshold ?? 0.0001 // exit near zero
        if (pos.side === 'long_perp') {
          shouldExit = hlRate > exitThreshold // long: exit when rate recovers toward positive
        } else {
          shouldExit = hlRate < -exitThreshold // short: exit when rate goes negative
        }
      } else {
        const currentSpread = spread.maxSpread
        const exitSpread = config.exit_spread_threshold ?? 0.01
        shouldExit = currentSpread < exitSpread
      }
    }

    if (shouldExit) {
      // Compute exit price and realized P&L
      const exitPrice = spread?.hl?.markPrice ?? null
      const entryPrice = pos.entry_price ?? null

      let priceReturn = 0
      if (exitPrice && entryPrice && entryPrice > 0) {
        if (pos.side === 'short_perp') {
          priceReturn = (entryPrice - exitPrice) / entryPrice * pos.size_usd
        } else { // long_perp
          priceReturn = (exitPrice - entryPrice) / entryPrice * pos.size_usd
        }
      }

      const exitFee = pos.size_usd * TRADING_FEE
      const fundingCollected = pos.total_funding_collected ?? 0
      const realizedPnl = priceReturn + fundingCollected - exitFee
      // Note: entry fee was already deducted from cash when opening

      // Return to cash: original size + price profit/loss + funding - exit fee
      cashBalance += pos.size_usd + priceReturn + fundingCollected - exitFee

      await db.from('paper_positions').update({
        is_open: false,
        exit_price: exitPrice,
        realized_pnl: realizedPnl,
        closed_at: now.toISOString(),
      }).eq('id', pos.id)

      await db.from('paper_transactions').insert([
        {
          portfolio_id: portfolio.id,
          position_id: pos.id,
          type: 'close',
          asset: pos.asset,
          amount: pos.size_usd + priceReturn + fundingCollected - exitFee,
          note: `Closed ${pos.asset} $${pos.size_usd.toFixed(0)} (${exitReason}), price P&L: $${priceReturn.toFixed(2)}, fee: $${exitFee.toFixed(2)}`,
        },
      ])

      positionsToRemove.push(pos.id)

      console.log(`[Paper] '${portfolio.strategy_name}': closed ${pos.asset} position $${pos.size_usd.toFixed(0)}, realized P&L: $${realizedPnl.toFixed(2)} (price: $${priceReturn.toFixed(2)}, funding: $${fundingCollected.toFixed(2)}, fee: -$${exitFee.toFixed(2)}) [${exitReason}]`)
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
      const entryThreshold = config.enter_rate_threshold ?? config.entry_rate_threshold ?? -0.05
      candidates = allSpreads.filter(s =>
        s.hl && s.hl.rate8h < entryThreshold && !openAssets.has(s.asset)
      ).sort((a, b) => (a.hl?.rate8h ?? 0) - (b.hl?.rate8h ?? 0))
    } else if (portfolio.strategy_name === 'conservative') {
      const allowedAssets = config.allowed_assets ?? ['BTC', 'ETH']
      const entrySpread = config.enter_spread_threshold ?? config.entry_spread_threshold ?? 0.05
      candidates = allSpreads.filter(s =>
        allowedAssets.includes(s.asset) &&
        s.maxSpread > entrySpread &&
        (s.hl?.rate8h ?? 0) > 0 && // Only short when HL rate is positive (we collect)
        !openAssets.has(s.asset)
      ).sort((a, b) => b.maxSpread - a.maxSpread)
    } else if (portfolio.strategy_name === 'diversified') {
      const topN = config.top_n_by_oi ?? 20
      const entrySpread = config.enter_spread_threshold ?? config.entry_spread_threshold ?? 0.04
      const withOI = allSpreads
        .filter(s => s.hl?.openInterest)
        .sort((a, b) => (b.hl?.openInterest ?? 0) - (a.hl?.openInterest ?? 0))
        .slice(0, topN)
      candidates = withOI.filter(s =>
        s.maxSpread > entrySpread &&
        (s.hl?.rate8h ?? 0) > 0 && // Only short when HL rate is positive (we collect)
        !openAssets.has(s.asset)
      ).sort((a, b) => b.maxSpread - a.maxSpread)
    } else if (portfolio.strategy_name === 'regime_adaptive') {
      // Catches funding on BOTH sides:
      // - HL rate deeply positive (> threshold) → SHORT (shorts collect funding)
      // - HL rate deeply negative (< -threshold) → LONG (longs collect funding)
      // - In between → sit in cash
      const positiveThreshold = config.positive_rate_threshold ?? 0.0003  // +0.03%/8h to go short
      const negativeThreshold = config.negative_rate_threshold ?? -0.0003 // -0.03%/8h to go long

      // Close positions that have moved into neutral territory
      // (handled in exit logic above, regime_adaptive exits when rate crosses zero)

      // Find best short candidates (HL rate positive)
      const shortCandidates = allSpreads.filter(s =>
        s.hl && s.hl.rate8h > positiveThreshold && !openAssets.has(s.asset)
      ).sort((a, b) => (b.hl?.rate8h ?? 0) - (a.hl?.rate8h ?? 0))

      // Find best long candidates (HL rate negative)
      const longCandidates = allSpreads.filter(s =>
        s.hl && s.hl.rate8h < negativeThreshold && !openAssets.has(s.asset)
      ).sort((a, b) => (a.hl?.rate8h ?? 0) - (b.hl?.rate8h ?? 0))

      // Prioritize the more extreme signal — whoever is paying more right now
      const bestShortRate = shortCandidates[0]?.hl?.rate8h ?? 0
      const bestLongRate = Math.abs(longCandidates[0]?.hl?.rate8h ?? 0)

      candidates = bestLongRate >= bestShortRate ? longCandidates : shortCandidates
    } else {
      // aggressive: only enter short_perp when HL rate is positive (collecting funding)
      // negative rates = paying funding = wrong direction for this strategy
      const entrySpread = config.enter_spread_threshold ?? config.entry_spread_threshold ?? 0.03
      candidates = allSpreads.filter(s =>
        s.maxSpread > entrySpread &&
        (s.hl?.rate8h ?? 0) > 0 && // Must be positive to collect as short
        !openAssets.has(s.asset)
      ).sort((a, b) => b.maxSpread - a.maxSpread)
    }

    for (const candidate of candidates) {
      if (remainingPositions.length + positionsToRemove.length >= maxPositions) break // recount
      if (openAssets.size >= maxPositions) break

      const positionSize = Math.min(maxPositionSize, cashBalance - maxPositionSize * TRADING_FEE)
      if (positionSize < 100) break // minimum position

      const fee = positionSize * TRADING_FEE
      if (cashBalance < positionSize + fee) break

      const hlRate = candidate.hl?.rate8h ?? 0
      const side = (portfolio.strategy_name === 'negative_fade' || 
        (portfolio.strategy_name === 'regime_adaptive' && hlRate < 0))
        ? 'long_perp' : 'short_perp'

      // Don't enter a position we already have open in this asset
      const existingPosition = remainingPositions.find(p => p.asset === candidate.asset)
      if (existingPosition) continue

      const entryPrice = candidate.hl?.markPrice ?? null

      const { error: insertErr } = await db.from('paper_positions').insert({
        portfolio_id: portfolio.id,
        asset: candidate.asset,
        side,
        size_usd: positionSize,
        entry_rate_8h: hlRate,
        entry_spread: candidate.maxSpread,
        entry_price: entryPrice,
        total_funding_collected: 0,
        last_funding_collected: now.toISOString(),
        opened_at: now.toISOString(),
        fees_paid: positionSize * TRADING_FEE,
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
