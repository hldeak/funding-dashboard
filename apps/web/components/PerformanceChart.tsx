'use client'

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid } from 'recharts'

interface SeriesPoint {
  time: string
  value: number
  pnl_pct: number
}

interface Series {
  id: string
  name: string
  color: string
  data: SeriesPoint[]
}

interface Props {
  series: Series[]
  height?: number
  showPct?: boolean
}

function formatAxisTime(timeStr: string): string {
  const d = new Date(timeStr)
  const month = d.toLocaleString('en-US', { month: 'short' })
  const day = d.getDate()
  const hours = String(d.getUTCHours()).padStart(2, '0')
  const mins = String(d.getUTCMinutes()).padStart(2, '0')
  return `${month} ${day} ${hours}:${mins}`
}

function formatValue(v: number, showPct: boolean): string {
  if (showPct) return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Merge all series data into a single array keyed by time for Recharts
function mergeSeriesData(series: Series[], showPct: boolean) {
  const timeMap = new Map<string, Record<string, number>>()

  for (const s of series) {
    for (const point of s.data) {
      if (!timeMap.has(point.time)) timeMap.set(point.time, {})
      const entry = timeMap.get(point.time)!
      entry[s.id] = showPct ? point.pnl_pct : point.value
    }
  }

  return Array.from(timeMap.entries())
    .sort(([a], [b]) => new Date(a).getTime() - new Date(b).getTime())
    .map(([time, values]) => ({ time, ...values }))
}

interface CustomTooltipProps {
  active?: boolean
  payload?: any[]
  label?: string
  series: Series[]
  showPct: boolean
}

function CustomTooltip({ active, payload, label, series, showPct }: CustomTooltipProps) {
  if (!active || !payload || !label) return null

  return (
    <div className="bg-gray-900 border border-gray-700 rounded p-3 text-xs shadow-lg">
      <p className="text-gray-400 mb-2">{formatAxisTime(label)}</p>
      {series.map((s) => {
        const entry = payload.find((p) => p.dataKey === s.id)
        if (!entry) return null
        return (
          <div key={s.id} className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: s.color }} />
            <span className="text-gray-300">{s.name}:</span>
            <span className="font-mono font-bold" style={{ color: s.color }}>
              {formatValue(entry.value, showPct)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export default function PerformanceChart({ series, height = 280, showPct = false }: Props) {
  // Count total data points across all series
  const totalPoints = series.reduce((sum, s) => sum + s.data.length, 0)
  const maxPoints = series.reduce((max, s) => Math.max(max, s.data.length), 0)

  if (maxPoints <= 1) {
    return (
      <div
        className="flex flex-col items-center justify-center rounded-lg border border-gray-800 text-gray-500 text-sm"
        style={{ height }}
      >
        <span className="text-2xl mb-2">📊</span>
        <span>Collecting data...</span>
        <span className="text-xs mt-1 text-gray-600">Charts update hourly</span>
      </div>
    )
  }

  const chartData = mergeSeriesData(series, showPct)
  const referenceValue = showPct ? 0 : 10000

  // Determine tick count for X axis
  const tickCount = Math.min(chartData.length, 8)
  const step = Math.floor(chartData.length / tickCount)
  const ticks = chartData
    .filter((_, i) => i % step === 0 || i === chartData.length - 1)
    .map((d) => d.time)

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
        <XAxis
          dataKey="time"
          ticks={ticks}
          tickFormatter={formatAxisTime}
          tick={{ fill: '#9ca3af', fontSize: 11 }}
          axisLine={{ stroke: '#374151' }}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tickFormatter={(v) => formatValue(v, showPct)}
          tick={{ fill: '#9ca3af', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={showPct ? 60 : 80}
        />
        <Tooltip content={<CustomTooltip series={series} showPct={showPct} />} />
        <ReferenceLine
          y={referenceValue}
          stroke="#374151"
          strokeDasharray="4 4"
          label={{ value: showPct ? '0%' : '$10k', fill: '#6b7280', fontSize: 10 }}
        />
        {series.map((s) => (
          <Line
            key={s.id}
            type="monotone"
            dataKey={s.id}
            stroke={s.color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
