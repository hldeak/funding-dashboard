import type { FundingRate } from '../../../../packages/shared/src/types'

export async function fetchBinance(): Promise<FundingRate[]> {
  const start = Date.now()
  try {
    const res = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex')
    if (!res.ok) throw new Error(`Binance API ${res.status}`)
    const data = (await res.json()) as any[]
    const now = Date.now()

    const rates: FundingRate[] = data
      .filter((s) => s.symbol.endsWith('USDT'))
      .map((s) => {
        const rate8h = parseFloat(s.lastFundingRate)
        return {
          asset: s.symbol.replace('USDT', ''),
          exchange: 'binance' as const,
          rate8h,
          rateRaw: rate8h,
          nextFundingTime: Number(s.nextFundingTime),
          timestamp: now,
        }
      })

    console.log(`[Binance] Fetched ${rates.length} assets in ${Date.now() - start}ms`)
    return rates
  } catch (err) {
    console.error(`[Binance] Error after ${Date.now() - start}ms:`, err)
    throw err
  }
}
