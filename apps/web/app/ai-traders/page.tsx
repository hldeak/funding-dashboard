'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'

const PerformanceChart = dynamic(() => import('../../components/PerformanceChart'), { ssr: false })

interface AiTrader {
  id: string
  name: string
  model: string
  emoji: string
  persona: string
  cash_balance: number
  total_value: number
  total_pnl: number
  pnl_pct: number
  open_positions_count: number
  total_funding_collected: number
  last_decision: { action: string; reasoning: string; asset?: string; created_at: string } | null
  sharpe: number | null
  max_drawdown: number | null
}

interface TraderDetail extends AiTrader {
  positions: any[]
  recent_decisions: { action: string; reasoning: string; asset?: string; size_usd?: number; created_at: string }[]
}

interface SnapshotSeries {
  id: string
  name: string
  color: string
  data: { time: string; value: number; pnl_pct: number }[]
}

function SharpeMaxDD({ sharpe, max_drawdown, positions }: { sharpe: number | null; max_drawdown: number | null; positions: number }) {
  const sharpeColor = sharpe === null ? 'text-gray-500' : sharpe > 1 ? 'text-green-400' : sharpe >= 0 ? 'text-yellow-400' : 'text-red-400'
  const ddStr = max_drawdown === null ? '—' : `${(max_drawdown * 100).toFixed(2)}%`
  return (
    <div className="flex items-center gap-3 text-xs mt-2 text-gray-500">
      <span>Sharpe: <span className={sharpeColor + ' font-mono'}>{sharpe === null ? '—' : sharpe.toFixed(2)}</span></span>
      <span className="text-gray-700">|</span>
      <span>Max DD: <span className={max_drawdown === null ? 'text-gray-500 font-mono' : 'text-red-400 font-mono'}>{ddStr}</span></span>
      <span className="text-gray-700">|</span>
      <span>{positions}/3 positions</span>
    </div>
  )
}

function ActionBadge({ action }: { action: string }) {
  const colors: Record<string, string> = {
    open_long: 'bg-green-600 text-green-100',
    open_short: 'bg-red-600 text-red-100',
    close: 'bg-yellow-600 text-yellow-100',
    hold: 'bg-gray-600 text-gray-300',
  }
  const labels: Record<string, string> = {
    open_long: 'BUY',
    open_short: 'SELL',
    close: 'CLOSE',
    hold: 'HOLD',
  }
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-mono font-bold ${colors[action] ?? 'bg-gray-700 text-gray-400'}`}>
      {labels[action] ?? action.toUpperCase()}
    </span>
  )
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function AiTradersPage() {
  const [traders, setTraders] = useState<AiTrader[]>([])
  const [selected, setSelected] = useState<TraderDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [chartSeries, setChartSeries] = useState<SnapshotSeries[]>([])
  const [chartTab, setChartTab] = useState<'value' | 'pct'>('value')

  const API = 'https://hldesk-funding-api.fly.dev'

  const fetchTraders = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/ai/traders`)
      const data = await res.json()
      if (Array.isArray(data)) setTraders(data)
    } catch {}
    setLoading(false)
  }, [])

  const fetchSnapshots = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/ai/snapshots?days=7`)
      if (res.ok) {
        const data = await res.json()
        if (data.series) setChartSeries(data.series)
      }
    } catch {}
  }, [])

  const fetchDetail = async (name: string) => {
    try {
      const res = await fetch(`${API}/api/ai/traders/${name}`)
      const data = await res.json()
      if (data.id) setSelected(data)
    } catch {}
  }

  useEffect(() => {
    fetchTraders()
    fetchSnapshots()
    const interval = setInterval(fetchTraders, 60000)
    return () => clearInterval(interval)
  }, [fetchTraders, fetchSnapshots])

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <div className="mb-8">
        <Link href="/" className="text-blue-400 hover:text-blue-300 text-sm">← Back to Dashboard</Link>
      </div>
      <h1 className="text-3xl font-bold text-white mb-1">🤖 AI Traders</h1>
      <p className="text-gray-400 mb-8">Four AI models competing with $10K each</p>

      {/* Performance Charts */}
      <div className="mb-8 bg-gray-900 rounded-lg border border-gray-800 p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">📈 Performance</h2>
          <div className="flex gap-2">
            <button
              onClick={() => setChartTab('value')}
              className={`px-3 py-1 rounded text-sm font-medium transition ${
                chartTab === 'value'
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              Portfolio Value ($)
            </button>
            <button
              onClick={() => setChartTab('pct')}
              className={`px-3 py-1 rounded text-sm font-medium transition ${
                chartTab === 'pct'
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              Return (%)
            </button>
          </div>
        </div>

        {/* Legend */}
        {chartSeries.length > 0 && (
          <div className="flex flex-wrap gap-4 mb-4">
            {chartSeries.map((s) => (
              <div key={s.id} className="flex items-center gap-1.5 text-sm">
                <span className="w-3 h-0.5 inline-block rounded" style={{ backgroundColor: s.color }} />
                <span className="text-gray-400">{s.name}</span>
              </div>
            ))}
          </div>
        )}

        <PerformanceChart
          series={chartSeries}
          height={260}
          showPct={chartTab === 'pct'}
        />
      </div>

      {loading ? (
        <div className="text-gray-500 text-center py-12">Loading...</div>
      ) : traders.length === 0 ? (
        <div className="text-gray-500 text-center py-12">No traders found</div>
      ) : (
        <div className="space-y-4">
          {traders.map((t, i) => (
            <div key={t.id} className="bg-gray-900 border border-gray-800 rounded-lg p-5 hover:border-gray-700 transition-colors">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-2xl">{t.emoji}</span>
                    <div>
                      <span className="text-white font-bold text-lg">{t.name}</span>
                      <span className="text-gray-500 text-sm ml-2">{t.model}</span>
                    </div>
                    <span className="text-gray-600 text-sm font-mono">#{i + 1}</span>
                  </div>
                  <div className="flex gap-6 text-sm mb-3">
                    <div>
                      <span className="text-gray-500">Balance: </span>
                      <span className="text-white font-mono">${t.total_value.toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">P&L: </span>
                      <span className={`font-mono font-bold ${t.total_pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {t.total_pnl >= 0 ? '+' : ''}{t.total_pnl.toFixed(2)} ({t.pnl_pct >= 0 ? '+' : ''}{t.pnl_pct.toFixed(2)}%)
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-500">Positions: </span>
                      <span className="text-white font-mono">{t.open_positions_count}/3</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Funding: </span>
                      <span className={`font-mono ${t.total_funding_collected >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        ${t.total_funding_collected.toFixed(2)}
                      </span>
                    </div>
                  </div>
                  <SharpeMaxDD sharpe={t.sharpe} max_drawdown={t.max_drawdown} positions={t.open_positions_count} />
                  {t.last_decision && (
                    <div className="flex items-start gap-2 mt-2">
                      <ActionBadge action={t.last_decision.action} />
                      {t.last_decision.asset && <span className="text-gray-400 text-sm font-mono">{t.last_decision.asset}</span>}
                      <span className="text-gray-500 text-sm line-clamp-2">{t.last_decision.reasoning}</span>
                      <span className="text-gray-600 text-xs whitespace-nowrap">{timeAgo(t.last_decision.created_at)}</span>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => fetchDetail(t.name)}
                  className="ml-4 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-sm border border-gray-700 whitespace-nowrap"
                >
                  View Details
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail Modal */}
      {selected && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setSelected(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-3xl w-full max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-white">{selected.emoji} {selected.name}</h2>
              <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-white text-xl">✕</button>
            </div>
            <p className="text-gray-500 text-sm mb-4">{selected.model} — {selected.persona}</p>

            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-gray-800 rounded p-3">
                <div className="text-gray-500 text-xs">Total Value</div>
                <div className="text-white font-mono text-lg">${selected.total_value.toFixed(2)}</div>
              </div>
              <div className="bg-gray-800 rounded p-3">
                <div className="text-gray-500 text-xs">P&L</div>
                <div className={`font-mono text-lg ${selected.total_pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {selected.total_pnl >= 0 ? '+' : ''}${selected.total_pnl.toFixed(2)}
                </div>
              </div>
              <div className="bg-gray-800 rounded p-3">
                <div className="text-gray-500 text-xs">Funding Collected</div>
                <div className="text-green-400 font-mono text-lg">${selected.total_funding_collected.toFixed(2)}</div>
              </div>
            </div>

            {/* Open Positions */}
            {selected.positions?.length > 0 && (
              <div className="mb-6">
                <h3 className="text-white font-bold mb-2">Open Positions <span className="text-gray-500 text-xs font-normal">(mark-to-market)</span></h3>
                <div className="space-y-3">
                  {selected.positions.map((p: any) => {
                    const unrealized = p.unrealized_pnl ?? 0
                    const entryPrice = p.entry_price_approx
                    const currentPrice = p.current_price
                    const fmtPrice = (v: number | null) => v == null ? 'N/A' : v < 1 ? `$${v.toFixed(5)}` : `$${v.toFixed(2)}`
                    return (
                      <div key={p.id} className="bg-gray-800 rounded p-3 text-sm">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className={`font-bold px-2 py-0.5 rounded text-xs ${p.direction === 'long' ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}>
                              {(p.direction ?? '?').toUpperCase()}
                            </span>
                            <span className="text-white font-mono font-bold">{p.asset}</span>
                            <span className="text-gray-400">${p.size_usd.toFixed(0)}</span>
                          </div>
                          <span className={`font-mono font-bold ${unrealized >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {unrealized >= 0 ? '+' : ''}${unrealized.toFixed(2)} unrealized
                          </span>
                        </div>
                        <div className="flex gap-4 text-xs text-gray-400 font-mono">
                          <span>Entry: <span className="text-gray-300">{fmtPrice(entryPrice)}</span></span>
                          <span>→</span>
                          <span>Now: <span className="text-gray-300">{fmtPrice(currentPrice)}</span></span>
                          <span className="ml-auto">Funding: <span className={`${(p.funding_collected ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>${(p.funding_collected ?? 0).toFixed(2)}</span></span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Decision History */}
            <h3 className="text-white font-bold mb-2">Recent Decisions</h3>
            <div className="space-y-2">
              {(selected.recent_decisions ?? []).map((d, i) => (
                <div key={i} className="bg-gray-800 rounded p-3 text-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <ActionBadge action={d.action} />
                    {d.asset && <span className="text-gray-400 font-mono">{d.asset}</span>}
                    {d.size_usd && <span className="text-gray-500">${d.size_usd.toFixed(0)}</span>}
                    <span className="text-gray-600 text-xs ml-auto">{timeAgo(d.created_at)}</span>
                  </div>
                  <p className="text-gray-400">{d.reasoning}</p>
                </div>
              ))}
              {(selected.recent_decisions ?? []).length === 0 && (
                <p className="text-gray-600 text-sm">No decisions yet</p>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
