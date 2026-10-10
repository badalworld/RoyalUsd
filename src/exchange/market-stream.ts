import WebSocket from 'ws';
import type { Candle, ContractSpec, MarketContext, OrderBookLevel } from '../core/types.js';
import { selectHighVolatilityAssets, type HighVolatilityAsset } from '../core/universe.js';
import { MexcFuturesAdapter } from './mexc.js';

export interface MarketStreamStatus {
  connected: boolean;
  connecting: boolean;
  lastMessageAt: number | null;
  reconnectCount: number;
  error?: string;
}

export interface MarketStreamHandlers {
  onContracts?: (contracts: Map<string, ContractSpec>) => void;
  onUniverse?: (assets: HighVolatilityAsset[], subscribedSymbols: string[]) => void;
  onMarket?: (market: MarketContext) => Promise<void> | void;
  onCompletedCandle?: (symbol: string, candle: Candle, nextOpen: number) => Promise<void> | void;
  onGap?: (symbol: string, expected: number, received: number) => void;
  onStatus?: (status: MarketStreamStatus) => void;
  onError?: (error: Error) => void;
}

export interface MarketStreamOptions {
  autoDiscoverHighVolatility?: boolean;
  maxAssets?: number;
  minDailyRangePct?: number;
  additionalSymbols?: () => string[];
}

interface SymbolState {
  candles: Candle[];
  current?: Candle;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  bid: number;
  ask: number;
  lastPrice: number;
  liquidityUsd: number;
  observedAt: number;
}

const CANDLE_MS = 60_000;
const MAX_HISTORY = 600;

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function levels(value: unknown): OrderBookLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!Array.isArray(entry) || entry.length < 3) return [];
    const price = number(entry[0]);
    const volume = number(entry[2]);
    return price > 0 && volume >= 0 ? [{ price, volume }] : [];
  });
}

export class MexcMarketStream {
  private socket?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = true;
  private reconnectCount = 0;
  private currentDelay = 1_000;
  private contracts = new Map<string, ContractSpec>();
  private states = new Map<string, SymbolState>();
  private symbols: string[];
  private universe: HighVolatilityAsset[] = [];
  private lastError?: string;

  constructor(
    private readonly adapter: MexcFuturesAdapter,
    symbols: string[],
    private readonly websocketUrl: string,
    private readonly handlers: MarketStreamHandlers,
    private readonly options: MarketStreamOptions = {},
  ) {
    this.symbols = [...symbols];
    for (const symbol of this.symbols) {
      this.states.set(symbol, { candles: [], bids: [], asks: [], bid: 0, ask: 0, lastPrice: 0, liquidityUsd: 0, observedAt: 0 });
    }
  }

  get status(): MarketStreamStatus {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      connecting: this.socket?.readyState === WebSocket.CONNECTING,
      lastMessageAt: [...this.states.values()].reduce((latest, state) => Math.max(latest, state.observedAt), 0) || null,
      reconnectCount: this.reconnectCount,
      error: this.lastError,
    };
  }

  getContract(symbol: string): ContractSpec | undefined { return this.contracts.get(symbol); }
  getContracts(): Map<string, ContractSpec> { return new Map(this.contracts); }
  getSymbols(): string[] { return [...this.symbols]; }
  getUniverse(): HighVolatilityAsset[] { return this.universe.map((asset) => ({ ...asset })); }
  getCandles(symbol: string): Candle[] { return [...(this.states.get(symbol)?.candles ?? [])]; }

  getMarket(symbol: string): MarketContext | undefined {
    const state = this.states.get(symbol);
    if (!state || state.bid <= 0 || state.ask <= 0 || state.ask < state.bid) return undefined;
    const mid = (state.ask + state.bid) / 2;
    return {
      symbol,
      bid: state.bid,
      ask: state.ask,
      spreadRate: mid > 0 ? (state.ask - state.bid) / mid : Number.POSITIVE_INFINITY,
      liquidityUsd: state.liquidityUsd,
      observedAt: state.observedAt,
      currentPrice: state.lastPrice || mid,
    };
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.setStatus();
    if (this.options.autoDiscoverHighVolatility) {
      try {
        const [catalog, tickers] = await Promise.all([
          this.adapter.getContractSpecs(),
          this.adapter.getTickers(),
        ]);
        const maxAssets = this.options.maxAssets ?? 100;
        const forcedSymbols = [...new Set(this.options.additionalSymbols?.() ?? [])].filter(Boolean);
        if (forcedSymbols.length > maxAssets) throw new Error('Managed positions exceed the configured scanner subscription cap.');
        const catalogSymbols = new Set(catalog.map((contract) => contract.symbol));
        const missingManaged = forcedSymbols.filter((symbol) => !catalogSymbols.has(symbol));
        if (missingManaged.length) throw new Error(`Contract metadata is missing for managed symbol(s): ${missingManaged.join(', ')}.`);
        const candidateLimit = maxAssets - forcedSymbols.length;
        this.universe = candidateLimit > 0
          ? selectHighVolatilityAssets(catalog, tickers, candidateLimit, this.options.minDailyRangePct ?? 2)
          : [];
        if (!this.universe.length && !forcedSymbols.length) {
          throw new Error(`No enabled USDT perpetuals meet the ${this.options.minDailyRangePct ?? 2}% minimum 24-hour range.`);
        }
        this.symbols = [...new Set([...forcedSymbols, ...this.universe.map((asset) => asset.symbol)])];
        this.contracts = new Map(catalog.map((spec) => [spec.symbol, spec]));
        const oldStates = this.states;
        this.states = new Map(this.symbols.map((symbol) => [symbol, oldStates.get(symbol)
          ?? { candles: [], bids: [], asks: [], bid: 0, ask: 0, lastPrice: 0, liquidityUsd: 0, observedAt: 0 }]));
        this.handlers.onContracts?.(new Map(this.contracts));
        this.handlers.onUniverse?.(this.getUniverse(), this.getSymbols());
      } catch (error) {
        this.stopped = true;
        this.report(error);
        throw error;
      }
    } else {
      this.universe = [];
      try {
        const specs = await this.adapter.getContractSpecs(this.symbols);
        this.contracts = new Map(specs.map((spec) => [spec.symbol, spec]));
        this.handlers.onContracts?.(new Map(this.contracts));
      } catch (error) {
        this.report(error);
      }
    }
    await Promise.all(this.symbols.map(async (symbol) => {
      try {
        const history = await this.adapter.getRecentHistory(symbol, MAX_HISTORY);
        const state = this.states.get(symbol)!;
        state.candles = history.filter((candle) => candle.complete).slice(-MAX_HISTORY);
      } catch (error) {
        this.report(error);
      }
    }));
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeat = undefined;
    this.reconnectTimer = undefined;
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, 'operator stop');
    this.socket = undefined;
    this.setStatus();
  }

  private setStatus(): void { this.handlers.onStatus?.(this.status); }

  private report(error: unknown): void {
    const safe = error instanceof Error ? error : new Error('Unknown MEXC market-data error');
    this.lastError = safe.message.slice(0, 240);
    this.handlers.onError?.(safe);
    this.setStatus();
  }

  private connect(): void {
    if (this.stopped) return;
    try {
      this.socket = new WebSocket(this.websocketUrl, { handshakeTimeout: 10_000, perMessageDeflate: false });
      this.socket.on('open', () => {
        this.currentDelay = 1_000;
        this.lastError = undefined;
        this.reconnectCount = 0;
        this.socket?.send(JSON.stringify({ method: 'sub.tickers', param: {}, gzip: false }));
        for (const symbol of this.symbols) {
          this.socket?.send(JSON.stringify({ method: 'sub.kline', param: { symbol, interval: 'Min1' }, gzip: false }));
          this.socket?.send(JSON.stringify({ method: 'sub.depth', param: { symbol }, gzip: false }));
        }
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => {
          if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ method: 'ping' }));
        }, 15_000);
        this.setStatus();
      });
      this.socket.on('message', (payload) => {
        try {
          const message = JSON.parse(payload.toString()) as unknown;
          this.consume(record(message));
        } catch (error) {
          this.report(error instanceof Error ? error : new Error('Unable to decode MEXC WebSocket message'));
        }
      });
      this.socket.on('error', (error) => this.report(error));
      this.socket.on('close', () => {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = undefined;
        this.socket = undefined;
        this.setStatus();
        if (!this.stopped) this.scheduleReconnect();
      });
    } catch (error) {
      this.report(error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectCount += 1;
    const delay = Math.min(30_000, this.currentDelay) + Math.floor(Math.random() * 250);
    this.currentDelay = Math.min(30_000, this.currentDelay * 2);
    this.lastError = `WebSocket disconnected; reconnecting in ${Math.round(delay / 1000)}s`;
    this.setStatus();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private consume(message: Record<string, unknown>): void {
    const channel = String(message.channel ?? '');
    if (channel === 'pong' || channel === 'rs.sub.kline' || channel === 'rs.sub.depth' || channel === 'rs.sub.tickers') return;
    const symbol = String(message.symbol ?? record(message.data).symbol ?? '');
    const state = this.states.get(symbol);
    if (!state) return;
    const data = record(message.data);
    const receivedAt = Date.now();
    state.observedAt = receivedAt;

    if (channel === 'push.depth') {
      state.bids = levels(data.bids);
      state.asks = levels(data.asks);
      state.bid = state.bids[0]?.price ?? state.bid;
      state.ask = state.asks[0]?.price ?? state.ask;
      const spec = this.contracts.get(symbol);
      const multiplier = spec?.contractSize ?? 1;
      state.liquidityUsd = [...state.bids.slice(0, 10), ...state.asks.slice(0, 10)]
        .reduce((sum, level) => sum + level.price * level.volume * multiplier, 0);
      this.emitMarket(symbol, state);
      return;
    }

    if (channel === 'push.tickers' || channel === 'push.ticker') {
      const tickerItems = Array.isArray(message.data) ? message.data : [message.data];
      for (const item of tickerItems) {
        const ticker = record(item);
        const tickerSymbol = String(ticker.symbol ?? message.symbol ?? '');
        const tickerState = this.states.get(tickerSymbol);
        if (!tickerState) continue;
        tickerState.bid = number(ticker.bid1) || tickerState.bid;
        tickerState.ask = number(ticker.ask1) || tickerState.ask;
        tickerState.lastPrice = number(ticker.lastPrice) || tickerState.lastPrice;
        tickerState.observedAt = receivedAt;
        this.emitMarket(tickerSymbol, tickerState);
      }
      return;
    }

    if (channel === 'push.kline') {
      const openTime = number(data.t) * 1000;
      const candle: Candle = {
        symbol,
        openTime,
        open: number(data.o),
        high: number(data.h),
        low: number(data.l),
        close: number(data.c),
        volume: number(data.v ?? data.q),
        complete: false,
      };
      if (!openTime || ![candle.open, candle.high, candle.low, candle.close].every((value) => value > 0)) return;
      if (state.current && openTime < state.current.openTime) return;
      if (!state.current) {
        state.current = candle;
        state.lastPrice = candle.close;
        return;
      }
      if (openTime === state.current.openTime) {
        state.current = { ...state.current, ...candle };
        state.lastPrice = candle.close;
        return;
      }

      const previous = { ...state.current, complete: true };
      const gap = openTime - previous.openTime;
      state.current = candle;
      state.lastPrice = candle.close;
      if (gap !== CANDLE_MS) {
        this.handlers.onGap?.(symbol, previous.openTime + CANDLE_MS, openTime);
        // Do not emit a signal over a missing interval. Rebuild history before trading again.
        void this.refreshHistory(symbol);
        return;
      }
      if (state.candles.at(-1)?.openTime !== previous.openTime) state.candles.push(previous);
      state.candles = state.candles.slice(-MAX_HISTORY);
      void Promise.resolve(this.handlers.onCompletedCandle?.(symbol, previous, candle.open)).catch((error) => this.report(error));
    }
  }

  private emitMarket(symbol: string, state: SymbolState): void {
    if (state.bid <= 0 || state.ask <= 0 || state.ask < state.bid) return;
    const mid = (state.bid + state.ask) / 2;
    void Promise.resolve(this.handlers.onMarket?.({
      symbol,
      bid: state.bid,
      ask: state.ask,
      spreadRate: mid > 0 ? (state.ask - state.bid) / mid : Number.POSITIVE_INFINITY,
      liquidityUsd: state.liquidityUsd,
      observedAt: state.observedAt,
      currentPrice: state.lastPrice || mid,
    })).catch((error) => this.report(error));
  }

  private async refreshHistory(symbol: string): Promise<void> {
    try {
      const candles = await this.adapter.getRecentHistory(symbol, MAX_HISTORY);
      const state = this.states.get(symbol);
      if (state) state.candles = candles.filter((candle) => candle.complete).slice(-MAX_HISTORY);
    } catch (error) {
      this.report(error);
    }
  }
}
