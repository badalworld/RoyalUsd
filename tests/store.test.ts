import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteAuditStore } from '../src/server/store.js';
import { candle } from './helpers.js';

test('SQLite audit transactions preserve runtime state, events, idempotent order intents, and chronological candles', async () => {
  const store = new SqliteAuditStore(':memory:');
  try {
    await store.setState('risk-lock', { locked: true, reason: 'DAILY_MAX_LOSS' });
    assert.deepEqual(await store.getState('risk-lock'), { locked: true, reason: 'DAILY_MAX_LOSS' });

    await store.appendEvent({
      type: 'order.intent', symbol: 'BTC_USDT', occurredAt: 100, correlationId: 'client-1',
      payload: { clientOrderId: 'client-1', status: 'INTENT', request: { side: 'LONG' } },
    });
    await store.appendEvent({
      type: 'order.intent', symbol: 'BTC_USDT', occurredAt: 200, correlationId: 'client-1',
      payload: { clientOrderId: 'client-1', status: 'ACKNOWLEDGED', exchangeOrderId: 'exchange-1', request: { side: 'LONG' } },
    });
    const events = await store.listEvents({ type: 'order.intent', limit: 10 });
    assert.equal(events.length, 2, 'audit history should remain append-only');
    assert.equal(events[0]!.payload.status, 'ACKNOWLEDGED');

    await store.upsertCandles('BTC_USDT', [candle(2), candle(0), candle(1)]);
    const rows = await store.getCandles('BTC_USDT', 10);
    assert.deepEqual(rows.map((row) => row.openTime), [candle(0).openTime, candle(1).openTime, candle(2).openTime]);
    await store.upsertCandles('BTC_USDT', [candle(1, { close: 101, high: 101.5 })]);
    assert.equal((await store.getCandles('BTC_USDT', 10))[1]!.close, 101);
  } finally {
    await store.close();
  }
});
