import type { AppConfig } from '../src/core/config.js';
import { loadConfig } from '../src/core/config.js';
import type { Candle, ContractSpec, IndicatorPoint, PositionRisk, RiskAccountSnapshot, StrategySignal } from '../src/core/types.js';

export function testConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    SYMBOLS: 'BTC_USDT,ETH_USDT',
    PAPER_INITIAL_EQUITY: '10000',
    MIN_DEPTH_LIQUIDITY_USD: '0',
    DASHBOARD_API_TOKEN: 'test-dashboard-token',
    ...overrides,
  });
}

export function candle(index: number, input: Partial<Candle> = {}): Candle {
  const close = input.close ?? 100;
  return {
    symbol: 'BTC_USDT',
    openTime: 1_700_000_040_000 + index * 60_000,
    open: input.open ?? close,
    high: input.high ?? close + 0.5,
    low: input.low ?? close - 0.5,
    close,
    volume: input.volume ?? 100,
    complete: input.complete ?? true,
    ...input,
  };
}

export function candles(count: number, input: Partial<Candle> = {}): Candle[] {
  return Array.from({ length: count }, (_, index) => candle(index, input));
}

export function contract(overrides: Partial<ContractSpec> = {}): ContractSpec {
  return {
    symbol: 'BTC_USDT',
    contractSize: 0.001,
    priceUnit: 0.01,
    volUnit: 0.001,
    minVol: 0.001,
    maxVol: 1_000_000_000,
    minLeverage: 1,
    maxLeverage: 10,
    makerFeeRate: 0.0006,
    takerFeeRate: 0.0008,
    maintenanceMarginRate: 0.005,
    state: 0,
    apiAllowed: true,
    futureType: 1,
    quoteCoin: 'USDT',
    settleCoin: 'USDT',
    ...overrides,
  };
}

export function signal(overrides: Partial<StrategySignal> = {}): StrategySignal {
  const bar = candle(30, { close: 100 });
  const indicators: IndicatorPoint = {
    openTime: bar.openTime,
    close: bar.close,
    high: bar.high,
    low: bar.low,
    k: 24,
    d: 23,
    j: 26,
    emaFast: 99,
    emaSlow: 98,
    atr: 1,
    ready: true,
  };
  return {
    symbol: 'BTC_USDT',
    direction: 'LONG',
    candleTime: bar.openTime,
    close: 100,
    atr: 1,
    stopDistance: 1,
    targetDistance: 1.5,
    indicators,
    estimatedNetRewardPerContract: 1,
    ...overrides,
  };
}

export function account(overrides: Partial<RiskAccountSnapshot> = {}): RiskAccountSnapshot {
  return {
    equity: 10_000,
    availableMargin: 10_000,
    startingEquity: 10_000,
    dailyStartingEquity: 10_000,
    realizedPnl: 0,
    unrealizedPnl: 0,
    dailyDrawdown: 0,
    dailyLocked: false,
    consecutiveLossLocked: false,
    reconciliationHealthy: true,
    ...overrides,
  };
}

export function openPosition(symbol: string, stopRisk: number, index = 1): PositionRisk {
  return {
    id: `position-${index}`,
    symbol,
    direction: 'LONG',
    quantity: 1,
    entryPrice: 100,
    stopPrice: 99,
    stopRisk,
    marginUsed: 10,
    unrealizedPnl: 0,
    openedAt: 1_700_000_000_000,
    barsHeld: 0,
    breakevenMoved: false,
    takeProfitPrice: 102,
    source: 'PAPER',
    feesPaid: 0,
    fundingCashFlow: 0,
  };
}
