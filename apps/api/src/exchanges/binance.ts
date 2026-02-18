// NOTE: Binance geo-blocks non-US IPs from restricted regions.
// Replaced with Gate.io which has equivalent coverage and no geo-restrictions.
import type { FundingRate } from '../../../../packages/shared/src/types'

export async function fetchBinance(): Promise<FundingRate[]> {
  const start = Date.now()
  try {
    // Gate.io: get all USDT perpetual contracts with current funding rate
    const res = await fetch('https://api.gateio.ws/api/v4/futures/usdt/contracts?limit=1000')
    if (!res.ok) throw new Error(`Gate.io contracts ${res.status}`)
    const contracts = (await res.json()) as any[]

    // Filter to active contracts with funding data
    const rates: FundingRate[] = contracts
      .filter((c: any) => c.funding_rate !== undefined && c.name.endsWith('_USDT'))
      .map((c: any) => {
        const rate8h = parseFloat(c.funding_rate) * 8 // Gate.io rate is per funding interval (~8h already)
        const asset = c.name.replace('_USDT', '')
        return {
          asset,
          exchange: 'binance' as const, // displayed as "Gate.io" via label in frontend
          rate8h,
          rateRaw: parseFloat(c.funding_rate),
          nextFundingTime: (c.funding_next_apply || 0) * 1000,
          openInterest: parseFloat(c.total_size || '0'),
          timestamp: Date.now(),
        }
      })

    console.log(`[Gate.io] Fetched ${rates.length} assets in ${Date.now() - start}ms`)
    return rates
  } catch (err) {
    console.error(`[Gate.io] Error after ${Date.now() - start}ms:`, err)
    throw err
  }
}
