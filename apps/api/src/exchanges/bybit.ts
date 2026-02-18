// NOTE: Bybit geo-blocks from restricted regions.
// Replaced with Bitget which has equivalent coverage and no geo-restrictions.
import type { FundingRate } from '../../../../packages/shared/src/types'

export async function fetchBybit(): Promise<FundingRate[]> {
  const start = Date.now()
  try {
    const res = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES')
    if (!res.ok) throw new Error(`Bitget API ${res.status}`)
    const json = (await res.json()) as any
    const data = json.data as any[]
    const now = Date.now()

    const rates: FundingRate[] = data
      .filter((s: any) => s.symbol.endsWith('USDT') && s.fundingRate !== undefined)
      .map((s: any) => {
        const rate8h = parseFloat(s.fundingRate) * 8 // Bitget rate is per 8h period
        return {
          asset: s.symbol.replace('USDT', ''),
          exchange: 'bybit' as const, // displayed as "Bitget" via label in frontend
          rate8h,
          rateRaw: parseFloat(s.fundingRate),
          nextFundingTime: parseInt(s.nextFundingTime || '0'),
          openInterest: parseFloat(s.openInterest || '0'),
          timestamp: now,
        }
      })

    console.log(`[Bitget] Fetched ${rates.length} assets in ${Date.now() - start}ms`)
    return rates
  } catch (err) {
    console.error(`[Bitget] Error after ${Date.now() - start}ms:`, err)
    throw err
  }
}
