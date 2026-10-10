import assert from 'node:assert/strict';
import test from 'node:test';
import { chronologicalSplitRanges, runBacktest } from '../src/core/backtest.js';
import { candle, candles, contract, testConfig } from './helpers.js';

test('backtest returns chronological splits, conservative model disclosures, and deterministic stress scenarios', () => {
  const bars = candles(120, { open: 100, high: 100.5, low: 99.5, close: 100 });
  const report = runBacktest({
    barsBySymbol: { BTC_USDT: bars },
    contractsBySymbol: { BTC_USDT: contract({ contractSize: 1 }) },
    config: testConfig(),
    initialEquity: 10_000,
    assumedSpreadRate: 0.0004,
  });
  assert.equal(report.candleCount, 120);
  assert.deepEqual(report.symbols, ['BTC_USDT']);
  assert.ok(report.dataStart < report.dataEnd);
  assert.equal(report.splits.outOfSample.trades.length, 0, 'a flat KDJ series should not manufacture trades');
  assert.equal(report.splits.outOfSample.finalEquity, 10_000);
  assert.deepEqual(Object.keys(report.stressScenarios).sort(), [
    'api_outage_every_3rd_order', 'delayed_one_bar', 'fees_2x', 'gaps_0_5pct', 'half_fills', 'slippage_3x', 'spread_2x',
  ].sort());
  assert.ok(report.warnings.some((warning) => warning.includes('no profitability')));

  const ranges = chronologicalSplitRanges(bars.map((bar) => bar.openTime));
  assert.ok(ranges.development[1] <= ranges.validation[0]);
  assert.ok(ranges.validation[1] <= ranges.outOfSample[0]);
  assert.throws(() => runBacktest({
    barsBySymbol: { BTC_USDT: [bars[0]!, bars[0]!, bars[1]!] },
    contractsBySymbol: {},
    config: testConfig(),
  }), /Duplicate BTC_USDT candle/);
});

test('backtest executes deterministic entries and accounts for modeled fills and trading costs', () => {
  const config = testConfig({ EMA_FAST: '2', EMA_SLOW: '3', EMA_CROSS_COOLDOWN_CANDLES: '0' });
  const start = 1_700_000_040_000;
  const bars = [] as ReturnType<typeof candle>[];
  for (let index = 0; index < 600; index += 1) {
    const close = 100 + 0.05 * index + 5 * Math.sin(index * 0.025) + 2 * Math.sin(index * 0.11);
    const open = index ? bars[index - 1]!.close : close;
    bars.push(candle(index, { openTime: start + index * 60_000, open, high: Math.max(open, close) + 0.1,
      low: Math.min(open, close) - 0.1, close }));
  }
  const report = runBacktest({
    barsBySymbol: { BTC_USDT: bars },
    contractsBySymbol: { BTC_USDT: contract() },
    config,
    initialEquity: 10_000,
    assumedSpreadRate: 0.0004,
  });
  const trades = [...report.splits.development.trades, ...report.splits.validation.trades, ...report.splits.outOfSample.trades];
  assert.equal(trades.length, 2);
  assert.ok(trades.every((trade) => trade.fees > 0 && trade.slippage > 0 && Number.isFinite(trade.netPnl)));
  assert.ok([report.splits.development, report.splits.validation, report.splits.outOfSample]
    .every((segment) => segment.maxSimultaneousPositions <= 10));
});
