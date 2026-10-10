import { createHmac } from 'node:crypto';
import type { Candle, ContractSpec, Direction, OrderBookLevel, PositionRisk } from '../core/types.js';

export const MEXC_FUTURES_DOCS = {
  integration: 'https://www.mexc.com/api-docs/futures/integration-guide',
  contract: 'https://www.mexc.com/api-docs/futures/market-endpoints/get-contract-info',
  candles: 'https://www.mexc.com/api-docs/futures/market-endpoints/get-candlestick-data',
  orderBook: 'https://www.mexc.com/api-docs/futures/market-endpoints/get-contract-order-book-depth',
  assets: 'https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/get-all-account-assets',
  positions: 'https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/get-open-positions',
  orders: 'https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/place-order',
  protective: 'https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/place-tpsl-order-by-position',
  websocket: 'https://www.mexc.com/api-docs/futures/websocket-api/native-ws-endpoint',
} as const;

export interface MexcCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface MexcAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  recvWindowMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface MexcOrderRequest {
  symbol: string;
  side: 1 | 2 | 3 | 4;
  quantity: number;
  leverage: number;
  price?: number;
  externalOid: string;
  positionId?: string;
  positionMode?: 1 | 2;
  reduceOnly?: boolean;
}

export interface MexcOrderResult {
  orderId: string;
  externalOid?: string;
  state?: number;
  dealVol?: number;
  dealAvgPrice?: number;
  positionId?: string;
  raw: Record<string, unknown>;
}

export class MexcApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: number, readonly retryable = false) {
    super(message);
    this.name = 'MexcApiError';
  }
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalGetParameters(params: Record<string, unknown> = {}): string {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null)
    .sort()
    .map((key) => `${encode(key)}=${encode(String(params[key]))}`)
    .join('&');
}

export function createMexcSignature(apiKey: string, apiSecret: string, timestamp: string, parameterString: string): string {
  const payload = `${apiKey}${timestamp}${parameterString}`;
  return createHmac('sha256', apiSecret).update(payload, 'utf8').digest('hex');
}

export interface MexcEnvelope<T> {
  success: boolean;
  code?: number;
  message?: string;
  data: T;
}

export function parseMexcEnvelope<T>(raw: unknown): T {
  if (!raw || typeof raw !== 'object') throw new MexcApiError('MEXC returned an invalid response envelope.');
  const envelope = raw as Partial<MexcEnvelope<T>>;
  if (envelope.success === false) {
    throw new MexcApiError(
      `MEXC request rejected${envelope.code !== undefined ? ` (code ${envelope.code})` : ''}${envelope.message ? `: ${String(envelope.message).slice(0, 180)}` : ''}`,
      undefined,
      typeof envelope.code === 'number' ? envelope.code : undefined,
    );
  }
  if (envelope.success !== true) throw new MexcApiError('MEXC returned an unexpected response envelope.');
  return envelope.data as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  const object = asRecord(value);
  for (const key of ['list', 'rows', 'records', 'data']) {
    if (Array.isArray(object[key])) return (object[key] as unknown[]).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  }
  return [];
}

class RequestGate {
  private nextTime = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly minimumSpacingMs = 100) {}

  async wait(): Promise<void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => gate, () => gate);
    await previous;
    try {
      const wait = Math.max(0, this.nextTime - Date.now());
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.nextTime = Date.now() + this.minimumSpacingMs;
    } finally {
      release();
    }
  }
}

export class MexcFuturesAdapter {
  readonly baseUrl: string;
  private apiKey?: string;
  private apiSecret?: string;
  private readonly recvWindowMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly gate = new RequestGate(110);

  constructor(options: MexcAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.mexc.com').replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.recvWindowMs = options.recvWindowMs ?? 10_000;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get credentialsConfigured(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  /** Swap signing credentials in place. Callers must not do this while live orders are being managed. */
  setCredentials(apiKey: string | undefined, apiSecret: string | undefined): void {
    this.apiKey = apiKey?.trim() || undefined;
    this.apiSecret = apiSecret?.trim() || undefined;
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, unknown> = {}, signed = false): Promise<T> {
    if (signed && (!this.apiKey || !this.apiSecret)) throw new MexcApiError('MEXC private API credentials are not configured.');
    await this.gate.wait();
    const parameterString = method === 'GET' || method === 'DELETE' ? canonicalGetParameters(params) : JSON.stringify(params);
    const query = method === 'GET' || method === 'DELETE' ? parameterString : '';
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ''}`;
    const headers: Record<string, string> = { Accept: 'application/json', Language: 'en' };
    let body: string | undefined;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(params);
    }
    if (signed) {
      const timestamp = String(Date.now());
      headers.ApiKey = this.apiKey!;
      headers['Request-Time'] = timestamp;
      headers.Signature = createMexcSignature(this.apiKey!, this.apiSecret!, timestamp, parameterString);
      headers['Recv-Window'] = String(this.recvWindowMs);
    }

    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, { method, headers, body, signal: controller.signal });
        const responseText = await response.text();
        let json: unknown;
        try { json = responseText ? JSON.parse(responseText) : {}; }
        catch { throw new MexcApiError(`MEXC returned non-JSON data (HTTP ${response.status}).`, response.status, undefined, response.status >= 500); }
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && (method === 'GET' || method === 'DELETE') && attempt < 2) {
            attempt += 1;
            await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
            continue;
          }
          const code = finiteNumber(asRecord(json).code, NaN);
          throw new MexcApiError(`MEXC HTTP ${response.status}${Number.isFinite(code) ? ` (code ${code})` : ''}.`, response.status, Number.isFinite(code) ? code : undefined, retryable);
        }
        return parseMexcEnvelope<T>(json);
      } catch (error) {
        if (error instanceof MexcApiError) throw error;
        const aborted = error instanceof Error && error.name === 'AbortError';
        if (!aborted && error instanceof Error && error.name !== 'TypeError') throw new MexcApiError('MEXC request failed; response was not accepted as an execution.', undefined, undefined, true);
        if (method === 'GET' && attempt < 2) {
          attempt += 1;
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
          continue;
        }
        throw new MexcApiError(aborted ? 'MEXC request timed out; execution state must be reconciled before retrying.' : 'MEXC network request failed.', undefined, undefined, true);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  async getContractSpecs(symbols: string[] = []): Promise<ContractSpec[]> {
    const data = await this.request<unknown>('GET', '/api/v1/contract/detail/country', symbols.length === 1 ? { symbol: symbols[0] } : {});
    const contracts = Array.isArray(data) ? data : [data];
    const result: ContractSpec[] = [];
    for (const value of contracts) {
      const raw = asRecord(value);
      const symbol = text(raw.symbol);
      if (!symbol || (symbols.length > 0 && !symbols.includes(symbol))) continue;
      result.push({
        symbol,
        contractSize: finiteNumber(raw.contractSize),
        priceUnit: finiteNumber(raw.priceUnit),
        volUnit: finiteNumber(raw.volUnit),
        minVol: finiteNumber(raw.minVol),
        maxVol: finiteNumber(raw.maxVol),
        minLeverage: finiteNumber(raw.minLeverage, 1),
        maxLeverage: finiteNumber(raw.countryConfigContractMaxLeverage, finiteNumber(raw.maxLeverage)),
        makerFeeRate: finiteNumber(raw.makerFeeRate),
        takerFeeRate: finiteNumber(raw.takerFeeRate),
        maintenanceMarginRate: finiteNumber(raw.maintenanceMarginRate),
        state: finiteNumber(raw.state, -1),
        apiAllowed: raw.apiAllowed === true,
        futureType: finiteNumber(raw.futureType),
        quoteCoin: text(raw.quoteCoin),
        settleCoin: text(raw.settleCoin),
      });
    }
    return result;
  }

  async getTickers(): Promise<Array<Record<string, unknown>>> {
    return asArray(await this.request<unknown>('GET', '/api/v1/contract/ticker'));
  }

  async getCandles(symbol: string, start?: number, end?: number, interval = 'Min1'): Promise<Candle[]> {
    const intervals: Record<string, number> = {
      Min1: 60_000, Min5: 5 * 60_000, Min15: 15 * 60_000, Min30: 30 * 60_000,
      Min60: 60 * 60_000, Hour1: 60 * 60_000, Hour2: 2 * 60 * 60_000,
      Hour4: 4 * 60 * 60_000, Hour8: 8 * 60 * 60_000, Day1: 24 * 60 * 60_000,
    };
    const intervalDurationMs = intervals[interval];
    if (!intervalDurationMs) throw new MexcApiError(`Unsupported MEXC candle interval: ${interval}`);
    const params: Record<string, unknown> = { interval };
    if (start !== undefined) params.start = Math.floor(start / 1000);
    if (end !== undefined) params.end = Math.floor(end / 1000);
    const data = asRecord(await this.request<unknown>('GET', `/api/v1/contract/kline/${encodeURIComponent(symbol)}`, params));
    const times = data.time as unknown[] | undefined;
    const opens = data.open as unknown[] | undefined;
    const highs = data.high as unknown[] | undefined;
    const lows = data.low as unknown[] | undefined;
    const closes = data.close as unknown[] | undefined;
    const volumes = data.vol as unknown[] | undefined;
    if (![times, opens, highs, lows, closes, volumes].every(Array.isArray)) throw new MexcApiError('MEXC candle payload is incomplete.');
    const count = Math.min(times!.length, opens!.length, highs!.length, lows!.length, closes!.length, volumes!.length);
    return Array.from({ length: count }, (_, index) => ({
      symbol,
      openTime: finiteNumber(times![index]) * 1000,
      open: finiteNumber(opens![index]),
      high: finiteNumber(highs![index]),
      low: finiteNumber(lows![index]),
      close: finiteNumber(closes![index]),
      volume: finiteNumber(volumes![index]),
      complete: finiteNumber(times![index]) * 1000 + intervalDurationMs <= Date.now(),
    })).filter((candle) => candle.openTime > 0);
  }

  async getOrderBook(symbol: string, limit = 20): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[]; timestamp: number }> {
    const data = asRecord(await this.request<unknown>('GET', `/api/v1/contract/depth/${encodeURIComponent(symbol)}`, { limit }));
    const convert = (value: unknown): OrderBookLevel[] => Array.isArray(value) ? value.flatMap((entry) => {
      if (!Array.isArray(entry) || entry.length < 3) return [];
      const price = finiteNumber(entry[0]);
      const volume = finiteNumber(entry[2]);
      return price > 0 && volume >= 0 ? [{ price, volume }] : [];
    }) : [];
    return {
      bids: convert(data.bids),
      asks: convert(data.asks),
      timestamp: finiteNumber(data.timestamp, Date.now()),
    };
  }

  async getAssets(): Promise<Array<Record<string, unknown>>> {
    return asArray(await this.request<unknown>('GET', '/api/v1/private/account/assets', {}, true));
  }

  async getAccountSnapshot(): Promise<{ equity: number; availableMargin: number; unrealizedPnl: number }> {
    const assets = await this.getAssets();
    const usdt = assets.find((asset) => text(asset.currency).toUpperCase() === 'USDT');
    if (!usdt) throw new MexcApiError('No USDT futures asset was returned; account equity cannot be sized.');
    const equity = finiteNumber(usdt.equity, NaN);
    const availableMargin = finiteNumber(usdt.availableOpen, finiteNumber(usdt.availableBalance, NaN));
    const unrealizedPnl = finiteNumber(usdt.unrealized, 0);
    if (!(equity > 0) || !Number.isFinite(availableMargin) || availableMargin < 0) {
      throw new MexcApiError('MEXC returned an invalid USDT equity or available margin snapshot.');
    }
    return { equity, availableMargin, unrealizedPnl };
  }

  async getOpenPositions(): Promise<Array<Record<string, unknown>>> {
    const values = asArray(await this.request<unknown>('GET', '/api/v1/private/position/open_positions', {}, true));
    return values.filter((position) => finiteNumber(position.state) === 1 && finiteNumber(position.holdVol) > 0);
  }

  async getHistoricalPositions(input: { startTime?: number; endTime?: number; page?: number; pageSize?: number } = {}): Promise<Array<Record<string, unknown>>> {
    const params: Record<string, unknown> = {
      page_num: input.page ?? 1,
      page_size: Math.min(100, input.pageSize ?? 100),
    };
    if (input.startTime !== undefined) params.start_time = input.startTime;
    if (input.endTime !== undefined) params.end_time = input.endTime;
    return asArray(await this.request<unknown>('GET', '/api/v1/private/position/list/history_positions', params, true));
  }

  async getOpenOrders(): Promise<Array<Record<string, unknown>>> {
    return asArray(await this.request<unknown>('GET', '/api/v1/private/order/list/open_orders', { page_num: 1, page_size: 100 }, true));
  }

  async getOpenProtectiveOrders(symbol?: string): Promise<Array<Record<string, unknown>>> {
    return asArray(await this.request<unknown>('GET', '/api/v1/private/stoporder/open_orders', symbol ? { symbol } : {}, true));
  }

  async getFeeDetails(symbol?: string): Promise<Array<Record<string, unknown>> | Record<string, unknown>> {
    const data = await this.request<unknown>('GET', '/api/v1/private/account/tiered_fee_rate/v2', symbol ? { symbol } : {}, true);
    return Array.isArray(data) ? asArray(data) : asRecord(data);
  }

  async getPositionMode(): Promise<1 | 2> {
    const data = await this.request<unknown>('GET', '/api/v1/private/position/position_mode', {}, true);
    const object = Array.isArray(data) ? asRecord(data[0]) : asRecord(data);
    const mode = finiteNumber(object.positionMode, 1);
    return mode === 2 ? 2 : 1;
  }

  async getOrderById(orderId: string): Promise<MexcOrderResult> {
    const raw = asRecord(await this.request<unknown>('GET', `/api/v1/private/order/get/${encodeURIComponent(orderId)}`, {}, true));
    return this.mapOrder(raw);
  }

  async getOrderByExternalId(symbol: string, externalOid: string): Promise<MexcOrderResult | null> {
    try {
      const raw = asRecord(await this.request<unknown>(
        'GET',
        `/api/v1/private/order/external/${encodeURIComponent(symbol)}/${encodeURIComponent(externalOid)}`,
        {},
        true,
      ));
      return this.mapOrder(raw);
    } catch (error) {
      if (error instanceof MexcApiError && (error.status === 404 || [2040, 2042, 2001].includes(error.code ?? -1))) return null;
      throw error;
    }
  }

  private mapOrder(raw: Record<string, unknown>): MexcOrderResult {
    return {
      orderId: text(raw.orderId),
      externalOid: text(raw.externalOid) || undefined,
      state: Number.isFinite(finiteNumber(raw.state, NaN)) ? finiteNumber(raw.state) : undefined,
      dealVol: Number.isFinite(finiteNumber(raw.dealVol, NaN)) ? finiteNumber(raw.dealVol) : undefined,
      dealAvgPrice: Number.isFinite(finiteNumber(raw.dealAvgPrice, NaN)) ? finiteNumber(raw.dealAvgPrice) : undefined,
      positionId: text(raw.positionId) || undefined,
      raw,
    };
  }

  /** POST order/create. It is intentionally never retried automatically. */
  async placeOrder(order: MexcOrderRequest): Promise<MexcOrderResult> {
    const params: Record<string, unknown> = {
      symbol: order.symbol,
      price: order.price ?? 0,
      vol: order.quantity,
      leverage: order.leverage,
      side: order.side,
      type: 5,
      openType: 1,
      externalOid: order.externalOid,
      positionMode: order.positionMode ?? 1,
    };
    if (order.positionId) params.positionId = order.positionId;
    if (order.reduceOnly !== undefined) params.reduceOnly = order.reduceOnly;
    const raw = asRecord(await this.request<unknown>('POST', '/api/v1/private/order/create', params, true));
    const data = asRecord(raw);
    const result = this.mapOrder(data);
    if (!result.orderId) throw new MexcApiError('MEXC accepted a create request without returning an order id; reconcile by client id.');
    return { ...result, externalOid: order.externalOid, raw: data };
  }

  async cancelOrders(orderIds: string[]): Promise<unknown> {
    if (!orderIds.length) return [];
    if (orderIds.length > 50) throw new Error('MEXC order cancellation is limited to 50 ids per request.');
    return this.request<unknown>('POST', '/api/v1/private/order/cancel', { orderIds }, true);
  }

  async cancelOpenEntryOrders(): Promise<void> {
    const orders = await this.getOpenOrders();
    const ids = orders
      .filter((order) => [1, 3].includes(finiteNumber(order.side)) && finiteNumber(order.state) <= 2)
      .map((order) => text(order.orderId))
      .filter(Boolean);
    for (let index = 0; index < ids.length; index += 50) await this.cancelOrders(ids.slice(index, index + 50));
  }

  async placePositionProtection(input: {
    positionId: string;
    quantity: number;
    stopLossPrice: number;
    takeProfitPrice: number;
  }): Promise<string> {
    const data = await this.request<unknown>('POST', '/api/v1/private/stoporder/place', {
      lossTrend: 1,
      profitTrend: 1,
      positionId: input.positionId,
      vol: input.quantity,
      stopLossPrice: input.stopLossPrice,
      takeProfitPrice: input.takeProfitPrice,
      priceProtect: 0,
      profitLossVolType: 'SAME',
      volType: 2,
      takeProfitReverse: 2,
      stopLossReverse: 2,
      takeProfitType: 0,
      takeProfitOrderPrice: input.takeProfitPrice,
      stopLossType: 0,
      stopLossOrderPrice: input.stopLossPrice,
    }, true);
    return text(data);
  }

  async moveProtectiveStopToBreakeven(stopPlanOrderId: string, stopLossPrice: number): Promise<void> {
    await this.request<unknown>('POST', '/api/v1/private/stoporder/change_plan_price', {
      stopPlanOrderId,
      stopLossPrice,
      stopLossReverse: 2,
    }, true);
  }

  /** Close by MEXC side code and positionId; omit mode-dependent reduceOnly unless verified for the account. */
  async closePosition(input: {
    symbol: string;
    direction: Direction;
    quantity: number;
    leverage: number;
    positionId: string;
    positionMode: 1 | 2;
    externalOid: string;
  }): Promise<MexcOrderResult> {
    return this.placeOrder({
      symbol: input.symbol,
      side: input.direction === 'LONG' ? 4 : 2,
      quantity: input.quantity,
      leverage: input.leverage,
      externalOid: input.externalOid,
      positionId: input.positionId,
      positionMode: input.positionMode,
    });
  }

  async getRecentHistory(symbol: string, limit = 200): Promise<Candle[]> {
    const count = Math.max(1, Math.min(2000, Math.floor(limit)));
    const end = Math.floor(Date.now() / 60_000) * 60_000;
    const candles = await this.getCandles(symbol, end - count * 60_000, end, 'Min1');
    const cutoff = Date.now() - 60_000;
    return candles.filter((candle) => candle.complete && candle.openTime + 60_000 <= cutoff).slice(-count);
  }

  static normalizePosition(raw: Record<string, unknown>, contractSize: number): PositionRisk {
    const positionType = finiteNumber(raw.positionType);
    const direction: Direction = positionType === 1 ? 'LONG' : 'SHORT';
    const quantity = finiteNumber(raw.holdVol);
    const entryPrice = finiteNumber(raw.holdAvgPriceFullyScale, finiteNumber(raw.holdAvgPrice));
    const stopPrice = finiteNumber(raw.stopLossPrice, NaN);
    const stopRisk = Number.isFinite(stopPrice) ? Math.abs(entryPrice - stopPrice) * quantity * contractSize : Number.NaN;
    return {
      id: text(raw.positionId),
      symbol: text(raw.symbol),
      direction,
      quantity,
      entryPrice,
      stopPrice,
      stopRisk,
      marginUsed: finiteNumber(raw.im, finiteNumber(raw.oim)),
      unrealizedPnl: finiteNumber(raw.unRealizedPnl),
      openedAt: finiteNumber(raw.createTime, Date.now()),
      barsHeld: 0,
      breakevenMoved: false,
      takeProfitPrice: 0,
      exchangePositionId: text(raw.positionId),
      source: 'EXTERNAL',
      feesPaid: finiteNumber(raw.totalFee, finiteNumber(raw.fee)),
      // The API describes holdFee as signed cash flow: positive is received, negative is paid.
      fundingCashFlow: finiteNumber(raw.holdFee),
    };
  }
}
