import type { FundingRate } from '../../../packages/shared/src/types'

/*
CREATE TABLE funding_snapshots (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  asset TEXT NOT NULL,
  exchange TEXT NOT NULL,
  rate_8h DOUBLE PRECISION NOT NULL,
  rate_raw DOUBLE PRECISION NOT NULL,
  open_interest DOUBLE PRECISION,
  next_funding_time BIGINT
);

CREATE INDEX idx_funding_snapshots_asset_time ON funding_snapshots(asset, timestamp DESC);
CREATE INDEX idx_funding_snapshots_exchange_time ON funding_snapshots(exchange, timestamp DESC);
*/

let supabase: any = null

async function getClient() {
  if (supabase !== undefined && supabase !== null) return supabase
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) {
    console.warn('[DB] SUPABASE_URL or SUPABASE_ANON_KEY not set — DB disabled')
    supabase = null
    return null
  }
  const { createClient } = await import('@supabase/supabase-js')
  supabase = createClient(url, key)
  return supabase
}

export async function saveSnapshot(rates: FundingRate[]): Promise<void> {
  const client = await getClient()
  if (!client || rates.length === 0) return

  const rows = rates.map((r) => ({
    asset: r.asset,
    exchange: r.exchange,
    rate_8h: r.rate8h,
    rate_raw: r.rateRaw,
    open_interest: r.openInterest ?? null,
    next_funding_time: r.nextFundingTime,
  }))

  // Bulk insert in chunks of 500
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await client.from('funding_snapshots').insert(rows.slice(i, i + 500))
    if (error) console.error('[DB] Insert error:', error.message)
  }
}

export async function getHistory(
  asset: string,
  exchange: string,
  from: number,
  to: number
): Promise<any[]> {
  const client = await getClient()
  if (!client) return []

  const { data, error } = await client
    .from('funding_snapshots')
    .select('*')
    .eq('asset', asset)
    .eq('exchange', exchange)
    .gte('timestamp', new Date(from).toISOString())
    .lte('timestamp', new Date(to).toISOString())
    .order('timestamp', { ascending: false })
    .limit(1000)

  if (error) {
    console.error('[DB] Query error:', error.message)
    return []
  }
  return data ?? []
}
