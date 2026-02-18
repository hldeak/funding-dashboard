import type { FundingRate } from '../../../../packages/shared/src/types'

export async function fetchBybit(): Promise<FundingRate[]> {
  const start = Date.now()
  try {
    const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear')
    if (!res.ok) throw new Error(`Bybit API ${res.status}`)
    const data = await res.json()
    const list = data.result?.list as any[]
    if (!list) throw new Error('Bybit: no result.list')
    const now = Date.now()

    const rates: FundingRate[] = list
      .filter((t) => t.symbol.endsWith('USDT'))
      .map((t) => {
        const rate8h = parseFloat(t.fundingRate)
        return {
          asset: t.symbol.replace('USDT', ''),
          exchange: 'bybit' as const,
          rate8h,
          rateRaw: rate8h,
          nextFundingTime: Number(t.nextFundingTime) || now + 3600000,
          openInterest: parseFloat(t.openInterest) || undefined,
          timestamp: now,
        }
      })

    console.log(`[Bybit] Fetched ${rates.length} assets in ${Date.now() - start}ms`)
    return rates
  } catch (err) {
    console.error(`[Bybit] Error after ${Date.now() - start}ms:`, err)
    throw err
  }
}
