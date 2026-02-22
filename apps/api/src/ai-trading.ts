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
const STOP_LOSS_PCT = 0.15 // 15% hard stop for all AI traders
const LLM_TIMEOUT_MS = 45_000 // 45 second timeout for LLM calls

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
  entry_price_approx: number | null
  funding_collected: number
  fees_paid: number
  last_funding_at: string
  is_open: boolean
  opened_at: string
}

interface MarketContext {
  asset: string
  hlRate8h: number
  mexcRate8h: number
  bitgetRate8h: number
  okxRate8h: number
  maxSpread: number
  openInterest: number
  markPrice: number | null
  change24h: number | null
  volume24h: number | null
}

interface Decision {
  action: 'open_long' | 'open_short' | 'close' | 'hold'
  asset?: string
  size_usd?: number
  reasoning: string
}

/** Persona-specific system prompts for each trader */
const TRADER_PROMPTS: Record<string, (name: string, emoji: string, persona: string) => string> = {
  Opus: (name, emoji, persona) => `You are ${emoji} ${name}, a perp trader on Hyperliquid with $10,000.

Your style: ${persona}

You have access to:
- Current mark price and 24h price change for each asset
- 24h trading volume (proxy for interest/momentum)
- Open interest (proxy for crowding)
- Funding rates across exchanges (sentiment signal — positive HL funding means longs are crowded and paying a premium)

Your edge is MACRO THESIS + NARRATIVE. You ask: "Why is the crowd positioned this way? Is the thesis played out or just beginning?" You look for confluence between on-chain narratives, momentum, and crowd positioning. Funding rate tells you how crowded the trade is — use it to validate or fade conviction.

IMPORTANT: Your edge is DIRECTIONAL JUDGMENT, not funding collection. Funding is a sentiment signal to inform your view, not the reason to trade.

Rules:
- Max 3 open positions, max 30% per position
- You can go long or short
- Size your positions based on conviction — scale up when macro + momentum + funding all agree
- When closing, explain what changed in your thesis`,

  Flash: (name, emoji, persona) => `You are ${emoji} ${name}, a perp trader on Hyperliquid with $10,000.

Your style: ${persona}

You have access to:
- Current mark price and 24h price change for each asset
- 24h trading volume (proxy for interest/momentum)
- Open interest (proxy for crowding)
- Funding rates across exchanges (sentiment signal — positive HL funding means longs are crowded)

Your edge is MOMENTUM + BREAKOUT. You follow price action and volume. A big 24h move with volume confirms a breakout — you ride it. Funding and OI are confirmation: if a breakout has elevated funding, the crowd is also following, which can sustain the move. You enter fast and cut losses quickly if momentum stalls.

IMPORTANT: Your edge is DIRECTIONAL JUDGMENT, not funding collection. Funding is a confirmation signal, not the primary reason to trade.

Rules:
- Max 3 open positions, max 30% per position
- You can go long or short
- Favor assets with strong 24h momentum and volume
- Quick to close if price action reverses`,

  DeepSeek: (name, emoji, persona) => `You are ${emoji} ${name}, a perp trader on Hyperliquid with $10,000.

Your style: ${persona}

You have access to:
- Current mark price and 24h price change for each asset
- 24h trading volume (proxy for interest/momentum)
- Open interest (proxy for crowding)
- Funding rates across exchanges (sentiment signal — positive HL funding means longs are crowded and overpaying)

Your edge is CONTRARIAN MEAN REVERSION. You fade crowded, extended moves. High positive funding + asset up 20%+ = the longs are over-levered, fade them. Very negative funding + asset down 20%+ = shorts are piled in, fade them. You look for extremes where the crowd is one-sided and exhausted.

IMPORTANT: Your edge is DIRECTIONAL JUDGMENT, not funding collection. Funding is your primary crowding signal — but you need BOTH crowded positioning AND extended price to confirm a fade opportunity.

Rules:
- Max 3 open positions, max 30% per position
- You can go long or short
- Best setups: extreme funding (>0.04% or <-0.03%) + price already moved significantly
- Close when price reverts or funding normalizes`,

  Sonnet: (name, emoji, persona) => `You are ${emoji} ${name}, a perp trader on Hyperliquid with $10,000.

Your style: ${persona}

You have access to:
- Current mark price and 24h price change for each asset
- 24h trading volume (proxy for interest/momentum)
- Open interest (proxy for crowding)
- Funding rates across exchanges (sentiment signal — positive HL funding means longs are crowded)

Your edge is RISK-ADJUSTED CONVICTION. You only trade when the reward clearly outweighs the risk. You think about: what's my edge here? How likely is this to work? What's my stop? You'd rather hold cash and wait for a fat pitch than force a mediocre setup. When you do trade, you size based on conviction.

IMPORTANT: Your edge is DIRECTIONAL JUDGMENT, not funding collection. Funding is one input — but only trade if you have a clear directional view with an identifiable catalyst or setup.

Rules:
- Max 3 open positions, max 30% per position
- You can go long or short
- Only trade when risk/reward is clearly in your favor
- Conservative sizing unless conviction is very high
- Holding cash is a valid and often correct decision`,
}

function getTraderSystemPrompt(trader: AiTrader): string {
  const promptFn = TRADER_PROMPTS[trader.name]
  if (promptFn) return promptFn(trader.name, trader.emoji, trader.persona)

  // Generic fallback
  return `You are ${trader.emoji} ${trader.name}, a perp trader on Hyperliquid with $10,000.

Your style: ${trader.persona}

You have access to:
- Current mark price and 24h price change for each asset
- 24h trading volume (proxy for interest/momentum)
- Open interest (proxy for crowding)
- Funding rates across exchanges (sentiment signal — positive HL funding means longs are crowded and paying a premium)

Make ONE trading decision. Your edge is DIRECTIONAL JUDGMENT, not funding collection. Funding is a sentiment signal to inform your view.

Rules:
- Max 3 open positions, max 30% per position
- You can go long or short
- Size your positions based on conviction`
}

function buildMarketContext(spreads: FundingSpread[]): MarketContext[] {
  return spreads
    .filter(s => s.hl?.openInterest)
    .sort((a, b) => (b.hl?.openInterest ?? 0) - (a.hl?.openInterest ?? 0))
    .slice(0, 20)
    .map(s => {
      // CEX avg rate from available exchanges (excluding binance which often has different data)
      const cexRates = [s.mexc?.rate8h, s.bitget?.rate8h, s.okx?.rate8h].filter((r): r is number => r != null)
      return {
        asset: s.asset,
        hlRate8h: s.hl?.rate8h ?? 0,
        mexcRate8h: s.mexc?.rate8h ?? 0,
        bitgetRate8h: s.bitget?.rate8h ?? 0,
        okxRate8h: s.okx?.rate8h ?? 0,
        cexAvgRate8h: cexRates.length > 0 ? cexRates.reduce((a, b) => a + b, 0) / cexRates.length : 0,
        maxSpread: s.maxSpread,
        openInterest: s.hl?.openInterest ?? 0,
        markPrice: s.hl?.markPrice ?? null,
        change24h: s.hl?.change24h ?? null,
        volume24h: s.hl?.volume24h ?? null,
      } as MarketContext & { cexAvgRate8h: number }
    })
}

function formatMarketTable(ctx: (MarketContext & { cexAvgRate8h?: number })[]): string {
  const lines = ['Asset      | Price      | 24h Chg  | Volume24h | OI($M)  | HL Rate  | CEX Avg  | Spread']
  lines.push('-'.repeat(100))
  for (const m of ctx) {
    const fmtRate = (n: number) => (n * 100).toFixed(4).padStart(8) + '%'
    const price = m.markPrice != null
      ? `$${m.markPrice < 1 ? m.markPrice.toFixed(5) : m.markPrice.toFixed(2)}`.padStart(10)
      : '       N/A'
    const chg = m.change24h != null
      ? `${m.change24h >= 0 ? '+' : ''}${m.change24h.toFixed(2)}%`.padStart(8)
      : '     N/A'
    const oi = (m.openInterest / 1e6).toFixed(1).padStart(6) + 'M'
    const vol = m.volume24h != null ? (m.volume24h / 1e6).toFixed(1).padStart(7) + 'M' : '    N/A'
    const cexAvg = (m as any).cexAvgRate8h != null ? fmtRate((m as any).cexAvgRate8h) : '      N/A'
    lines.push(
      `${m.asset.padEnd(10)} | ${price} | ${chg} | ${vol} | ${oi} | ${fmtRate(m.hlRate8h)} | ${cexAvg} | ${fmtRate(m.maxSpread)}`
    )
  }
  return lines.join('\n')
}

// BUG 5 FIX: Timeout wrapper for LLM calls
async function callLLMWithTimeout(
  trader: AiTrader,
  systemPrompt: string,
  userMessage: string,
  timeoutMs: number
): Promise<{ content: string; timedOut: boolean }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      return { content: '', timedOut: false }
    }

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
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!res.ok) {
      const text = await res.text()
      console.error(`[AI:${trader.name}] LLM API error ${res.status}: ${text}`)
      return { content: '', timedOut: false }
    }

    const data = await res.json()
    const content = data.choices?.[0]?.message?.content ?? ''
    return { content, timedOut: false }
  } catch (err: any) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      return { content: '', timedOut: true }
    }
    throw err
  }
}

async function callLLM(trader: AiTrader, systemPrompt: string, userMessage: string): Promise<Decision> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    console.warn('[AI] OPENROUTER_API_KEY not set — defaulting to hold')
    return { action: 'hold', reasoning: 'API key not configured' }
  }

  // BUG 5 FIX: Try with timeout, retry once on timeout
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { content, timedOut } = await callLLMWithTimeout(trader, systemPrompt, userMessage, LLM_TIMEOUT_MS)

      if (timedOut) {
        console.warn(`[AI:${trader.name}] LLM timed out after ${LLM_TIMEOUT_MS / 1000}s (attempt ${attempt}/2)`)
        if (attempt < 2) {
          console.log(`[AI:${trader.name}] Retrying LLM call...`)
          continue
        }
        return { action: 'hold', reasoning: `LLM timed out after ${LLM_TIMEOUT_MS / 1000}s — holding` }
      }

      if (!content) {
        return { action: 'hold', reasoning: 'LLM returned empty response' }
      }

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
      console.error(`[AI:${trader.name}] LLM call failed (attempt ${attempt}/2):`, err.message)
      if (attempt < 2) {
        console.log(`[AI:${trader.name}] Retrying after error...`)
        continue
      }
      return { action: 'hold', reasoning: `LLM error: ${err.message}` }
    }
  }

  return { action: 'hold', reasoning: 'LLM failed after retries' }
}

/** Compute unrealized P&L for a position given current mark price */
function computeUnrealizedPnl(pos: AiPosition, currentPrice: number | null): number {
  if (!currentPrice || !pos.entry_price_approx) return 0
  if (pos.direction === 'long') {
    return (currentPrice - pos.entry_price_approx) / pos.entry_price_approx * pos.size_usd
  } else {
    return (pos.entry_price_approx - currentPrice) / pos.entry_price_approx * pos.size_usd
  }
}

/** Close a position: compute P&L, update DB, return cash received */
async function closePosition(
  db: any,
  pos: AiPosition,
  currentRates: Map<string, { markPrice: number | null }>,
  now: Date,
  reason: string
): Promise<number> {
  const exitPrice = currentRates.get(pos.asset)?.markPrice ?? null
  const unrealizedPnl = computeUnrealizedPnl(pos, exitPrice)
  const exitFee = pos.size_usd * TRADING_FEE

  // BUG 2 FIX: Realized P&L = price move + funding collected - entry fee - exit fee
  const realizedPnl = unrealizedPnl + (pos.funding_collected ?? 0) - pos.fees_paid - exitFee

  await db.from('ai_positions').update({
    is_open: false,
    pnl: realizedPnl,
    closed_at: now.toISOString(),
  }).eq('id', pos.id)

  // BUG 2 FIX: Cash return = size + price return - exit fee only
  // Funding was already credited to cash_balance during collection — do NOT add it again here
  const cashReturn = pos.size_usd + unrealizedPnl - exitFee

  console.log(
    `[AI] Closed ${pos.direction.toUpperCase()} ${pos.asset} $${pos.size_usd.toFixed(0)}: ` +
    `price PnL=$${unrealizedPnl.toFixed(2)}, funding=$${(pos.funding_collected ?? 0).toFixed(2)}, ` +
    `fees=$${(pos.fees_paid + exitFee).toFixed(2)}, realized=$${realizedPnl.toFixed(2)} — ${reason}`
  )

  return cashReturn
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

  // Step 2: Collect funding on open positions + BUG 4 FIX: check stop losses
  const cachedResult = await getCachedRates()
  const spreadsMap = new Map<string, FundingSpread>()
  for (const s of cachedResult.spreads) spreadsMap.set(s.asset, s)

  // Build a map of current prices for stop loss checks and position closing
  const currentPriceMap = new Map<string, { markPrice: number | null }>()
  for (const s of cachedResult.spreads) {
    currentPriceMap.set(s.asset, { markPrice: s.hl?.markPrice ?? null })
  }

  // Track positions closed by stop loss so we don't process them further
  const stopLossClosedIds = new Set<string>()

  for (const pos of openPositions) {
    const spread = spreadsMap.get(pos.asset)
    if (!spread?.hl) continue

    // Collect funding
    const lastCollected = new Date(pos.last_funding_at).getTime()
    const elapsed = now.getTime() - lastCollected
    const periodsElapsed = Math.floor(elapsed / FUNDING_PERIOD_MS)
    if (periodsElapsed > 0) {
      const currentRate8h = spread.hl.rate8h
      const hourlyRate = currentRate8h / 8

      // short: positive rate = collect; long: negative rate = collect
      const direction = pos.direction === 'short' ? 1 : -1
      const fundingEarned = pos.size_usd * hourlyRate * periodsElapsed * direction

      if (Math.abs(fundingEarned) >= 0.001) {
        const newFunding = pos.funding_collected + fundingEarned
        const newLastFunding = new Date(lastCollected + periodsElapsed * FUNDING_PERIOD_MS).toISOString()

        await db.from('ai_positions').update({
          funding_collected: newFunding,
          last_funding_at: newLastFunding,
        }).eq('id', pos.id)

        // Funding properly credited to cash once here — NOT again on close
        cashBalance += fundingEarned
        pos.funding_collected = newFunding
        pos.last_funding_at = newLastFunding

        if (Math.abs(fundingEarned) > 0.1) {
          console.log(`[AI:${t.name}] ${fundingEarned > 0 ? 'collected' : 'paid'} $${Math.abs(fundingEarned).toFixed(2)} funding on ${pos.asset}`)
        }
      }
    }

    // BUG 4 FIX: Stop loss check
    const entryPrice = pos.entry_price_approx
    const currentPrice = spread.hl.markPrice ?? null
    if (entryPrice && currentPrice && entryPrice > 0) {
      let unrealizedPct = 0
      if (pos.direction === 'long') {
        unrealizedPct = (currentPrice - entryPrice) / entryPrice
      } else {
        unrealizedPct = (entryPrice - currentPrice) / entryPrice
      }

      if (unrealizedPct < -STOP_LOSS_PCT) {
        console.log(
          `[AI:${t.name}] STOP LOSS triggered: ${pos.direction.toUpperCase()} ${pos.asset} ` +
          `at ${(unrealizedPct * 100).toFixed(2)}% (limit: -${(STOP_LOSS_PCT * 100).toFixed(0)}%)`
        )
        const cashReturn = await closePosition(db, pos, currentPriceMap, now, `Stop loss at ${(unrealizedPct * 100).toFixed(2)}%`)
        cashBalance += cashReturn
        stopLossClosedIds.add(pos.id)

        // Log the stop loss as a decision
        await db.from('ai_decisions').insert({
          trader_id: t.id,
          action: 'close',
          asset: pos.asset,
          size_usd: pos.size_usd,
          reasoning: `STOP LOSS: ${pos.direction.toUpperCase()} ${pos.asset} hit ${(unrealizedPct * 100).toFixed(2)}% loss (${STOP_LOSS_PCT * 100}% limit)`,
        })
      }
    }
  }

  // Filter out stop-loss-closed positions from further processing
  const remainingPositions = openPositions.filter(p => !stopLossClosedIds.has(p.id))

  // Step 3: Build market context
  const marketCtx = buildMarketContext(cachedResult.spreads)
  const marketTable = formatMarketTable(marketCtx)

  // BUG 1 FIX: Calculate portfolio stats correctly — do NOT add funding_collected to position value
  // (funding is already in cashBalance from the collection step above)
  const totalPositionValue = remainingPositions.reduce((s, p) => {
    const spread = spreadsMap.get(p.asset)
    const currentPrice = spread?.hl?.markPrice ?? null
    // Only price-based unrealized P&L — funding already in cashBalance
    const unrealizedPricePnl = computeUnrealizedPnl(p, currentPrice)
    return s + p.size_usd + unrealizedPricePnl
  }, 0)
  const totalValue = cashBalance + totalPositionValue
  const totalPnl = totalValue - INITIAL_BALANCE

  const positionsStr = remainingPositions.length === 0
    ? 'None'
    : remainingPositions.map(p => {
        const spread = spreadsMap.get(p.asset)
        const currentPrice = spread?.hl?.markPrice ?? null
        const unrealizedPnl = computeUnrealizedPnl(p, currentPrice)
        const currentRate = spread?.hl?.rate8h ?? 0
        const entryPriceStr = p.entry_price_approx != null ? `$${p.entry_price_approx.toFixed(p.entry_price_approx < 1 ? 5 : 2)}` : 'N/A'
        const currentPriceStr = currentPrice != null ? `$${currentPrice.toFixed(currentPrice < 1 ? 5 : 2)}` : 'N/A'
        return `  - ${p.direction.toUpperCase()} ${p.asset}: $${p.size_usd.toFixed(0)} | Entry: ${entryPriceStr} → Now: ${currentPriceStr} | Unrealized PnL: $${unrealizedPnl.toFixed(2)} | Funding: $${p.funding_collected.toFixed(2)} | HL Rate now: ${(currentRate * 100).toFixed(4)}%`
      }).join('\n')

  // Step 4: Call LLM
  const systemPrompt = getTraderSystemPrompt(t)

  const userMessage = `Current market data (top 20 assets by open interest on Hyperliquid):
${marketTable}

Your portfolio:
- Cash available: $${cashBalance.toFixed(2)}
- Total value (mark-to-market): $${totalValue.toFixed(2)}
- Total P&L: $${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
- Open positions:
${positionsStr}

Analyze the market from your trading style's perspective. Look at price action and momentum first — what is the market telling you? Use funding rates and OI as secondary context to understand crowd positioning.

Respond with a single JSON decision:
{
  "action": "open_long" | "open_short" | "close" | "hold",
  "asset": "BTC",
  "size_usd": 2500,
  "reasoning": "Describe your directional view and what the data is telling you. Reference price action, volume, and/or crowd positioning. 2-4 sentences max."
}

If closing a position, set action="close" with the asset and explain what changed in your thesis.
If no compelling setup, set action="hold" and explain why you're staying patient.
Only one action per turn.`

  const decision = await callLLM(t, systemPrompt, userMessage)

  // Step 5: Execute decision
  if (decision.action === 'open_long' || decision.action === 'open_short') {
    const maxSize = totalValue * 0.3
    let size = Math.min(decision.size_usd ?? maxSize, maxSize)
    const fee = size * TRADING_FEE
    const asset = decision.asset ?? 'BTC'

    if (remainingPositions.length >= 3) {
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
      // BUG 3 FIX: Check for duplicate position in same asset
      const existingOpen = remainingPositions.find(p => p.asset === asset)
      if (existingOpen) {
        console.log(`[AI:${t.name}] Already has open ${existingOpen.direction} position in ${asset}, skipping`)
        decision.action = 'hold'
        decision.reasoning = `Already have open ${existingOpen.direction} position in ${asset}. ${decision.reasoning}`
      } else {
        const side = decision.action === 'open_long' ? 'long' : 'short'
        const spread = spreadsMap.get(asset)
        const entryRate = spread?.hl?.rate8h ?? 0
        const entryPrice = spread?.hl?.markPrice ?? null
        const tradingFee = size * TRADING_FEE

        await db.from('ai_positions').insert({
          trader_id: t.id,
          asset,
          direction: side,
          size_usd: size,
          entry_rate_8h: entryRate,
          entry_price_approx: entryPrice,
          funding_collected: 0,
          fees_paid: tradingFee,
          last_funding_at: now.toISOString(),
          is_open: true,
          opened_at: now.toISOString(),
        })

        cashBalance -= (size + tradingFee)
        console.log(`[AI:${t.name}] opened ${side.toUpperCase()} ${asset} $${size.toFixed(0)} @ ${entryPrice != null ? `$${entryPrice}` : 'N/A'} — ${decision.reasoning}`)
      }
    }
  } else if (decision.action === 'close') {
    const asset = decision.asset
    const pos = remainingPositions.find(p => p.asset === asset)
    if (pos) {
      const cashReturn = await closePosition(db, pos, currentPriceMap, now, decision.reasoning)
      cashBalance += cashReturn
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

  // Step 6: Update trader cash balance
  await db.from('ai_traders').update({
    cash_balance: cashBalance,
    updated_at: now.toISOString(),
  }).eq('id', t.id)

  return decision
}
