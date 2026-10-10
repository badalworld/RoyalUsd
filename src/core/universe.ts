import type { ContractSpec } from './types.js';

export interface HighVolatilityAsset {
  symbol: string;
  dailyRangePct: number;
  lastPrice: number;
  high24hPrice: number;
  low24hPrice: number;
}

function positiveNumber(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    const number = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

/**
 * Screens active, API-enabled USDT perpetual contracts by the observed 24-hour high-low
 * range relative to last price. This is a volatility proxy/ranking, not a prediction.
 */
export function selectHighVolatilityAssets(
  contracts: ContractSpec[],
  tickers: Array<Record<string, unknown>>,
  maxAssets = 100,
  minDailyRangePct = 2,
): HighVolatilityAsset[] {
  if (!Number.isInteger(maxAssets) || maxAssets < 1 || maxAssets > 100) {
    throw new RangeError('High-volatility universe size must be an integer from 1 to 100');
  }
  if (!Number.isFinite(minDailyRangePct) || minDailyRangePct < 0) {
    throw new RangeError('Minimum daily volatility range must be finite and non-negative');
  }

  const enabled = new Set(contracts.filter((contract) => contract.state === 0
    && contract.apiAllowed
    && contract.futureType === 1
    && contract.quoteCoin === 'USDT'
    && contract.settleCoin === 'USDT'
    && Number.isFinite(contract.contractSize) && contract.contractSize > 0
    && Number.isFinite(contract.priceUnit) && contract.priceUnit > 0
    && Number.isFinite(contract.volUnit) && contract.volUnit > 0
    && Number.isFinite(contract.minVol) && contract.minVol > 0
    && contract.maxVol >= contract.minVol).map((contract) => contract.symbol));

  const bestTickerBySymbol = new Map<string, Record<string, unknown>>();
  for (const ticker of tickers) {
    const symbol = String(ticker.symbol ?? '').toUpperCase();
    if (symbol && enabled.has(symbol) && !bestTickerBySymbol.has(symbol)) bestTickerBySymbol.set(symbol, ticker);
  }

  return [...bestTickerBySymbol.entries()]
    .flatMap(([symbol, ticker]) => {
      const lastPrice = positiveNumber(ticker, ['lastPrice', 'last', 'price']);
      const high24hPrice = positiveNumber(ticker, ['high24Price', 'high24hPrice', 'highPrice', 'high24']);
      const low24hPrice = positiveNumber(ticker, ['lower24Price', 'low24Price', 'low24hPrice', 'lowPrice', 'low24']);
      if (!(lastPrice > 0) || !(high24hPrice >= low24hPrice) || !(low24hPrice > 0)) return [];
      const dailyRangePct = (high24hPrice - low24hPrice) / lastPrice * 100;
      if (!Number.isFinite(dailyRangePct) || dailyRangePct < minDailyRangePct) return [];
      return [{ symbol, dailyRangePct, lastPrice, high24hPrice, low24hPrice }];
    })
    .sort((left, right) => right.dailyRangePct - left.dailyRangePct || left.symbol.localeCompare(right.symbol))
    .slice(0, maxAssets);
}
