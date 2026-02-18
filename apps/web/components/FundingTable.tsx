'use client'

import { useRouter } from 'next/navigation'
import { useState, useEffect, useCallback, useRef } from 'react'
import { FundingSpread, FundingRate } from '@/lib/types'

type SortKey = 'asset' | 'hl' | 'binance' | 'bybit' | 'okx' | 'spread' | 'nextFunding'
type SortDir = 'asc' | 'desc'

function formatRate(rate: FundingRate | null): string {
  if (!rate) return '—'
  return `${(rate.rate8h * 100).toFixed(4)}%`
}

function rateColor(rate: FundingRate | null): string {
  if (!rate) return 'text-gray-600'
  if (rate.rate8h > 0) return 'text-green-400'
  if (rate.rate8h < 0) return 'text-red-400'
  return 'text-gray-400'
}

function spreadColor(spread: number): string {
  if (spread > 0.0005) return 'text-green-400 font-bold'
  if (spread > 0.0002) return 'text-yellow-400 font-semibold'
  if (spread < 0) return 'text-red-400'
  return 'text-gray-400'
}

function spreadRowBg(spread: number): string {
  if (spread > 0.0005) return 'bg-green-400/5'
  if (spread > 0.0002) return 'bg-yellow-400/5'
  return ''
}

function formatCountdown(nextFundingTime: number | undefined): string {
  if (!nextFundingTime) return '—'
  const diff = nextFundingTime - Date.now()
  if (diff <= 0) return 'Now'
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  const s = Math.floor((diff % 60000) / 1000)
  return `${h}h ${m}m ${s}s`
}

function getSortValue(item: FundingSpread, key: SortKey): number | string {
  switch (key) {
    case 'asset': return item.asset
    case 'hl': return item.hl?.rate8h ?? -Infinity
    case 'binance': return item.binance?.rate8h ?? -Infinity
    case 'bybit': return item.bybit?.rate8h ?? -Infinity
    case 'okx': return item.okx?.rate8h ?? -Infinity
    case 'spread': return item.maxSpread
    case 'nextFunding': return item.hl?.nextFundingTime ?? Infinity
    default: return 0
  }
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 12 }).map((_, i) => (
        <tr key={i} className="border-b border-gray-800">
          {Array.from({ length: 7 }).map((_, j) => (
            <td key={j} className="px-4 py-3">
              <div className="h-4 bg-gray-800 rounded animate-pulse" style={{ width: j === 0 ? '60px' : '80px' }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

export default function FundingTable() {
  const router = useRouter()
  const [data, setData] = useState<FundingSpread[]>([])
  const [loading, setLoading] = useState(true)
  const [sortKey, setSortKey] = useState<SortKey>('spread')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [, setTick] = useState(0)
  const [search, setSearch] = useState('')
  const intervalRef = useRef<ReturnType<typeof setInterval>>()

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/funding?limit=100`)
      if (!res.ok) throw new Error('fetch failed')
      const json = await res.json()
      setData(json)
      setLastUpdated(new Date())
    } catch (e) {
      console.error('Failed to fetch funding data:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const id = setInterval(fetchData, 30000)
    return () => clearInterval(id)
  }, [fetchData])

  // Tick every second for countdown timers
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    intervalRef.current = id
    return () => clearInterval(id)
  }, [])

  const filtered = search.trim()
    ? data.filter(d => d.asset.toLowerCase().includes(search.trim().toLowerCase()))
    : data

  const sorted = [...filtered].sort((a, b) => {
    const va = getSortValue(a, sortKey)
    const vb = getSortValue(b, sortKey)
    const cmp = typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number)
    return sortDir === 'desc' ? -cmp : cmp
  })

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const arrow = (key: SortKey) => sortKey === key ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''

  const headers: { key: SortKey; label: string }[] = [
    { key: 'asset', label: 'Asset' },
    { key: 'hl', label: 'HL Rate' },
    { key: 'binance', label: 'Gate.io' },
    { key: 'bybit', label: 'Bitget' },
    { key: 'okx', label: 'OKX' },
    { key: 'spread', label: 'Spread' },
    { key: 'nextFunding', label: 'Next HL Funding' },
  ]

  return (
    <div>
      {/* Header bar */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-cyan-400 tracking-tight">HLDesk</h1>
        </div>
        <div className="flex items-center gap-4 text-sm text-gray-400">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse-dot inline-block" />
            <span className="text-green-400 font-medium">LIVE</span>
          </span>
          {lastUpdated && (
            <span>Updated {lastUpdated.toLocaleTimeString()}</span>
          )}
        </div>
      </div>

      {/* Stats bar */}
      {!loading && data.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-3">
            <div className="text-xs text-gray-400 uppercase tracking-wider">Assets Tracked</div>
            <div className="text-xl font-bold text-gray-100 mt-1">{data.length}</div>
          </div>
          <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-3">
            <div className="text-xs text-gray-400 uppercase tracking-wider">Biggest Spread</div>
            <div className="text-xl font-bold text-green-400 mt-1">
              {(Math.max(...data.map(d => d.maxSpread)) * 100).toFixed(4)}%
            </div>
          </div>
          <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-3">
            <div className="text-xs text-gray-400 uppercase tracking-wider">Avg HL Rate</div>
            <div className="text-xl font-bold text-gray-100 mt-1">
              {(data.filter(d => d.hl).reduce((sum, d) => sum + (d.hl?.rate8h ?? 0), 0) / Math.max(data.filter(d => d.hl).length, 1) * 100).toFixed(4)}%
            </div>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          placeholder="Search assets (BTC, ETH, SOL...)"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full sm:w-72 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
        />
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700 bg-gray-900/80">
                {headers.map(h => (
                  <th
                    key={h.key}
                    onClick={() => handleSort(h.key)}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-200 select-none"
                  >
                    {h.label}{arrow(h.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows />
              ) : sorted.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-500">
                    No funding data available
                  </td>
                </tr>
              ) : (
                sorted.map(item => (
                  <tr
                    key={item.asset}
                    onClick={() => router.push(`/asset/${item.asset}`)}
                    className={`border-b border-gray-800 hover:bg-gray-800/50 cursor-pointer transition-colors ${spreadRowBg(item.maxSpread)}`}
                  >
                    <td className="px-4 py-3 font-medium text-gray-100">{item.asset}</td>
                    <td className={`px-4 py-3 font-mono ${rateColor(item.hl)}`}>{formatRate(item.hl)}</td>
                    <td className={`px-4 py-3 font-mono ${rateColor(item.binance)}`}>{formatRate(item.binance)}</td>
                    <td className={`px-4 py-3 font-mono ${rateColor(item.bybit)}`}>{formatRate(item.bybit)}</td>
                    <td className={`px-4 py-3 font-mono ${rateColor(item.okx)}`}>{formatRate(item.okx)}</td>
                    <td className={`px-4 py-3 font-mono ${spreadColor(item.maxSpread)}`}>
                      {(item.maxSpread * 100).toFixed(4)}%
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-400 text-xs">
                      {formatCountdown(item.hl?.nextFundingTime)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-6 text-center text-xs text-gray-500">
        Free tier • 30s refresh •{' '}
        <a href="#" className="text-cyan-400 hover:underline">Upgrade to Pro</a>
      </div>
    </div>
  )
}
