import type { FundingRate, FundingSpread } from '../../../packages/shared/src/types'
import { fetchHyperliquid } from './exchanges/hyperliquid'
import { fetchBinance } from './exchanges/binance'
import { fetchBybit } from './exchanges/bybit'
import { fetchOkx } from './exchanges/okx'

type ExchangeName = 'hyperliquid' | 'binance' | 'bybit' | 'okx'

export interface AggregatedResult {
  spreads: FundingSpread[]
  allRates: FundingRate[]
  timestamp: number
}

export async function aggregateRates(): Promise<AggregatedResult> {
  const start = Date.now()

  const [hlResult, binanceResult, bybitResult, okxResult] = await Promise.allSettled([
    fetchHyperliquid(),
    fetchBinance(),
    fetchBybit(),
    fetchOkx(),
  ])

  const hlRates = hlResult.status === 'fulfilled' ? hlResult.value : null
  const binanceRates = binanceResult.status === 'fulfilled' ? binanceResult.value : null
  const bybitRates = bybitResult.status === 'fulfilled' ? bybitResult.value : null
  const okxRates = okxResult.status === 'fulfilled' ? okxResult.value : null

  if (!hlRates) {
    console.error('[Aggregator] Hyperliquid failed — cannot build spreads')
    return { spreads: [], allRates: [], timestamp: Date.now() }
  }

  // Index CEX rates by asset
  const index = (rates: FundingRate[] | null): Map<string, FundingRate> => {
    const m = new Map<string, FundingRate>()
    if (!rates) return m
    for (const r of rates) m.set(r.asset, r)
    return m
  }

  const binMap = index(binanceRates)
  const bybitMap = index(bybitRates)
  const okxMap = index(okxRates)

  // Build spreads — HL is source of truth for which assets exist
  const spreads: FundingSpread[] = hlRates.map((hl) => {
    const bin = binMap.get(hl.asset) ?? null
    const byb = bybitMap.get(hl.asset) ?? null
    const okx = okxMap.get(hl.asset) ?? null

    // Find best (highest) CEX rate to compute spread
    const cexRates: { name: string; rate: number }[] = []
    if (bin) cexRates.push({ name: 'binance', rate: bin.rate8h })
    if (byb) cexRates.push({ name: 'bybit', rate: byb.rate8h })
    if (okx) cexRates.push({ name: 'okx', rate: okx.rate8h })

    let bestCex = 'none'
    let bestCexRate = 0
    if (cexRates.length > 0) {
      const best = cexRates.reduce((a, b) => (Math.abs(b.rate) > Math.abs(a.rate) ? b : a))
      bestCex = best.name
      bestCexRate = best.rate
    }

    return {
      asset: hl.asset,
      hl,
      binance: bin,
      bybit: byb,
      okx: okx,
      maxSpread: hl.rate8h - bestCexRate,
      bestCex,
    }
  })

  // Sort by absolute maxSpread descending (biggest opportunities first)
  spreads.sort((a, b) => Math.abs(b.maxSpread) - Math.abs(a.maxSpread))

  // Collect all rates for DB storage
  const allRates: FundingRate[] = [
    ...hlRates,
    ...(binanceRates ?? []),
    ...(bybitRates ?? []),
    ...(okxRates ?? []),
  ]

  console.log(`[Aggregator] Done in ${Date.now() - start}ms — ${spreads.length} assets`)
  return { spreads, allRates, timestamp: Date.now() }
}
