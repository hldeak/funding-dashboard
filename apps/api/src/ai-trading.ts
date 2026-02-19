import { getCachedRates } from './cache'
import type { FundingSpread } from '../../../packages/shared/src/types'

let serviceClient: any = null

async function getServiceClient() {
  if (serviceClient) return serviceClient
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.warn('[AI] SUPABASE_SERVICE_ROLE_KEY not set — AI trading disabled')
    return null
  }
  const { createClient } = await import('@supabase/supabase-js')
  serviceClient = createClient(url, key)
  return serviceClient
}

const TRADING_FEE = 0.0005 // 0.05%
const FUNDING_PERIOD_MS = 60 * 60 * 1000 // 1 hour
const INITIAL_BALANCE = 10000

interface AiTrader {
  id: string
  name: string
  model: string
  emoji: string
  persona: string
  cash_balance: number
  is_active: boolean
}

interface AiPosition {
  id: string
  trader_id: string
  asset: string
  direction: 'long' | 'short'
  size_usd: number
  entry_rate_8h: number
  funding_collected: number
  fees_paid: number
  last_funding_at: string
  is_open: boolean
  opened_at: string
}

interface MarketContext {
  asset: string
  hlRate8h: number
  binanceRate8h: number
  bybitRate8h: number
  okxRate8h: number
  maxSpread: number
  openInterest: number
}

interface Decision {
  action: 'open_long' | 'open_short' | 'close' | 'hold'
  asset?: string
  size_usd?: number
  reasoning: string
}

function buildMarketContext(spreads: FundingSpread[]): MarketContext[] {
  return spreads
    .filter(s => s.hl?.openInterest)
    .sort((a, b) => (b.hl?.openInterest ?? 0) - (a.hl?.openInterest ?? 0))
    .slice(0, 20)
    .map(s => ({
      asset: s.asset,
      hlRate8h: s.hl?.rate8h ?? 0,
      binanceRate8h: s.binance?.rate8h ?? 0,
      bybitRate8h: s.bybit?.rate8h ?? 0,
      okxRate8h: s.okx?.rate8h ?? 0,
      maxSpread: s.maxSpread,
      openInterest: s.hl?.openInterest ?? 0,
    }))
}

function formatMarketTable(ctx: MarketContext[]): string {
  const lines = ['Asset      | HL Rate 8h | Binance   | Bybit     | OKX       | Spread    | OI ($M)']
  lines.push('-'.repeat(90))
  for (const m of ctx) {
    const fmt = (n: number) => (n * 100).toFixed(4).padStart(8) + '%'
    const oi = (m.openInterest / 1e6).toFixed(1).padStart(6) + 'M'
    lines.push(
      `${m.asset.padEnd(10)} | ${fmt(m.hlRate8h)} | ${fmt(m.binanceRate8h)} | ${fmt(m.bybitRate8h)} | ${fmt(m.okxRate8h)} | ${fmt(m.maxSpread)} | ${oi}`
    )
  }
  return lines.join('\n')
}

async function callLLM(trader: AiTrader, systemPrompt: string, userMessage: string): Promise<Decision> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    console.warn('[AI] OPENROUTER_API_KEY not set — defaulting to hold')
    return { action: 'hold', reasoning: 'API key not configured' }
  }

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: trader.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      console.error(`[AI:${trader.name}] LLM API error ${res.status}: ${text}`)
      return { action: 'hold', reasoning: `LLM API error: ${res.status}` }
    }

    const data = await res.json()
    const content = data.choices?.[0]?.message?.content ?? ''

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*?\}/)
    if (!jsonMatch) {
      console.error(`[AI:${trader.name}] No JSON in response: ${content.slice(0, 200)}`)
      return { action: 'hold', reasoning: 'Failed to parse LLM response' }
    }

    const parsed = JSON.parse(jsonMatch[0]) as Decision
    if (!['open_long', 'open_short', 'close', 'hold'].includes(parsed.action)) {
      return { action: 'hold', reasoning: 'Invalid action from LLM' }
    }

    return parsed
  } catch (err: any) {
    console.error(`[AI:${trader.name}] LLM call failed:`, err.message)
    return { action: 'hold', reasoning: `LLM error: ${err.message}` }
  }
}

export async function runAiTraderCycle(traderName: string): Promise<Decision> {
  const db = await getServiceClient()
  if (!db) return { action: 'hold', reasoning: 'DB not configured' }

  // Step 1: Load trader
  const { data: trader, error: tErr } = await db
    .from('ai_traders')
    .select('*')
    .eq('name', traderName)
    .eq('is_active', true)
    .single()

  if (tErr || !trader) {
    throw new Error(`Trader '${traderName}' not found or inactive`)
  }

  const t = trader as AiTrader

  // Load open positions
  const { data: positions } = await db
    .from('ai_positions')
    .select('*')
    .eq('trader_id', t.id)
    .eq('is_open', true)

  const openPositions = (positions ?? []) as AiPosition[]
  let cashBalance = t.cash_balance
  const now = new Date()

  // Step 2: Collect funding on open positions
  const cachedResult = await getCachedRates()
  const spreadsMap = new Map<string, FundingSpread>()
  for (const s of cachedResult.spreads) spreadsMap.set(s.asset, s)

  for (const pos of openPositions) {
    const spread = spreadsMap.get(pos.asset)
    if (!spread?.hl) continue

    const lastCollected = new Date(pos.last_funding_at).getTime()
    const elapsed = now.getTime() - lastCollected
    const periodsElapsed = Math.floor(elapsed / FUNDING_PERIOD_MS)
    if (periodsElapsed <= 0) continue

    const currentRate8h = spread.hl.rate8h
    const hourlyRate = currentRate8h / 8

    // short: positive rate = collect; long: negative rate = collect
    const direction = pos.direction === 'short' ? 1 : -1
    const fundingEarned = pos.size_usd * hourlyRate * periodsElapsed * direction

    if (Math.abs(fundingEarned) < 0.001) continue

    const newFunding = pos.funding_collected + fundingEarned
    const newLastFunding = new Date(lastCollected + periodsElapsed * FUNDING_PERIOD_MS).toISOString()

    await db.from('ai_positions').update({
      funding_collected: newFunding,
      last_funding_at: newLastFunding,
    }).eq('id', pos.id)

    cashBalance += fundingEarned
    pos.funding_collected = newFunding
    pos.last_funding_at = newLastFunding

    if (Math.abs(fundingEarned) > 0.1) {
      console.log(`[AI:${t.name}] ${fundingEarned > 0 ? 'collected' : 'paid'} $${Math.abs(fundingEarned).toFixed(2)} funding on ${pos.asset}`)
    }
  }

  // Step 3: Build market context
  const marketCtx = buildMarketContext(cachedResult.spreads)
  const marketTable = formatMarketTable(marketCtx)

  // Calculate portfolio stats
  const totalPositionValue = openPositions.reduce((s, p) => s + p.size_usd, 0)
  const totalValue = cashBalance + totalPositionValue
  const totalPnl = totalValue - INITIAL_BALANCE
  const totalFundingCollected = openPositions.reduce((s, p) => s + p.funding_collected, 0)

  const positionsStr = openPositions.length === 0
    ? 'None'
    : openPositions.map(p => {
        const spread = spreadsMap.get(p.asset)
        const currentRate = spread?.hl?.rate8h ?? 0
        return `  - ${p.direction.toUpperCase()} ${p.asset}: $${p.size_usd.toFixed(0)}, entry rate: ${(p.entry_rate_8h * 100).toFixed(4)}%, current rate: ${(currentRate * 100).toFixed(4)}%, funding collected: $${p.funding_collected.toFixed(2)}`
      }).join('\n')

  // Step 4: Call LLM
  const systemPrompt = `You are ${t.emoji} ${t.name}, an AI perp trader on Hyperliquid.

Your personality: ${t.persona}

Rules:
- You trade perpetual futures on Hyperliquid using funding rate arbitrage
- Max 3 open positions at once
- Max 30% of portfolio per position
- PRIMARY STRATEGY: funding arb — short when HL rate is POSITIVE (you collect funding payments), long when HL rate is deeply NEGATIVE (longs collect)
- CROSS-EXCHANGE SIGNAL: if HL rate is positive but CEX rates are deeply negative, it means HL longs are overpaying — strong short signal
- POSITION SIZING: use the spread size to size your conviction. 0.01%+ spread = worth trading
- Always explain your reasoning clearly

Your portfolio:
- Cash: $${cashBalance.toFixed(2)}
- Open positions:
${positionsStr}
- Total P&L: $${totalPnl.toFixed(2)}`

  const userMessage = `Current market data (top 20 assets by open interest on Hyperliquid):
${marketTable}

What do you want to do? You must respond with a JSON decision:
{
  "action": "open_long" | "open_short" | "close" | "hold",
  "asset": "BTC",
  "size_usd": 2000,
  "reasoning": "Your explanation here (2-4 sentences max)"
}

If you want to close a position, set action="close" and specify the asset.
If you want to do nothing, set action="hold" with reasoning.
Only one action per turn.`

  const decision = await callLLM(t, systemPrompt, userMessage)

  // Step 5: Execute decision
  if (decision.action === 'open_long' || decision.action === 'open_short') {
    const maxSize = totalValue * 0.3
    let size = Math.min(decision.size_usd ?? maxSize, maxSize)
    const fee = size * TRADING_FEE

    if (openPositions.length >= 3) {
      decision.action = 'hold'
      decision.reasoning = `Wanted to ${decision.action} but already at max 3 positions. ${decision.reasoning}`
    } else if (cashBalance < size + fee) {
      size = Math.max(0, cashBalance - fee)
      if (size < 100) {
        decision.action = 'hold'
        decision.reasoning = `Insufficient cash. ${decision.reasoning}`
      }
    }

    if (decision.action === 'open_long' || decision.action === 'open_short') {
      const asset = decision.asset ?? 'BTC'
      const side = decision.action === 'open_long' ? 'long' : 'short'
      const spread = spreadsMap.get(asset)
      const entryRate = spread?.hl?.rate8h ?? 0
      const fee = size * TRADING_FEE

      await db.from('ai_positions').insert({
        trader_id: t.id,
        asset,
        direction: side,
        size_usd: size,
        entry_rate_8h: entryRate,
        funding_collected: 0,
        fees_paid: fee,
        last_funding_at: now.toISOString(),
        is_open: true,
        opened_at: now.toISOString(),
      })

      cashBalance -= (size + fee)
      console.log(`[AI:${t.name}] opened ${side.toUpperCase()} ${asset} $${size.toFixed(0)} — ${decision.reasoning}`)
    }
  } else if (decision.action === 'close') {
    const asset = decision.asset
    const pos = openPositions.find(p => p.asset === asset)
    if (pos) {
      const fee = pos.size_usd * TRADING_FEE
      const pnl = pos.funding_collected - pos.fees_paid - fee

      await db.from('ai_positions').update({
        is_open: false,
        closed_at: now.toISOString(),
        pnl,
      }).eq('id', pos.id)

      cashBalance += pos.size_usd - fee
      console.log(`[AI:${t.name}] closed ${pos.direction.toUpperCase()} ${asset} $${pos.size_usd.toFixed(0)}, PnL: $${pnl.toFixed(2)} — ${decision.reasoning}`)
    } else {
      decision.action = 'hold'
      decision.reasoning = `Tried to close ${asset} but no open position found. ${decision.reasoning}`
    }
  } else {
    console.log(`[AI:${t.name}] HOLD — ${decision.reasoning}`)
  }

  // Log decision
  await db.from('ai_decisions').insert({
    trader_id: t.id,
    action: decision.action,
    asset: decision.asset ?? null,
    size_usd: decision.size_usd ?? null,
    reasoning: decision.reasoning,
  })

  // Step 6: Update trader
  await db.from('ai_traders').update({
    cash_balance: cashBalance,
    updated_at: now.toISOString(),
  }).eq('id', t.id)

  return decision
}
