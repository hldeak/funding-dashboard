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
}

interface PortfolioDetail extends Portfolio {
  positions: Position[]
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

function formatRate(n: number | null) {
  if (n === null) return '—'
  return `${(n * 100).toFixed(4)}%`
}

export default function PaperTradingPage() {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([])
  const [selected, setSelected] = useState<PortfolioDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [chartSeries, setChartSeries] = useState<SnapshotSeries[]>([])
  const [chartTab, setChartTab] = useState<'value' | 'pct'>('value')

  async function fetchPortfolios() {
    try {
      const res = await fetch(`${API}/api/paper/portfolios`)
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
      const res = await fetch(`${API}/api/paper/portfolios/${id}`)
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
            className="bg-gray-800 rounded-lg border border-gray-700 p-5 cursor-pointer hover:border-gray-500 transition"
            onClick={() => fetchDetail(p.id)}
          >
            <div className="flex justify-between items-start mb-3">
              <div>
                <h3 className="text-lg font-semibold text-white capitalize">{p.strategy_name}</h3>
                <p className="text-sm text-gray-400">{p.description}</p>
              </div>
              <span className={`text-lg font-bold ${p.pnl_pct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
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
                <span className="text-gray-500">Positions / Days</span>
                <p className="text-white">{p.open_positions_count} open · {p.days_running}d</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Detail Panel */}
      {selected && (
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-5">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-bold text-white capitalize">{selected.strategy_name} Detail</h2>
            <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-white text-sm">✕ Close</button>
          </div>

          {/* Open Positions */}
          {selected.positions.length > 0 ? (
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm text-gray-400">Open Positions</h3>
                <span className="text-xs text-blue-400">📡 Mark-to-market</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-700">
                      <th className="text-left py-2">Asset</th>
                      <th className="text-left py-2">Side</th>
                      <th className="text-right py-2">Size</th>
                      <th className="text-right py-2">Entry → Current</th>
                      <th className="text-right py-2">Unrealized P&L</th>
                      <th className="text-right py-2">Funding</th>
                      <th className="text-right py-2">Total Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.positions.map((pos) => (
                      <tr key={pos.id} className="border-b border-gray-700/50">
                        <td className="py-2 text-white font-medium">{pos.asset}</td>
                        <td className="py-2 text-gray-300">{pos.side === 'short_perp' ? '🔴 Short' : '🟢 Long'}</td>
                        <td className="py-2 text-right text-white">{formatUsd(pos.size_usd)}</td>
                        <td className="py-2 text-right text-gray-400 tabular-nums">
                          {pos.entry_price != null ? pos.entry_price.toFixed(4) : '—'}
                          {' → '}
                          {pos.current_price != null ? pos.current_price.toFixed(4) : '—'}
                        </td>
                        <td className={`py-2 text-right tabular-nums ${(pos.unrealized_pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatUsd(pos.unrealized_pnl ?? 0)}
                          <span className="text-xs ml-1 opacity-70">({formatPct(pos.unrealized_pnl_pct ?? 0)})</span>
                        </td>
                        <td className={`py-2 text-right tabular-nums ${pos.total_funding_collected >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatUsd(pos.total_funding_collected)}
                        </td>
                        <td className="py-2 text-right text-white tabular-nums">
                          {formatUsd(pos.total_position_value ?? pos.size_usd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="text-gray-500 mb-6">No open positions</p>
          )}

          {/* Recent Transactions */}
          {selected.recent_transactions.length > 0 && (
            <div>
              <h3 className="text-sm text-gray-400 mb-2">Recent Transactions</h3>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {selected.recent_transactions.map((tx) => (
                  <div key={tx.id} className="flex justify-between text-sm py-1 border-b border-gray-700/30">
                    <span className="text-gray-400">
                      <span className={`inline-block w-16 ${
                        tx.type === 'funding' ? 'text-blue-400' :
                        tx.type === 'open' ? 'text-yellow-400' :
                        tx.type === 'close' ? 'text-green-400' : 'text-red-400'
                      }`}>{tx.type}</span>
                      {tx.description}
                    </span>
                    <span className={tx.amount >= 0 ? 'text-green-400' : 'text-red-400'}>
                      {formatUsd(tx.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-8 text-center text-gray-600 text-xs">
        Paper trading simulation · Mark-to-market P&L · No real funds at risk · Auto-refreshes every 60s
      </div>
    </main>
  )
}
