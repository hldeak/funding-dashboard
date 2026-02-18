import type { FundingRate } from '../../../../packages/shared/src/types'

export async function fetchBinance(): Promise<FundingRate[]> {
  const start = Date.now()
  try {
    const res = await fetch('https://contract.mexc.com/api/v1/contract/detail')
    if (!res.ok) throw new Error(`MEXC ${res.status}`)
    const json = (await res.json()) as any
    const contracts = json.data as any[]
    const now = Date.now()

    // MEXC per-contract funding rates are in a separate endpoint - use bulk funding rates
    const ratesRes = await fetch('https://contract.mexc.com/api/v1/contract/funding_rate')
    if (!ratesRes.ok) throw new Error(`MEXC funding rates ${ratesRes.status}`)
    const ratesJson = (await ratesRes.json()) as any
    const fundingMap = new Map<string, number>()
    for (const r of (ratesJson.data || [])) {
      fundingMap.set(r.symbol, parseFloat(r.fundingRate))
    }

    const rates: FundingRate[] = contracts
      .filter((c: any) => c.symbol?.endsWith('_USDT') && fundingMap.has(c.symbol))
      .map((c: any) => {
        const rate8h = (fundingMap.get(c.symbol) || 0) * 8
        return {
          asset: c.symbol.replace('_USDT', ''),
          exchange: 'binance' as const,
          rate8h,
          rateRaw: fundingMap.get(c.symbol) || 0,
          nextFundingTime: c.nextSettleTime || 0,
          openInterest: parseFloat(c.holdVol || '0'),
          timestamp: now,
        }
      })

    console.log(`[MEXC] Fetched ${rates.length} assets in ${Date.now() - start}ms`)
    return rates
  } catch (err) {
    console.error(`[MEXC] Error after ${Date.now() - start}ms:`, err)
    throw err
  }
}
