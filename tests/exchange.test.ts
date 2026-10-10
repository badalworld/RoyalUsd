import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalGetParameters, createMexcSignature, MexcApiError, MexcFuturesAdapter } from '../src/exchange/mexc.js';

test('MEXC GET signing sorts and encodes parameters while omitting null values', () => {
  assert.equal(canonicalGetParameters({ z: 'a b', symbol: 'BTC_USDT', omitted: undefined, nil: null }), 'symbol=BTC_USDT&z=a%20b');
  const first = createMexcSignature('api-key', 'secret', '1700000000000', 'symbol=BTC_USDT');
  const second = createMexcSignature('api-key', 'secret', '1700000000000', 'symbol=BTC_USDT');
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, createMexcSignature('api-key', 'secret', '1700000000001', 'symbol=BTC_USDT'));
});

test('private POST signs the exact JSON body and submits once with an external order id', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const adapter = new MexcFuturesAdapter({
    baseUrl: 'https://unit.test',
    apiKey: 'fixture-key',
    apiSecret: 'fixture-secret',
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ success: true, data: { orderId: 'exchange-123', state: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const result = await adapter.placeOrder({
    symbol: 'BTC_USDT', side: 1, quantity: 2.5, leverage: 5, externalOid: 'royalusd-test-0001', positionMode: 1,
  });
  assert.equal(result.orderId, 'exchange-123');
  assert.equal(result.externalOid, 'royalusd-test-0001');
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/api\/v1\/private\/order\/create$/);
  assert.equal(calls[0]!.init?.method, 'POST');
  const headers = calls[0]!.init?.headers as Record<string, string>;
  const body = String(calls[0]!.init?.body);
  assert.equal(headers.ApiKey, 'fixture-key');
  assert.equal(headers.Signature, createMexcSignature('fixture-key', 'fixture-secret', headers['Request-Time']!, body));
  assert.equal(JSON.stringify(JSON.parse(body)), body);
});

test('ambiguous order POST network failures are never automatically retried', async () => {
  let attempts = 0;
  const adapter = new MexcFuturesAdapter({
    apiKey: 'fixture-key', apiSecret: 'fixture-secret', timeoutMs: 500,
    fetchImpl: async () => {
      attempts += 1;
      throw new TypeError('fixture network failure');
    },
  });
  await assert.rejects(adapter.placeOrder({
    symbol: 'BTC_USDT', side: 3, quantity: 1, leverage: 2, externalOid: 'royalusd-no-retry',
  }), (error: unknown) => error instanceof MexcApiError && error.retryable);
  assert.equal(attempts, 1);
});

test('public ticker discovery requests the MEXC futures market-data endpoint', async () => {
  let requestedUrl = '';
  const adapter = new MexcFuturesAdapter({
    baseUrl: 'https://unit.test',
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ success: true, data: [
        { symbol: 'BTC_USDT', lastPrice: 100, high24Price: 105, lower24Price: 95 },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const tickers = await adapter.getTickers();
  assert.match(requestedUrl, /\/api\/v1\/contract\/ticker$/);
  assert.equal(tickers.length, 1);
  assert.equal(tickers[0]!.symbol, 'BTC_USDT');
  assert.equal(tickers[0]!.high24Price, 105);
});

test('public candle response maps Unix seconds and marks only closed bars complete', async () => {
  const adapter = new MexcFuturesAdapter({
    baseUrl: 'https://unit.test',
    fetchImpl: async () => new Response(JSON.stringify({ success: true, data: {
      time: [1_700_000_040], open: [100], high: [102], low: [99], close: [101], vol: [12],
    } }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const bars = await adapter.getCandles('BTC_USDT', 1_700_000_040_000, 1_700_000_100_000);
  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.openTime, 1_700_000_040_000);
  assert.equal(bars[0]!.complete, true);

  const currentOpen = Math.floor(Date.now() / 60_000) * 60 + 60;
  const liveBarAdapter = new MexcFuturesAdapter({
    baseUrl: 'https://unit.test',
    fetchImpl: async () => new Response(JSON.stringify({ success: true, data: {
      time: [currentOpen], open: [100], high: [102], low: [99], close: [101], vol: [12],
    } }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const liveBar = await liveBarAdapter.getCandles('BTC_USDT');
  assert.equal(liveBar[0]!.complete, false);
});
