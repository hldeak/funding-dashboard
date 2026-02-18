export interface FundingRate {
  asset: string
  exchange: 'hyperliquid' | 'binance' | 'bybit' | 'okx'
  rate8h: number
  rateRaw: number
  nextFundingTime: number
  openInterest?: number
  timestamp: number
}

export interface FundingSpread {
  asset: string
  hl: FundingRate | null
  binance: FundingRate | null
  bybit: FundingRate | null
  okx: FundingRate | null
  maxSpread: number
  bestCex: string
}
