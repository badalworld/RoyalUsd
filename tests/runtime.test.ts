import assert from 'node:assert/strict';
import test from 'node:test';
import { MexcFuturesAdapter } from '../src/exchange/mexc.js';
import { TradingRuntime } from '../src/server/runtime.js';
import { SqliteAuditStore } from '../src/server/store.js';
import { testConfig } from './helpers.js';

function countingExchange(counter: { calls: number }): MexcFuturesAdapter {
  return new MexcFuturesAdapter({
    apiKey: 'fixture-key',
    apiSecret: 'fixture-secret',
    fetchImpl: async () => {
      counter.calls += 1;
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

test('LIVE requires explicit confirmation and all server-side readiness gates; PAPER makes no private exchange calls', async () => {
  const store = new SqliteAuditStore(':memory:');
  const counter = { calls: 0 };
  const runtime = new TradingRuntime(testConfig(), store, countingExchange(counter));
  try {
    const before = await runtime.dashboard();
    assert.equal(before.mode, 'PAPER');
    assert.equal(before.config.liveTradingDefault, false);
    await assert.rejects(runtime.enableLive('yes'), /Confirmation must exactly match/);
    await assert.rejects(runtime.enableLive('ENABLE LIVE TRADING'), /Live mode is blocked/);
    assert.equal((await runtime.dashboard()).mode, 'PAPER');
    assert.equal(counter.calls, 0, 'a readiness refusal must not touch private MEXC endpoints or place orders');
  } finally {
    await store.close();
  }
});

test('restart recovery never resumes a persisted LIVE process automatically', async () => {
  const store = new SqliteAuditStore(':memory:');
  const counter = { calls: 0 };
  try {
    await store.setState('trading-runtime', {
      mode: 'LIVE',
      running: true,
      paused: false,
      positions: [],
    });
    const runtime = new TradingRuntime(testConfig(), store, countingExchange(counter));
    const data = await runtime.dashboard();
    assert.equal(data.mode, 'LIVE');
    assert.equal(data.started, false);
    assert.equal(data.paused, true);
    assert.match(data.liveBlockReason ?? '', /Restart recovery required/);
    assert.equal(data.status, 'LOCKED');
    assert.equal(counter.calls, 0, 'startup recovery should pause pending an explicit exchange reconciliation');
  } finally {
    await store.close();
  }
});
