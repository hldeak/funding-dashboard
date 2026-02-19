export interface FundingRate {
  asset: string
  exchange: 'hyperliquid' | 'binance' | 'bybit' | 'okx'
  rate8h: number          // normalized to 8h equivalent
  rateRaw: number         // raw rate as returned by exchange
  nextFundingTime: number // unix ms
  openInterest?: number
  markPrice?: number      // current mark price (HL only)
  prevDayPrice?: number   // 24h ago price (HL only)
  change24h?: number      // % price change over 24h (HL only)
  volume24h?: number      // 24h notional volume USD (HL only)
  timestamp: number       // when we fetched this
}

export interface FundingSpread {
  asset: string
  hl: FundingRate | null
  binance: FundingRate | null
  bybit: FundingRate | null
  okx: FundingRate | null
  maxSpread: number       // HL rate minus best CEX rate
  bestCex: string         // which CEX has the highest rate to compare
}

export interface AlertConfig {
  telegramChatId: string
  asset: string           // 'BTC', 'ETH', or 'ALL'
  spreadThreshold: number // e.g. 0.05 = 0.05% per 8h
  direction: 'above' | 'below'
}

// Backtesting types (Phase 2)
export interface StrategyRule {
  enterWhen: {
    hlRateAbove?: number     // e.g. 0.05
    spreadAbove?: number     // vs best CEX
  }
  exitWhen: {
    hlRateBelow?: number
    spreadBelow?: number
    spreadInverts?: boolean
  }
  positionSizeUsd: number
  assets: string[] | 'all'
}

export interface BacktestResult {
  strategy: StrategyRule
  periodStart: number
  periodEnd: number
  totalPnl: number
  sharpeRatio: number
  maxDrawdown: number
  winRate: number
  totalTrades: number
  fundingCollected: number
  estimatedFees: number
  byAsset: Record<string, { pnl: number; trades: number }>
}
