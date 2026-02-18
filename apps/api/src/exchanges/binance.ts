import type { FundingRate } from '../../../../packages/shared/src/types'

export async function fetchBinance(): Promise<FundingRate[]> {
  const start = Date.now()
  try {
    const res = await fetch('https://api.gateio.ws/api/v4/futures/usdt/contracts?limit=1000&settle=usdt')
    if (!res.ok) throw new Error(`Gate.io ${res.status}`)
    const contracts = (await res.json()) as any[]
    const now = Date.now()

    const rates: FundingRate[] = contracts
      .filter((c: any) => c.name?.endsWith('_USDT') && !c.in_delisting)
      .map((c: any) => ({
        asset: c.name.replace('_USDT', ''),
        exchange: 'binance' as const,
        rate8h: parseFloat(c.funding_rate || c.funding_rate_indicative || '0'),
        rateRaw: parseFloat(c.funding_rate || c.funding_rate_indicative || '0'),
        nextFundingTime: (c.funding_next_apply || 0) * 1000,
        openInterest: parseFloat(c.total_size || '0'),
        timestamp: now,
      }))

    console.log(`[Gate.io] Fetched ${rates.length} assets in ${Date.now() - start}ms`)
    return rates
  } catch (err) {
    console.error(`[Gate.io] Error after ${Date.now() - start}ms:`, err)
    throw err
  }
}
