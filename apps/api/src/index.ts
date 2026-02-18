import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCachedRates, getCacheAge, getLastFetchTime, getAssetCount, updateCache } from './cache'
import { aggregateRates } from './aggregator'
import { saveSnapshot } from './db'
import { getHistory } from './db'

const app = new Hono()

app.use('*', cors())

app.get('/', (c) => c.json({ status: 'ok', service: 'hldesk-api' }))

app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    lastFetch: getLastFetchTime(),
    assetCount: getAssetCount(),
    cacheAge: getCacheAge(),
  })
})

// History must be before :asset to avoid route conflict
app.get('/api/funding/history', async (c) => {
  const asset = c.req.query('asset')
  const exchange = c.req.query('exchange')
  const from = Number(c.req.query('from') || 0)
  const to = Number(c.req.query('to') || Date.now())
  if (!asset || !exchange) {
    return c.json({ error: 'asset and exchange query params required' }, 400)
  }
  const data = await getHistory(asset, exchange, from, to)
  return c.json(data)
})

app.get('/api/funding/:asset', async (c) => {
  const asset = c.req.param('asset').toUpperCase()
  const result = await getCachedRates()
  const spread = result.spreads.find((s) => s.asset === asset)
  if (!spread) return c.json({ error: 'Asset not found' }, 404)
  return c.json(spread)
})

app.get('/api/funding', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') || 20), 1), 100)
  const result = await getCachedRates()
  return c.json(result.spreads.slice(0, limit))
})

// Background polling — fetch every 30 seconds
async function poll() {
  try {
    const result = await aggregateRates()
    updateCache(result)
    // Fire and forget DB save
    saveSnapshot(result.allRates).catch((err) => console.error('[Poll] DB save error:', err))
  } catch (err) {
    console.error('[Poll] Error:', err)
  }
}

// Initial fetch + recurring
poll()
setInterval(poll, 30_000)

const port = Number(process.env.PORT || 3001)
console.log(`[API] Starting on port ${port}`)

export default {
  port,
  fetch: app.fetch,
}
