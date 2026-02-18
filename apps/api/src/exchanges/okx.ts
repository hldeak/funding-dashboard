import type { FundingRate } from '../../../../packages/shared/src/types'

export async function fetchOkx(): Promise<FundingRate[]> {
  const start = Date.now()
  try {
    // First get all SWAP instruments to know which ones exist
    const instRes = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP')
    if (!instRes.ok) throw new Error(`OKX instruments API ${instRes.status}`)
    const instData = await instRes.json()
    const instruments = (instData.data as any[]).filter((i) => i.instId.endsWith('-USDT-SWAP'))

    // Batch fetch funding rates — OKX doesn't have a bulk endpoint,
    // so we fetch them in parallel with concurrency limit
    const BATCH_SIZE = 20
    const now = Date.now()
    const rates: FundingRate[] = []

    for (let i = 0; i < instruments.length; i += BATCH_SIZE) {
      const batch = instruments.slice(i, i + BATCH_SIZE)
      const results = await Promise.allSettled(
        batch.map(async (inst: any) => {
          const res = await fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${inst.instId}`)
          if (!res.ok) return null
          const data = await res.json()
          const fr = data.data?.[0]
          if (!fr) return null
          const rate8h = parseFloat(fr.fundingRate)
          return {
            asset: inst.instId.split('-')[0], // BTC-USDT-SWAP → BTC
            exchange: 'okx' as const,
            rate8h,
            rateRaw: rate8h,
            nextFundingTime: Number(fr.nextFundingTime) || now + 3600000,
            timestamp: now,
          } as FundingRate
        })
      )
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) rates.push(r.value)
      }
    }

    console.log(`[OKX] Fetched ${rates.length} assets in ${Date.now() - start}ms`)
    return rates
  } catch (err) {
    console.error(`[OKX] Error after ${Date.now() - start}ms:`, err)
    throw err
  }
}
