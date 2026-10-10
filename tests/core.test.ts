import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateAtr, calculateEma, calculateIndicatorSeries } from '../src/core/indicators.js';
import { accountDate, createDailyRiskState, recordClosedTrade, resetDailyRiskState, updateDailyRiskState } from '../src/core/daily-risk.js';
import { assessPositionRisk } from '../src/core/risk.js';
import { estimateRoundTripCosts, estimateStopRiskPerContract, fundingCashFlow, roundPriceToTick } from '../src/core/accounting.js';
import { evaluateSignal } from '../src/core/strategy.js';
import { selectHighVolatilityAssets } from '../src/core/universe.js';
import { MexcMarketStream } from '../src/exchange/market-stream.js';
import type { MexcFuturesAdapter } from '../src/exchange/mexc.js';
import type { IndicatorPoint } from '../src/core/types.js';
import { account, candle, candles, contract, openPosition, signal, testConfig } from './helpers.js';

const indicatorConfig = {
  kdjLength: 2,
  kSmoothing: 2,
  dSmoothing: 2,
  emaFast: 1,
  emaSlow: 2,
  atrLength: 2,
};

test('configuration retains requested conservative defaults and hard upper bounds', () => {
  const config = testConfig();
  assert.equal(config.risk.riskPerTrade, 0.08);
  assert.equal(config.risk.dailyMaxLoss, 0.5);
  assert.equal(config.risk.maxLeverage, 10);
  assert.equal(config.risk.marginMode, 'ISOLATED');
  assert.equal(config.risk.compoundingEnabled, true);
  assert.equal(config.risk.martingaleEnabled, false);
  assert.equal(config.risk.maxOpenPositions, 10);
  assert.equal(config.live.allowLiveTrading, false);
  assert.equal(config.universe.autoDiscoverHighVolatility, true);
  assert.equal(config.universe.maxAssets, 100);
  assert.equal(config.universe.minDailyRangePct, 2);
  assert.throws(() => testConfig({ MAX_SCANNER_ASSETS: '101' }), /MAX_SCANNER_ASSETS/);
  assert.throws(() => testConfig({ MAX_SCANNER_ASSETS: '99.5' }), /MAX_SCANNER_ASSETS/);
  assert.throws(() => testConfig({ MIN_DAILY_RANGE_PCT: '0.05' }), /MIN_DAILY_RANGE_PCT/);
  assert.equal(testConfig({ AUTO_DISCOVER_HIGH_VOLATILITY: 'false' }).universe.autoDiscoverHighVolatility, false);
  assert.throws(() => testConfig({ MAX_LEVERAGE: '11' }), /MAX_LEVERAGE/);
  assert.throws(() => testConfig({ RISK_PER_TRADE: '0.081' }), /RISK_PER_TRADE/);
  assert.throws(() => testConfig({ MAX_OPEN_POSITIONS: '11' }), /MAX_OPEN_POSITIONS/);
});

test('volatility universe ranks eligible USDT perpetuals and enforces the 100-asset cap', () => {
  const catalog = [
    contract({ symbol: 'BTC_USDT' }),
    contract({ symbol: 'SOL_USDT' }),
    contract({ symbol: 'ETH_USDT' }),
    contract({ symbol: 'XRP_USDT', apiAllowed: false }),
    contract({ symbol: 'DOGE_USDT', state: 1 }),
    contract({ symbol: 'ADA_USDT', futureType: 2 }),
    contract({ symbol: 'BNB_BTC', quoteCoin: 'BTC', settleCoin: 'BTC' }),
  ];
  const tickers = [
    { symbol: 'BTC_USDT', lastPrice: 100, high24Price: 106, lower24Price: 94 },
    { symbol: 'SOL_USDT', lastPrice: 100, high24Price: 110, lower24Price: 90 },
    { symbol: 'ETH_USDT', lastPrice: 100, high24Price: 101, lower24Price: 99 },
    { symbol: 'XRP_USDT', lastPrice: 100, high24Price: 150, lower24Price: 50 },
    { symbol: 'DOGE_USDT', lastPrice: 100, high24Price: 150, lower24Price: 50 },
    { symbol: 'ADA_USDT', lastPrice: 100, high24Price: 150, lower24Price: 50 },
    { symbol: 'BNB_BTC', lastPrice: 100, high24Price: 150, lower24Price: 50 },
    { symbol: 'MISSING_USDT', lastPrice: 100, high24Price: 150, lower24Price: 50 },
    { symbol: 'BAD_USDT', lastPrice: 100, high24Price: 80, lower24Price: 90 },
  ];

  const selected = selectHighVolatilityAssets(catalog, tickers, 2, 2);
  assert.deepEqual(selected.map((asset) => asset.symbol), ['SOL_USDT', 'BTC_USDT']);
  assert.equal(selected[0]!.dailyRangePct, 20);
  assert.equal(selected[1]!.dailyRangePct, 12);
  assert.deepEqual(selectHighVolatilityAssets(catalog, tickers, 100, 20).map((asset) => asset.symbol), ['SOL_USDT']);
  assert.deepEqual(selectHighVolatilityAssets([], [], 100, 2), []);
  assert.throws(() => selectHighVolatilityAssets(catalog, tickers, 101, 2), /1 to 100/);
  assert.throws(() => selectHighVolatilityAssets(catalog, tickers, 1.5, 2), /1 to 100/);
});

test('automatic discovery fails closed instead of silently using the manual watchlist when empty', async () => {
  const adapter = {
    getContractSpecs: async () => [contract()],
    getTickers: async () => [],
  } as unknown as MexcFuturesAdapter;
  const stream = new MexcMarketStream(adapter, ['BTC_USDT'], 'wss://unused.invalid', {}, {
    autoDiscoverHighVolatility: true,
    maxAssets: 100,
    minDailyRangePct: 2,
  });
  await assert.rejects(stream.start(), /No enabled USDT perpetuals meet the 2% minimum 24-hour range/);
  assert.deepEqual(stream.getSymbols(), ['BTC_USDT']);
  assert.deepEqual(stream.getUniverse(), []);
  assert.equal(stream.status.connecting, false);
});

test('protective prices round to contract ticks without widening the initial stop', () => {
  assert.equal(roundPriceToTick(100.003, 0.05, 'UP'), 100.05);
  assert.equal(roundPriceToTick(100.003, 0.05, 'DOWN'), 100);
  assert.equal(roundPriceToTick(0.000001234, 0.0000001, 'UP'), 0.0000013);
  assert.throws(() => roundPriceToTick(100, 0, 'UP'), /finite positive/);

  const config = testConfig().risk;
  const assessment = assessPositionRisk({
    signal: signal({ close: 100.003, stopDistance: 1, targetDistance: 1.5 }),
    contract: contract({ priceUnit: 0.05 }),
    account: account(),
    positions: [],
    pendingEntries: [],
    config,
    context: { spreadRate: 0.0002, compoundingEnabled: true },
  });
  assert.equal(assessment.accepted, true, JSON.stringify(assessment));
  assert.equal(assessment.stopPrice, 99.05, 'long stop rounds toward entry, never farther away');
  assert.equal(assessment.takeProfitPrice, 101.5, 'long target rounds conservatively toward entry');
});

test('EMA uses a recursive EMA and ATR uses Wilder smoothing', () => {
  assert.deepEqual(calculateEma([100, 104, 102, 107], 3), [100, 102, 102, 104.5]);
  const bars = [
    candle(0, { open: 100, high: 102, low: 99, close: 100 }),
    candle(1, { open: 101, high: 105, low: 100, close: 104 }),
    candle(2, { open: 103, high: 104, low: 101, close: 102 }),
    candle(3, { open: 102, high: 108, low: 102, close: 107 }),
  ];
  const atr = calculateAtr(bars, 3);
  assert.deepEqual(atr.slice(0, 2), [null, null]);
  assert.ok(Math.abs(atr[2]! - 11 / 3) < 1e-12);
  assert.ok(Math.abs(atr[3]! - 40 / 9) < 1e-12);
});

test('KDJ uses smoothed RSV; incomplete candles are excluded and flat windows remain finite', () => {
  const bars = [
    candle(0, { open: 100, high: 102, low: 99, close: 100 }),
    candle(1, { open: 101, high: 105, low: 100, close: 104 }),
    candle(2, { open: 103, high: 104, low: 101, close: 102 }),
  ];
  const points = calculateIndicatorSeries(bars, indicatorConfig);
  assert.equal(points.length, 3);
  assert.ok(Math.abs(points[1]!.k - 200 / 3) < 1e-10);
  assert.ok(Math.abs(points[1]!.d - 175 / 3) < 1e-10);
  assert.ok(Math.abs(points[1]!.j - 250 / 3) < 1e-10);
  assert.equal(points[0]!.ready, false);
  assert.equal(points[1]!.ready, true);

  const incomplete = candle(3, { complete: false, open: Number.NaN, high: Number.NaN, low: Number.NaN, close: Number.NaN });
  assert.equal(calculateIndicatorSeries([...bars, incomplete], indicatorConfig).length, bars.length);

  const flat = calculateIndicatorSeries(candles(3, { open: 100, high: 100, low: 100, close: 100 }), indicatorConfig);
  for (const point of flat) {
    assert.equal(point.k, 50);
    assert.equal(point.d, 50);
    assert.equal(point.j, 50);
    assert.ok(Number.isFinite(point.emaFast));
  }
  assert.throws(() => calculateIndicatorSeries([bars[0]!, bars[0]!], indicatorConfig), /duplicate or out of chronological order/);
  assert.throws(() => calculateIndicatorSeries(bars, { ...indicatorConfig, kSmoothing: 1.5 }), /positive integers/);
});

function strategyContext(direction: 'LONG' | 'SHORT', options: { incompleteTail?: boolean; mutate?: (points: IndicatorPoint[]) => void } = {}) {
  const config = testConfig({ MIN_DEPTH_LIQUIDITY_USD: '0' });
  const completed = candles(25, { close: 100, high: 100.5, low: 99.5 });
  completed[completed.length - 1] = candle(24, { close: direction === 'LONG' ? 102 : 98, high: direction === 'LONG' ? 102.5 : 98.5, low: direction === 'LONG' ? 101.5 : 97.5 });
  const points: IndicatorPoint[] = completed.map((bar, index) => {
    const k = direction === 'LONG'
      ? (index === 23 ? 20 : index === 24 ? 24 : 22)
      : (index === 23 ? 80 : index === 24 ? 75 : 78);
    const d = direction === 'LONG'
      ? (index === 23 ? 21 : index === 24 ? 23 : 23)
      : (index === 23 ? 79 : index === 24 ? 76 : 77);
    return {
      openTime: bar.openTime,
      close: bar.close,
      high: bar.high,
      low: bar.low,
      k,
      d,
      j: 3 * k - 2 * d,
      emaFast: direction === 'LONG' ? 101 : 99,
      emaSlow: 100,
      atr: 1,
      ready: true,
    };
  });
  options.mutate?.(points);
  const tail = options.incompleteTail ? candle(25, { close: 1_000_000, high: 2_000_000, low: 1, complete: false }) : undefined;
  const now = completed.at(-1)!.openTime + 61_000;
  return {
    symbol: 'BTC_USDT',
    candles: tail ? [...completed, tail] : completed,
    indicatorPoints: points,
    market: {
      symbol: 'BTC_USDT',
      bid: direction === 'LONG' ? 101.99 : 97.99,
      ask: direction === 'LONG' ? 102.01 : 98.01,
      spreadRate: 0.0002,
      liquidityUsd: 100_000,
      observedAt: now,
      currentPrice: direction === 'LONG' ? 102 : 98,
    },
    contract: contract({ contractSize: 1, volUnit: 0.001, minVol: 0.001 }),
    now,
    config,
  };
}

test('strategy recognizes completed-candle long and short KDJ/EMA signals', () => {
  const long = evaluateSignal(strategyContext('LONG'));
  assert.equal(long.accepted, true, JSON.stringify(long));
  assert.equal(long.signal?.direction, 'LONG');

  const short = evaluateSignal(strategyContext('SHORT'));
  assert.equal(short.accepted, true, JSON.stringify(short));
  assert.equal(short.signal?.direction, 'SHORT');
});

test('strategy ignores an incomplete tail, does not chase an old cross, and enforces trend and freshness', () => {
  const withIncomplete = evaluateSignal(strategyContext('LONG', { incompleteTail: true }));
  assert.equal(withIncomplete.accepted, true, JSON.stringify(withIncomplete));
  assert.equal(withIncomplete.signal?.candleTime, candle(24).openTime);

  const noNewCross = evaluateSignal(strategyContext('LONG', { mutate: (points) => {
    points[23] = { ...points[23]!, k: 21, d: 20 };
  } }));
  assert.equal(noNewCross.accepted, false);
  assert.equal(noNewCross.reason, 'NO_CROSSOVER');

  const badTrend = evaluateSignal(strategyContext('LONG', { mutate: (points) => {
    points[24] = { ...points[24]!, emaFast: 99, emaSlow: 100 };
  } }));
  assert.equal(badTrend.reason, 'EMA_TREND');

  const stale = strategyContext('LONG');
  stale.market.observedAt -= stale.config.strategy.maxMarketDataAgeMs + 1;
  const staleDecision = evaluateSignal(stale);
  assert.equal(staleDecision.reason, 'STALE_MARKET_DATA');
});

test('risk sizing compounds only when enabled and never exceeds the tightest aggregate allowance', () => {
  const config = testConfig().risk;
  const base = {
    signal: signal(),
    contract: contract(),
    positions: [],
    pendingEntries: [],
    config: { ...config, maxMarginUtilization: 0.9 },
    context: { spreadRate: 0.0002, compoundingEnabled: true },
  };
  const equity = account({ equity: 20_000, availableMargin: 20_000, startingEquity: 10_000, dailyStartingEquity: 20_000 });
  const compounded = assessPositionRisk({ ...base, account: equity });
  const fixed = assessPositionRisk({ ...base, account: equity, context: { ...base.context, compoundingEnabled: false } });
  assert.equal(compounded.accepted, true, JSON.stringify(compounded));
  assert.equal(fixed.accepted, true, JSON.stringify(fixed));
  assert.ok(compounded.riskBudget > fixed.riskBudget);
  assert.ok(compounded.quantity > fixed.quantity * 1.9);
  assert.ok(compounded.estimatedRisk <= compounded.riskBudget + 1e-7);
  assert.ok(compounded.leverage <= 10);

  const almostFull = assessPositionRisk({
    ...base,
    account: account(),
    positions: [openPosition('ETH_USDT', 1_950)],
  });
  assert.equal(almostFull.accepted, true, JSON.stringify(almostFull));
  assert.ok(almostFull.riskBudget <= 50 + 1e-7);
  assert.ok(almostFull.aggregateRiskAfter <= 2_000 + 1e-7);

  const exhausted = assessPositionRisk({
    ...base,
    account: account(),
    positions: [openPosition('ETH_USDT', 2_000)],
  });
  assert.equal(exhausted.accepted, false);
  assert.equal(exhausted.reason, 'AGGREGATE_RISK_LIMIT');
});

test('risk independently enforces position count, duplicate-symbol, daily, and reconciliation locks', () => {
  const config = testConfig().risk;
  const common = {
    signal: signal(),
    contract: contract(),
    account: account(),
    positions: [] as ReturnType<typeof openPosition>[],
    pendingEntries: [] as Array<{ id: string; symbol: string; direction: 'LONG'; risk: number; margin: number; createdAt: number; status: 'PENDING' }>,
    config,
    context: { spreadRate: 0.0002, compoundingEnabled: true },
  };
  const ninePositions = Array.from({ length: 9 }, (_, index) => openPosition(`ALT${index}_USDT`, 1, index));
  const ten = assessPositionRisk({ ...common, positions: ninePositions, pendingEntries: [{ id: 'pending', symbol: 'XRP_USDT', direction: 'LONG', risk: 1, margin: 1, createdAt: 1, status: 'PENDING' }] });
  assert.equal(ten.reason, 'POSITION_LIMIT');

  const duplicate = assessPositionRisk({ ...common, pendingEntries: [{ id: 'pending', symbol: 'BTC_USDT', direction: 'LONG', risk: 1, margin: 1, createdAt: 1, status: 'PENDING' }] });
  assert.equal(duplicate.reason, 'DUPLICATE_OR_CONFLICTING_POSITION');

  const dailyLocked = assessPositionRisk({ ...common, account: account({ dailyLocked: true }) });
  assert.equal(dailyLocked.reason, 'DAILY_RISK_LOCK');
  const drawdownLimit = assessPositionRisk({ ...common, account: account({ dailyDrawdown: 5_000 }) });
  assert.equal(drawdownLimit.reason, 'DAILY_RISK_LOCK');
  const unreconciled = assessPositionRisk({ ...common, account: account({ reconciliationHealthy: false }) });
  assert.equal(unreconciled.reason, 'EXCHANGE_RECONCILIATION_REQUIRED');
});

test('modeled stop risk and round-trip costs include taker fees, spread, slippage, and signed funding', () => {
  const rates = { makerFeeRate: 0.0005, takerFeeRate: 0.001, slippageRate: 0.002, spreadRate: 0.004, contractSize: 0.1 };
  const costs = estimateRoundTripCosts(100, 110, 2, rates);
  assert.ok(Math.abs(costs.entryFee - 0.02) < 1e-12);
  assert.ok(Math.abs(costs.exitFee - 0.022) < 1e-12);
  assert.ok(Math.abs(costs.slippageCost - 0.084) < 1e-12);
  assert.ok(Math.abs(costs.spreadCost - 0.084) < 1e-12);
  assert.ok(estimateStopRiskPerContract('LONG', 100, 1, rates) > 0.1);
  assert.equal(fundingCashFlow('LONG', 0.01, 1_000), -10);
  assert.equal(fundingCashFlow('SHORT', 0.01, 1_000), 10);
});

test('daily drawdown and losing-streak locks survive date rollover until explicit reset', () => {
  const zone = 'America/New_York';
  assert.notEqual(accountDate(Date.parse('2026-01-01T02:00:00Z'), zone), accountDate(Date.parse('2026-01-01T08:00:00Z'), zone));
  const start = Date.parse('2026-01-01T12:00:00Z');
  const state = createDailyRiskState(10_000, start, zone);
  const lock = updateDailyRiskState({ state, equity: 4_999, timestamp: start + 60_000, timezone: zone, maxDailyLoss: 0.5, maxConsecutiveLosses: 3 });
  assert.equal(lock.state.locked, true);
  assert.equal(lock.newlyLocked, true);
  const nextDate = updateDailyRiskState({ state: lock.state, equity: 10_000, timestamp: start + 24 * 60 * 60_000, timezone: zone, maxDailyLoss: 0.5, maxConsecutiveLosses: 3 });
  assert.equal(nextDate.state.locked, true);
  assert.equal(nextDate.state.drawdown, 0);
  const reset = resetDailyRiskState(nextDate.state, 10_000, start + 24 * 60 * 60_000, zone);
  assert.equal(reset.locked, false);
  const streak = recordClosedTrade({ ...reset, consecutiveLosses: 2 }, -1, 3, start + 1);
  assert.equal(streak.state.consecutiveLossLocked, true);
  assert.equal(streak.state.locked, true);
});
