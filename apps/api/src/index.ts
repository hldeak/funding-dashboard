import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono()

app.use('*', cors())

app.get('/', (c) => c.json({ status: 'ok', service: 'hldesk-api' }))

// TODO: funding rates endpoint
app.get('/api/funding', async (c) => {
  return c.json({ message: 'coming soon' })
})

export default app
