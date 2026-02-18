import type { FundingRate } from '../../../../packages/shared/src/types'

export async function fetchHyperliquid(): Promise<FundingRate[]> {
  const start = Date.now()
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    })
    if (!res.ok) throw new Error(`HL API ${res.status}`)
    const data = await res.json()
    const [meta, assetCtxs] = data as [{ universe: { name: string }[] }, any[]]
    const now = Date.now()

    const rates: FundingRate[] = meta.universe.map((asset, i) => {
      const ctx = assetCtxs[i]
      const rateRaw = parseFloat(ctx.funding)
      return {
        asset: asset.name,
        exchange: 'hyperliquid' as const,
        rateRaw,
        rate8h: rateRaw * 8, // hourly → 8h equivalent
        nextFundingTime: ctx.nextFundingTime ? Number(ctx.nextFundingTime) : now + 3600000,
        openInterest: parseFloat(ctx.openInterest) || undefined,
        timestamp: now,
      }
    })

    console.log(`[HL] Fetched ${rates.length} assets in ${Date.now() - start}ms`)
    return rates
  } catch (err) {
    console.error(`[HL] Error after ${Date.now() - start}ms:`, err)
    throw err
  }
}
