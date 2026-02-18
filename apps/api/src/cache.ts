import type { AggregatedResult } from './aggregator'
import { aggregateRates } from './aggregator'

const CACHE_TTL_MS = 30_000

let cached: AggregatedResult | null = null
let cachedAt = 0

export function getCacheAge(): number {
  return cached ? Date.now() - cachedAt : -1
}

export async function getCachedRates(): Promise<AggregatedResult> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cached
  }
  const result = await aggregateRates()
  cached = result
  cachedAt = Date.now()
  return result
}

export function updateCache(result: AggregatedResult) {
  cached = result
  cachedAt = Date.now()
}

export function invalidateCache() {
  cached = null
  cachedAt = 0
}

export function getLastFetchTime(): number {
  return cachedAt
}

export function getAssetCount(): number {
  return cached?.spreads.length ?? 0
}
