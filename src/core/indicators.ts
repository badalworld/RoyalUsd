import type { Candle, IndicatorPoint } from './types.js';
import type { IndicatorConfig } from './config.js';

export const DEFAULT_INDICATORS: IndicatorConfig = {
  kdjLength: 9,
  kSmoothing: 3,
  dSmoothing: 3,
  emaFast: 9,
  emaSlow: 21,
  atrLength: 14,
};

export function validateCandleSeries(candles: Candle[]): void {
  let previousTime = -Infinity;
  for (const [index, candle] of candles.entries()) {
    const values = [candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume];
    if (!values.every(Number.isFinite)) throw new TypeError(`Candle ${index} contains a non-finite number`);
    if (candle.openTime <= previousTime) throw new TypeError(`Candle ${index} is duplicate or out of chronological order`);
    if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0 || candle.volume < 0) {
      throw new TypeError(`Candle ${index} contains an invalid price or volume`);
    }
    if (candle.high < Math.max(candle.open, candle.close, candle.low)) throw new TypeError(`Candle ${index} high is inconsistent`);
    if (candle.low > Math.min(candle.open, candle.close, candle.high)) throw new TypeError(`Candle ${index} low is inconsistent`);
    previousTime = candle.openTime;
  }
}

function emaSeries(values: number[], period: number): number[] {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const result = new Array<number>(values.length);
  result[0] = values[0]!;
  for (let index = 1; index < values.length; index += 1) {
    result[index] = values[index]! * alpha + result[index - 1]! * (1 - alpha);
  }
  return result;
}

function atrSeries(candles: Candle[], period: number): Array<number | null> {
  const result: Array<number | null> = new Array(candles.length).fill(null);
  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const priorClose = candles[index - 1]!.close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - priorClose), Math.abs(candle.low - priorClose));
  });
  if (candles.length < period) return result;

  let current = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
  result[period - 1] = current;
  for (let index = period; index < candles.length; index += 1) {
    current = (current * (period - 1) + trueRanges[index]!) / period;
    result[index] = current;
  }
  return result;
}

export function calculateIndicatorSeries(
  source: Candle[],
  config: IndicatorConfig = DEFAULT_INDICATORS,
): IndicatorPoint[] {
  const candles = source.filter((candle) => candle.complete);
  validateCandleSeries(candles);
  if (![config.kdjLength, config.kSmoothing, config.dSmoothing, config.emaFast, config.emaSlow, config.atrLength]
    .every((number) => Number.isInteger(number) && number > 0)) {
    throw new TypeError('Indicator periods must be finite positive integers');
  }
  if (config.emaFast >= config.emaSlow) throw new TypeError('EMA fast period must be less than EMA slow period');

  const closes = candles.map((candle) => candle.close);
  const fast = emaSeries(closes, config.emaFast);
  const slow = emaSeries(closes, config.emaSlow);
  const atr = atrSeries(candles, config.atrLength);
  const points: IndicatorPoint[] = [];
  let previousK = 50;
  let previousD = 50;

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!;
    let k = previousK;
    let d = previousD;
    if (index >= config.kdjLength - 1) {
      const window = candles.slice(index - config.kdjLength + 1, index + 1);
      const highestHigh = Math.max(...window.map((item) => item.high));
      const lowestLow = Math.min(...window.map((item) => item.low));
      // A flat lookback is neutral, not a division by zero or a fabricated crossover.
      const rsv = highestHigh === lowestLow ? 50 : (100 * (candle.close - lowestLow)) / (highestHigh - lowestLow);
      const alphaK = 1 / config.kSmoothing;
      const alphaD = 1 / config.dSmoothing;
      k = previousK * (1 - alphaK) + rsv * alphaK;
      d = previousD * (1 - alphaD) + k * alphaD;
    }
    const j = 3 * k - 2 * d;
    const point: IndicatorPoint = {
      openTime: candle.openTime,
      close: candle.close,
      high: candle.high,
      low: candle.low,
      k,
      d,
      j,
      emaFast: fast[index]!,
      emaSlow: slow[index]!,
      atr: atr[index] ?? null,
      ready: index >= Math.max(config.kdjLength - 1, config.emaSlow - 1, config.atrLength - 1),
    };
    if (![point.k, point.d, point.j, point.emaFast, point.emaSlow].every(Number.isFinite)
      || (point.atr !== null && !Number.isFinite(point.atr))) {
      throw new TypeError(`Invalid indicator output at candle index ${index}`);
    }
    points.push(point);
    previousK = k;
    previousD = d;
  }
  return points;
}

export function calculateIndicators(source: Candle[], config: IndicatorConfig = DEFAULT_INDICATORS): IndicatorPoint | null {
  const points = calculateIndicatorSeries(source, config);
  return points.at(-1) ?? null;
}

/** Exposed for reproducible unit tests and exchange-to-backtest parity checks. */
export function calculateEma(values: number[], period: number): number[] {
  if (!Number.isInteger(period) || period < 1 || values.some((value) => !Number.isFinite(value))) {
    throw new TypeError('EMA requires finite values and a positive integer period');
  }
  return emaSeries(values, period);
}

export function calculateAtr(candles: Candle[], period: number): Array<number | null> {
  if (!Number.isInteger(period) || period < 1) throw new TypeError('ATR period must be a positive integer');
  validateCandleSeries(candles.filter((candle) => candle.complete));
  return atrSeries(candles.filter((candle) => candle.complete), period);
}
