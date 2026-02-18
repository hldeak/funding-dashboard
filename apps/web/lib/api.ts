import { FundingSpread } from './types'

const BASE = process.env.NEXT_PUBLIC_API_URL || ''

export async function fetchFunding(limit = 100): Promise<FundingSpread[]> {
  const res = await fetch(`${BASE}/api/funding?limit=${limit}`, { cache: 'no-store' })
  if (!res.ok) throw new Error('Failed to fetch funding data')
  return res.json()
}

export async function fetchAsset(symbol: string): Promise<FundingSpread> {
  const res = await fetch(`${BASE}/api/funding/${symbol}`, { cache: 'no-store' })
  if (!res.ok) throw new Error('Failed to fetch asset data')
  return res.json()
}
