'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { FundingSpread, FundingRate } from '@/lib/types'

function formatRate(rate: FundingRate | null): string {
  if (!rate) return '—'
  return `${(rate.rate8h * 100).toFixed(4)}%`
}

function rateColor(rate: FundingRate | null): string {
  if (!rate) return 'text-gray-600'
  return rate.rate8h >= 0 ? 'text-green-400' : 'text-red-400'
}

export default function AssetPage() {
  const params = useParams()
  const router = useRouter()
  const symbol = params.symbol as string
  const [data, setData] = useState<FundingSpread | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || ''
    fetch(`${apiUrl}/api/funding/${symbol}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [symbol])

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-800 rounded w-48" />
          <div className="h-32 bg-gray-800 rounded" />
        </div>
      </main>
    )
  }

  if (!data) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-8">
        <button onClick={() => router.push('/')} className="text-cyan-400 hover:underline mb-4 text-sm">← Back</button>
        <p className="text-gray-400">Asset not found.</p>
      </main>
    )
  }

  const exchanges: { key: keyof Pick<FundingSpread, 'hl' | 'binance' | 'bybit' | 'okx'>; label: string }[] = [
    { key: 'hl', label: 'Hyperliquid' },
    { key: 'binance', label: 'Binance' },
    { key: 'bybit', label: 'Bybit' },
    { key: 'okx', label: 'OKX' },
  ]

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <button onClick={() => router.push('/')} className="text-cyan-400 hover:underline mb-6 text-sm inline-block">
        ← Back to Dashboard
      </button>

      {/* Header */}
      <div className="flex items-baseline gap-4 mb-8">
        <h1 className="text-3xl font-bold text-gray-100">{data.asset}</h1>
        <span className={`text-lg font-mono ${rateColor(data.hl)}`}>
          HL: {formatRate(data.hl)}
        </span>
        <span className={`text-lg font-mono ${data.maxSpread >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          Spread: {(data.maxSpread * 100).toFixed(4)}%
        </span>
      </div>

      {/* Exchange cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {exchanges.map(ex => {
          const rate = data[ex.key]
          return (
            <div key={ex.key} className="bg-gray-800 border border-gray-700 rounded-lg p-4">
              <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">{ex.label}</div>
              <div className={`text-2xl font-mono font-bold ${rateColor(rate)}`}>
                {formatRate(rate)}
              </div>
              {rate?.openInterest && (
                <div className="text-xs text-gray-500 mt-1">
                  OI: ${(rate.openInterest / 1e6).toFixed(1)}M
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Historical placeholder */}
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-8 text-center">
        <div className="text-gray-500 mb-2">📈 Historical Funding Chart</div>
        <div className="text-sm text-gray-600">Historical data — <a href="#" className="text-cyan-400 hover:underline">upgrade to Pro</a></div>
      </div>
    </main>
  )
}
