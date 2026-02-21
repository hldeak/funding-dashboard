'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'

const PerformanceChart = dynamic(() => import('../../components/PerformanceChart'), { ssr: false })

const API = ''
const EXTERNAL_API = 'https://hldesk-funding-api.fly.dev'

interface Portfolio {
  id: string
  strategy_name: string
  description: string
  cash_balance: number
  initial_balance: number
  total_value: number
  total_pnl: number
  pnl_pct: number
  open_positions_count: number
  total_funding_collected: number
  days_running: number
  strategy_config: any
  sharpe: number | null
  max_drawdown: number | null
}

interface PortfolioDetail extends Portfolio {
  positions: Position[]
  closed_positions: ClosedPosition[]
  recent_transactions: Transaction[]
}

interface Position {
  id: string
  asset: string
  side: string
  size_usd: number
  entry_price: number | null
  entry_rate_8h: number
  total_funding_collected: number
  current_price: number | null
  current_rate_8h: number | null
  current_spread: number | null
  unrealized_pnl: number
  unrealized_pnl_pct: number
  total_position_value: number
  opened_at: string
}

interface ClosedPosition {
  id: string
  asset: string
  side: string
  size_usd: number
  total_funding_collected: number
  opened_at: string
  closed_at: string | null
  pnl: number | null
}

interface Transaction {
  id: string
  type: string
  asset: string
  amount: number
  description: string
  created_at: string
}

interface SnapshotSeries {
  id: string
  name: string
  color: string
  data: { time: string; value: number; pnl_pct: number }[]
}

function formatUsd(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
}

function formatPct(n: number) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
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

function SharpeMaxDD({ sharpe, max_drawdown, positions }: { sharpe: number | null; max_drawdown: number | null; positions: number }) {
  const sharpeColor = sharpe === null ? 'text-gray-500' : sharpe > 1 ? 'text-green-400' : sharpe >= 0 ? 'text-yellow-400' : 'text-red-400'
  const ddStr = max_drawdown === null ? '—' : `${(max_drawdown * 100).toFixed(2)}%`

  return (
    <div className="flex items-center gap-3 text-xs mt-2 text-gray-500">
      <span>
        Sharpe:{' '}
        <span className={sharpeColor + ' font-mono'}>
          {sharpe === null ? '—' : sharpe.toFixed(2)}
        </span>
      </span>
      <span className="text-gray-700">|</span>
      <span>
        Max DD:{' '}
        <span className={max_drawdown === null ? 'text-gray-500 font-mono' : 'text-red-400 font-mono'}>
          {ddStr}
        </span>
      </span>
      <span className="text-gray-700">|</span>
      <span>{positions} positions</span>
    </div>
  )
}

export default function PaperTradingPage() {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([])
  const [selected, setSelected] = useState<PortfolioDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [chartSeries, setChartSeries] = useState<SnapshotSeries[]>([])
  const [chartTab, setChartTab] = useState<'value' | 'pct'>('value')

  async function fetchPortfolios() {
    try {
      const res = await fetch(`${EXTERNAL_API}/api/paper/portfolios`)
      if (res.ok) setPortfolios(await res.json())
    } catch {}
    setLoading(false)
  }

  async function fetchSnapshots() {
    try {
      const res = await fetch(`${EXTERNAL_API}/api/paper/snapshots?days=7`)
      if (res.ok) {
        const data = await res.json()
        if (data.series) setChartSeries(data.series)
      }
    } catch {}
  }

  async function fetchDetail(id: string) {
    try {
      const res = await fetch(`${EXTERNAL_API}/api/paper/portfolios/${id}`)
      if (res.ok) setSelected(await res.json())
    } catch {}
  }

  useEffect(() => {
    fetchPortfolios()
    fetchSnapshots()
    const interval = setInterval(fetchPortfolios, 60000)
    return () => clearInterval(interval)
  }, [])

  if (loading) return <div className="text-center py-20 text-gray-400">Loading paper portfolios...</div>

  // Sort by pnl_pct for leaderboard
  const sorted = [...portfolios].sort((a, b) => b.pnl_pct - a.pnl_pct)

  return (
    <main className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">📊 Paper Trading Dashboard</h1>
        <Link href="/" className="text-blue-400 hover:text-blue-300 text-sm">← Back to Funding Rates</Link>
      </div>

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

      {/* Leaderboard */}
      {sorted.length > 0 && (
        <div className="mb-6 p-4 bg-gray-800 rounded-lg border border-gray-700">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm text-gray-400">🏆 Leading Strategy</h2>
            <span className="text-xs text-blue-400 font-medium">📡 Mark-to-market</span>
          </div>
          <p className="text-lg font-semibold text-white">
            {sorted[0].strategy_name.charAt(0).toUpperCase() + sorted[0].strategy_name.slice(1)}{' '}
            <span className={sorted[0].pnl_pct >= 0 ? 'text-green-400' : 'text-red-400'}>
              {formatPct(sorted[0].pnl_pct)}
            </span>
          </p>
        </div>
      )}

      {/* Portfolio Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        {sorted.map((p) => (
          <div
            key={p.id}
            className="bg-gray-800 rounded-lg border border-gray-700 p-5 hover:border-gray-500 transition"
          >
            <div className="flex justify-between items-start mb-3">
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-semibold text-white capitalize">{p.strategy_name}</h3>
                <p className="text-sm text-gray-400">{p.description}</p>
              </div>
              <span className={`text-lg font-bold ml-3 ${p.pnl_pct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {formatPct(p.pnl_pct)}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-gray-500">Balance</span>
                <p className="text-white">{formatUsd(p.total_value)}</p>
              </div>
              <div>
                <span className="text-gray-500">P&L</span>
                <p className={p.total_pnl >= 0 ? 'text-green-400' : 'text-red-400'}>{formatUsd(p.total_pnl)}</p>
              </div>
              <div>
                <span className="text-gray-500">Funding Collected</span>
                <p className="text-white">{formatUsd(p.total_funding_collected)}</p>
              </div>
              <div>
                <span className="text-gray-500">Days Running</span>
                <p className="text-white">{p.days_running}d</p>
              </div>
            </div>

            <SharpeMaxDD sharpe={p.sharpe} max_drawdown={p.max_drawdown} positions={p.open_positions_count} />

            <div className="mt-3">
              <button
                onClick={() => fetchDetail(p.id)}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-sm border border-gray-700 whitespace-nowrap transition"
              >
                View Details
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Detail Modal */}
      {selected && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setSelected(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-4xl w-full max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-xl font-bold text-white capitalize">{selected.strategy_name}</h2>
              <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-white text-xl">✕</button>
            </div>
            <p className="text-gray-500 text-sm mb-5">{selected.description}</p>

            {/* Stats Row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <div className="bg-gray-800 rounded p-3">
                <div className="text-gray-500 text-xs mb-1">Total Value</div>
                <div className="text-white font-mono">{formatUsd(selected.total_value)}</div>
              </div>
              <div className="bg-gray-800 rounded p-3">
                <div className="text-gray-500 text-xs mb-1">P&L</div>
                <div className={`font-mono ${selected.total_pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {selected.total_pnl >= 0 ? '+' : ''}{formatUsd(selected.total_pnl)}{' '}
                  <span className="text-xs opacity-70">({formatPct(selected.pnl_pct)})</span>
                </div>
              </div>
              <div className="bg-gray-800 rounded p-3">
                <div className="text-gray-500 text-xs mb-1">Cash</div>
                <div className="text-white font-mono">{formatUsd(selected.cash_balance)}</div>
              </div>
              <div className="bg-gray-800 rounded p-3">
                <div className="text-gray-500 text-xs mb-1">Positions Open</div>
                <div className="text-white font-mono">{selected.open_positions_count}</div>
              </div>
            </div>

            {/* Open Positions */}
            <h3 className="text-white font-bold mb-3">
              Open Positions{' '}
              <span className="text-gray-500 text-xs font-normal">📡 mark-to-market</span>
            </h3>
            {selected.positions.length > 0 ? (
              <div className="overflow-x-auto mb-6">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-700">
                      <th className="text-left py-2 pr-3">Asset</th>
                      <th className="text-left py-2 pr-3">Side</th>
                      <th className="text-right py-2 pr-3">Size</th>
                      <th className="text-right py-2 pr-3">Entry Price</th>
                      <th className="text-right py-2 pr-3">Current</th>
                      <th className="text-right py-2 pr-3">Unr. P&L</th>
                      <th className="text-right py-2 pr-3">Funding</th>
                      <th className="text-right py-2">Opened</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.positions.map((pos) => {
                      const fmtPrice = (v: number | null) => v == null ? '—' : v < 1 ? `$${v.toFixed(5)}` : `$${v.toFixed(2)}`
                      return (
                        <tr key={pos.id} className="border-b border-gray-700/50">
                          <td className="py-2 pr-3 text-white font-mono font-medium">{pos.asset}</td>
                          <td className="py-2 pr-3">
                            <span className={`px-2 py-0.5 rounded text-xs font-bold ${pos.side === 'short_perp' ? 'bg-red-900 text-red-300' : 'bg-green-900 text-green-300'}`}>
                              {pos.side === 'short_perp' ? 'SHORT' : 'LONG'}
                            </span>
                          </td>
                          <td className="py-2 pr-3 text-right text-white tabular-nums">{formatUsd(pos.size_usd)}</td>
                          <td className="py-2 pr-3 text-right text-gray-400 tabular-nums font-mono">{fmtPrice(pos.entry_price)}</td>
                          <td className="py-2 pr-3 text-right text-gray-400 tabular-nums font-mono">{fmtPrice(pos.current_price)}</td>
                          <td className={`py-2 pr-3 text-right tabular-nums font-mono ${(pos.unrealized_pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {(pos.unrealized_pnl ?? 0) >= 0 ? '+' : ''}{formatUsd(pos.unrealized_pnl ?? 0)}
                            <span className="text-xs ml-1 opacity-70">({formatPct(pos.unrealized_pnl_pct ?? 0)})</span>
                          </td>
                          <td className={`py-2 pr-3 text-right tabular-nums font-mono ${pos.total_funding_collected >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {formatUsd(pos.total_funding_collected)}
                          </td>
                          <td className="py-2 text-right text-gray-500 text-xs whitespace-nowrap">{timeAgo(pos.opened_at)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-gray-600 text-sm mb-6 italic">No open positions</p>
            )}

            {/* Closed Positions */}
            {(selected.closed_positions ?? []).length > 0 && (
              <>
                <h3 className="text-white font-bold mb-3">Recent Closed Positions</h3>
                <div className="overflow-x-auto mb-6">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-gray-500 border-b border-gray-700">
                        <th className="text-left py-2 pr-3">Asset</th>
                        <th className="text-left py-2 pr-3">Side</th>
                        <th className="text-right py-2 pr-3">Size</th>
                        <th className="text-right py-2 pr-3">Funding P&L</th>
                        <th className="text-right py-2">Closed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(selected.closed_positions ?? []).map((pos) => (
                        <tr key={pos.id} className="border-b border-gray-700/50">
                          <td className="py-2 pr-3 text-white font-mono font-medium">{pos.asset}</td>
                          <td className="py-2 pr-3">
                            <span className={`px-2 py-0.5 rounded text-xs font-bold ${pos.side === 'short_perp' ? 'bg-red-900 text-red-300' : 'bg-green-900 text-green-300'}`}>
                              {pos.side === 'short_perp' ? 'SHORT' : 'LONG'}
                            </span>
                          </td>
                          <td className="py-2 pr-3 text-right text-white tabular-nums">{formatUsd(pos.size_usd)}</td>
                          <td className={`py-2 pr-3 text-right tabular-nums font-mono ${(pos.pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {pos.pnl !== null ? `${(pos.pnl ?? 0) >= 0 ? '+' : ''}${formatUsd(pos.pnl ?? 0)}` : '—'}
                          </td>
                          <td className="py-2 text-right text-gray-500 text-xs whitespace-nowrap">
                            {pos.closed_at ? timeAgo(pos.closed_at) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="mt-8 text-center text-gray-600 text-xs">
        Paper trading simulation · Mark-to-market P&L · No real funds at risk · Auto-refreshes every 60s
      </div>
    </main>
  )
}
