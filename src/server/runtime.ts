import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../core/config.js';
import { getLiveReadiness } from '../core/config.js';
import { AsyncMutex } from '../core/mutex.js';
import { assessPositionRisk, sumAggregateRisk } from '../core/risk.js';
import { calculateIndicatorSeries } from '../core/indicators.js';
import { costAwareBreakevenStop, estimateStopRiskPerContract, roundPriceToTick } from '../core/accounting.js';
import { createDailyRiskState, recordClosedTrade, resetDailyRiskState, updateDailyRiskState, type DailyRiskState } from '../core/daily-risk.js';
import { evaluateSignal } from '../core/strategy.js';
import type {
  AccountSnapshot,
  AuditEvent,
  BacktestTrade,
  Candle,
  ContractSpec,
  MarketContext,
  PendingEntry,
  PositionRisk,
  RiskAccountSnapshot,
  RiskAssessment,
  SignalRecord,
  StrategySignal,
  TradingMode,
} from '../core/types.js';
import { MexcApiError, MexcFuturesAdapter, type MexcOrderResult } from '../exchange/mexc.js';
import { MexcMarketStream, type MarketStreamStatus } from '../exchange/market-stream.js';
import type { AuditStore } from './store.js';

interface ManagedPosition extends PositionRisk {
  entryReferencePrice: number;
  entryFee: number;
  entrySlippage: number;
  entrySpread: number;
  entryRisk: number;
  stopDistance: number;
  contractSize: number;
  takerFeeRate: number;
  slippageRate: number;
  spreadRate: number;
  initialStopPrice: number;
  originalTakeProfit: number;
  externalOrderId?: string;
}

interface RuntimePersistentState {
  mode: TradingMode;
  running: boolean;
  paused: boolean;
  compoundingEnabled: boolean;
  paperCash: number;
  startingEquity: number;
  positions: ManagedPosition[];
  trades: BacktestTrade[];
  signalRecords: SignalRecord[];
  pendingEntries: PendingEntry[];
  dailyRisk?: DailyRiskState;
  processedCandleTimes: Record<string, number>;
  totalFees: number;
  totalSlippage: number;
  totalFundingCashFlow: number;
  liveRealizedPnl: number;
  startedAt?: number;
  liveBlockReason?: string;
}

interface LiveAccountSnapshot {
  equity: number;
  availableMargin: number;
  unrealizedPnl: number;
  updatedAt: number;
}

export interface DashboardMarket {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  spreadRate: number;
  liquidityUsd: number;
  volatilityPct?: number;
  stale: boolean;
  observedAt: number | null;
  indicators?: ReturnType<typeof calculateIndicatorSeries>[number];
  contractEnabled: boolean | null;
  error?: string;
}

export interface DashboardData {
  name: 'Royal USD';
  exchange: string;
  timeframe: string;
  mode: TradingMode;
  status: string;
  started: boolean;
  paused: boolean;
  marketStream: MarketStreamStatus;
  marketDataFresh: boolean;
  liveReady: boolean;
  liveBlockers: string[];
  liveBlockReason?: string;
  config: {
    symbols: string[];
    universe: AppConfig['universe'] & { selectedHighVolatilityAssets: number };
    indicators: AppConfig['indicators'];
    strategy: AppConfig['strategy'];
    risk: AppConfig['risk'];
    compoundingEnabled: boolean;
    liveTradingDefault: false;
    maxSimultaneousPositions: number;
  };
  account: AccountSnapshot;
  positions: Array<PositionRisk & { currentPrice: number; unrealizedPnl: number; pnlPct: number }>;
  pendingOrders: PendingEntry[];
  markets: DashboardMarket[];
  tradeHistory: BacktestTrade[];
  signals: SignalRecord[];
  equityCurve: Array<{ timestamp: number; equity: number; realizedPnl: number; unrealizedPnl: number }>;
  alerts: Array<{ type: string; at: number; message: string; symbol?: string }>;
  performance: {
    totalTrades: number;
    winRatePct: number;
    profitFactor: number;
    grossPnl: number;
    netPnl: number;
    fees: number;
    fundingCashFlow: number;
    averageTrade: number;
  };
  updatedAt: number;
}

const DEFAULT_STATE = (config: AppConfig): RuntimePersistentState => ({
  mode: 'PAPER',
  running: false,
  paused: false,
  compoundingEnabled: config.risk.compoundingEnabled,
  paperCash: config.risk.paperInitialEquity,
  startingEquity: config.risk.paperInitialEquity,
  positions: [],
  trades: [],
  signalRecords: [],
  pendingEntries: [],
  processedCandleTimes: {},
  totalFees: 0,
  totalSlippage: 0,
  totalFundingCashFlow: 0,
  liveRealizedPnl: 0,
});

function finite(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function text(value: unknown): string { return value === undefined || value === null ? '' : String(value); }
function sign(direction: 'LONG' | 'SHORT'): number { return direction === 'LONG' ? 1 : -1; }
function near(a: number, b: number, tolerance: number): boolean { return Math.abs(a - b) <= tolerance; }

function signalDetails(signal: StrategySignal): Record<string, unknown> {
  return {
    symbol: signal.symbol,
    direction: signal.direction,
    candleTime: signal.candleTime,
    close: signal.close,
    atr: signal.atr,
    stopDistance: signal.stopDistance,
    targetDistance: signal.targetDistance,
    estimatedNetRewardPerContract: signal.estimatedNetRewardPerContract,
    indicators: signal.indicators,
  };
}

export class TradingRuntime {
  private state: RuntimePersistentState;
  private readonly mutex = new AsyncMutex();
  private readonly marketStream: MexcMarketStream;
  private readonly marketContexts = new Map<string, MarketContext>();
  private readonly streamErrors = new Map<string, string>();
  private contracts = new Map<string, ContractSpec>();
  private liveAccount?: LiveAccountSnapshot;
  private liveReconciliationHealthy = false;
  private lastLiveReconcileAt = 0;
  private liveReconcileQueued = false;
  private lastRiskCheckAt = 0;
  private marketGapSymbols = new Set<string>();
  private isInitialized = false;
  private shutdownRequested = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: AuditStore,
    private readonly exchange: MexcFuturesAdapter,
  ) {
    this.state = DEFAULT_STATE(config);
    this.marketStream = new MexcMarketStream(exchange, config.symbols, config.mexcWebsocketUrl, {
      onContracts: (contracts) => {
        this.contracts = contracts;
      },
      onUniverse: (assets, subscribedSymbols) => {
        this.config.symbols.splice(0, this.config.symbols.length, ...subscribedSymbols);
        void this.record('universe.selected', {
          screening: '24-hour high-low range / last price',
          minimumRangePct: this.config.universe.minDailyRangePct,
          maximumAssets: this.config.universe.maxAssets,
          selectedHighVolatilityAssets: assets.length,
          subscribedSymbols,
          candidates: assets,
        });
      },
      onMarket: (market) => this.onMarket(market),
      onCompletedCandle: (symbol, candle, nextOpen) => this.handleCompletedCandle(symbol, candle, nextOpen),
      onGap: (symbol, expected, received) => {
        this.marketGapSymbols.add(symbol);
        void this.record('market.gap', { symbol, expected, received }, symbol);
      },
      onStatus: (status) => {
        if (status.error) this.streamErrors.set('stream', status.error);
      },
      onError: (error) => {
        this.streamErrors.set('stream', error.message.slice(0, 240));
        void this.record('system.error', { component: 'market-stream', message: error.message.slice(0, 240) });
      },
    }, {
      autoDiscoverHighVolatility: config.universe.autoDiscoverHighVolatility,
      maxAssets: config.universe.maxAssets,
      minDailyRangePct: config.universe.minDailyRangePct,
      additionalSymbols: () => [...new Set([
        ...this.state.positions.map((position) => position.symbol),
        ...this.state.pendingEntries.map((entry) => entry.symbol),
      ])],
    });
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    const restored = await this.store.getState<RuntimePersistentState>('trading-runtime');
    if (restored && restored.mode && Array.isArray(restored.positions)) {
      this.state = { ...DEFAULT_STATE(this.config), ...restored };
      // Never resume an engine or an API connection automatically after a process restart.
      if (this.state.running || this.state.mode === 'LIVE') {
        this.state.running = false;
        this.state.paused = true;
        this.state.liveBlockReason = this.state.mode === 'LIVE'
          ? 'Restart recovery required; live trading is paused until exchange reconciliation succeeds.'
          : this.state.liveBlockReason;
        await this.record('recovery.restart', { previousMode: restored.mode, recoveredPositions: restored.positions.length });
      }
    } else {
      this.state = DEFAULT_STATE(this.config);
      await this.record('config.changed', { version: 1, mode: 'PAPER', config: this.publicConfig() });
    }
    if (this.state.mode === 'PAPER' && this.state.startingEquity <= 0) this.state.startingEquity = this.config.risk.paperInitialEquity;
    await this.persist();
    this.isInitialized = true;
  }

  private publicConfig(): Record<string, unknown> {
    return {
      symbols: this.config.symbols,
      universe: this.config.universe,
      indicators: this.config.indicators,
      strategy: this.config.strategy,
      risk: this.config.risk,
      mode: 'PAPER',
      liveTradingDefault: false,
    };
  }

  private async persist(): Promise<void> {
    await this.store.setState('trading-runtime', this.state);
  }

  private async record<T extends Record<string, unknown>>(type: string, payload: T, symbol?: string, correlationId?: string): Promise<void> {
    const event: AuditEvent<T> = { type, payload, symbol, occurredAt: Date.now(), correlationId };
    await this.store.appendEvent(event);
  }

  private getMark(symbol: string): number {
    const market = this.marketContexts.get(symbol);
    if (market && market.currentPrice > 0) return market.currentPrice;
    return this.state.positions.find((position) => position.symbol === symbol)?.entryPrice ?? 0;
  }

  private currentPaperEquity(): number {
    const openPnl = this.state.positions.reduce((sum, position) => {
      const mark = this.getMark(position.symbol) || position.entryPrice;
      const gross = sign(position.direction) * (mark - position.entryReferencePrice) * position.quantity * position.contractSize;
      // Entry fees, spread, and slippage were debited from paperCash at fill time; only
      // reserve the estimated close-side costs here to avoid charging entry costs twice.
      const exitCosts = mark * position.quantity * position.contractSize
        * (position.takerFeeRate + position.slippageRate + position.spreadRate / 2);
      return sum + gross - exitCosts;
    }, 0);
    return this.state.paperCash + openPnl;
  }

  private currentUnrealizedGross(): number {
    return this.state.positions.reduce((sum, position) => {
      const mark = this.getMark(position.symbol) || position.entryPrice;
      return sum + sign(position.direction) * (mark - position.entryReferencePrice) * position.quantity * position.contractSize;
    }, 0);
  }

  private currentMarginUsed(): number {
    return this.state.positions.reduce((sum, position) => sum + Math.max(0, position.marginUsed), 0);
  }

  private accountForMode(): AccountSnapshot {
    const now = Date.now();
    const state = this.state.dailyRisk;
    const risk = sumAggregateRisk(this.state.positions, this.state.pendingEntries);
    if (this.state.mode === 'LIVE') {
      if (!this.liveAccount) {
        return {
          equity: 0,
          availableMargin: 0,
          realizedPnl: 0,
          unrealizedPnl: 0,
          fees: this.state.totalFees,
          fundingCashFlow: this.state.totalFundingCashFlow,
          dailyDrawdown: state?.drawdown ?? 0,
          marginUtilization: 0,
          aggregateRisk: risk,
          dailyStartingEquity: state?.startingEquity ?? 0,
          dailyLocked: state?.locked ?? false,
          consecutiveLosses: state?.consecutiveLosses ?? 0,
          maxConsecutiveLosses: this.config.risk.maxConsecutiveLosses,
          source: 'UNSYNCED',
          updatedAt: now,
        };
      }
      return {
        equity: this.liveAccount.equity,
        availableMargin: this.liveAccount.availableMargin,
        realizedPnl: this.state.liveRealizedPnl,
        unrealizedPnl: this.liveAccount.unrealizedPnl,
        fees: this.state.totalFees,
        fundingCashFlow: this.state.totalFundingCashFlow,
        dailyDrawdown: state?.drawdown ?? 0,
        marginUtilization: this.liveAccount.equity > 0 ? Math.max(0, 1 - this.liveAccount.availableMargin / this.liveAccount.equity) : 0,
        aggregateRisk: risk,
        dailyStartingEquity: state?.startingEquity ?? 0,
        dailyLocked: state?.locked ?? false,
        consecutiveLosses: state?.consecutiveLosses ?? 0,
        maxConsecutiveLosses: this.config.risk.maxConsecutiveLosses,
        source: 'MEXC',
        updatedAt: this.liveAccount.updatedAt,
      };
    }
    const equity = this.currentPaperEquity();
    const unrealized = this.currentUnrealizedGross();
    return {
      equity,
      availableMargin: Math.max(0, equity - this.currentMarginUsed()),
      realizedPnl: this.state.paperCash - this.state.startingEquity,
      unrealizedPnl: unrealized,
      fees: this.state.totalFees,
      fundingCashFlow: this.state.totalFundingCashFlow,
      dailyDrawdown: state?.drawdown ?? 0,
      marginUtilization: equity > 0 ? this.currentMarginUsed() / equity : 0,
      aggregateRisk: risk,
      dailyStartingEquity: state?.startingEquity ?? 0,
      dailyLocked: state?.locked ?? false,
      consecutiveLosses: state?.consecutiveLosses ?? 0,
      maxConsecutiveLosses: this.config.risk.maxConsecutiveLosses,
      source: 'PAPER',
      updatedAt: now,
    };
  }

  private riskAccount(): RiskAccountSnapshot {
    const account = this.accountForMode();
    const daily = this.state.dailyRisk;
    return {
      equity: account.equity,
      availableMargin: account.availableMargin,
      startingEquity: this.state.startingEquity,
      dailyStartingEquity: daily?.startingEquity ?? account.equity,
      realizedPnl: account.realizedPnl,
      unrealizedPnl: account.unrealizedPnl,
      dailyDrawdown: daily?.drawdown ?? 0,
      dailyLocked: daily?.locked ?? false,
      consecutiveLossLocked: daily?.consecutiveLossLocked ?? false,
      reconciliationHealthy: this.state.mode === 'PAPER' || this.liveReconciliationHealthy,
    };
  }

  private async updateDailyRisk(equity: number, reason = 'equity-update'): Promise<boolean> {
    if (!(equity > 0) || !Number.isFinite(equity)) return false;
    const update = updateDailyRiskState({
      state: this.state.dailyRisk,
      equity,
      timestamp: Date.now(),
      timezone: this.config.risk.timezone,
      maxDailyLoss: this.config.risk.dailyMaxLoss,
      maxConsecutiveLosses: this.config.risk.maxConsecutiveLosses,
    });
    this.state.dailyRisk = update.state;
    if (update.newlyLocked) {
      this.state.pendingEntries = [];
      this.state.paused = true;
      await this.record('risk.lock', {
        reason: update.state.lockReason ?? 'DAILY_MAX_LOSS',
        dailyDrawdown: update.state.drawdown,
        equity,
        dailyStartingEquity: update.state.startingEquity,
        source: reason,
      });
      if (this.state.mode === 'LIVE') {
        try { await this.exchange.cancelOpenEntryOrders(); }
        catch (error) { await this.record('system.error', { component: 'risk-lock-cancel', message: safeMessage(error) }); }
      }
      await this.persist();
      return true;
    }
    return false;
  }

  private onMarket(market: MarketContext): void {
    this.marketContexts.set(market.symbol, market);
    if (!this.state.running || this.state.positions.length === 0) return;
    const now = Date.now();
    if (now - this.lastRiskCheckAt < 750) return;
    this.lastRiskCheckAt = now;
    void this.mutex.runExclusive(async () => {
      if (!this.state.running || this.state.positions.length === 0) return;
      if (this.state.mode === 'PAPER') {
        const newlyLocked = await this.updateDailyRisk(this.currentPaperEquity(), 'live-paper-mark');
        if (newlyLocked) await this.persist();
      } else if (this.state.mode === 'LIVE' && now - this.lastLiveReconcileAt > 30_000 && !this.liveReconcileQueued) {
        this.liveReconcileQueued = true;
        try { await this.reconcileLiveState(); }
        catch (error) { await this.handleLiveReconciliationFailure(error); }
        finally { this.liveReconcileQueued = false; }
      }
    }).catch((error) => {
      void this.record('system.error', { component: 'risk-monitor', message: safeMessage(error) });
    });
  }

  private status(): string {
    if (this.state.dailyRisk?.locked || this.state.dailyRisk?.consecutiveLossLocked || this.state.liveBlockReason) return 'LOCKED';
    if (!this.state.running) return 'STOPPED';
    if (this.state.paused) return 'PAUSED';
    if (this.marketStream.status.connected) return 'RUNNING';
    return this.marketStream.status.connecting ? 'CONNECTING' : 'DEGRADED';
  }

  private async startStream(): Promise<void> {
    if (this.marketStream.status.connected || this.marketStream.status.connecting) return;
    await this.marketStream.start();
  }

  async startPaper(): Promise<void> {
    await this.initialize();
    await this.mutex.runExclusive(async () => {
      if (this.state.mode === 'LIVE' && this.state.positions.length > 0) throw new Error('Close and reconcile all live positions before switching to paper mode.');
      const previousMode = this.state.mode;
      this.marketStream.stop();
      this.state.mode = 'PAPER';
      if (previousMode === 'LIVE') {
        this.state.paperCash = this.config.risk.paperInitialEquity;
        this.state.startingEquity = this.config.risk.paperInitialEquity;
        this.state.dailyRisk = undefined;
        this.state.positions = [];
        this.state.pendingEntries = [];
      }
      this.state.running = true;
      this.state.paused = false;
      this.state.liveBlockReason = undefined;
      this.liveReconciliationHealthy = false;
      this.state.startedAt = Date.now();
      if (this.state.positions.every((position) => position.source !== 'PAPER')) this.state.positions = [];
      if (this.state.paperCash <= 0) this.state.paperCash = this.config.risk.paperInitialEquity;
      if (this.state.startingEquity <= 0) this.state.startingEquity = this.config.risk.paperInitialEquity;
      if (!this.state.dailyRisk) this.state.dailyRisk = createDailyRiskState(this.currentPaperEquity(), Date.now(), this.config.risk.timezone);
      await this.persist();
      await this.record('mode.changed', { mode: 'PAPER', action: 'start' });
    });
    try {
      await this.startStream();
    } catch (error) {
      await this.mutex.runExclusive(async () => {
        this.state.running = false;
        this.state.paused = true;
        this.streamErrors.set('stream', safeMessage(error));
        await this.record('system.error', { component: 'high-volatility-universe', message: safeMessage(error) });
        await this.persist();
      });
      throw error;
    }
  }

  async enableLive(confirmation: string): Promise<void> {
    await this.initialize();
    if (confirmation !== 'ENABLE LIVE TRADING') throw new Error('Confirmation must exactly match ENABLE LIVE TRADING.');
    const readiness = getLiveReadiness(this.config);
    if (!readiness.ready) throw new Error(`Live mode is blocked: ${readiness.blockers.join('; ')}`);
    if (!this.exchange.credentialsConfigured) throw new Error('MEXC API credentials are not configured.');
    await this.mutex.runExclusive(async () => {
      if (this.state.positions.some((position) => position.source === 'PAPER')) {
        throw new Error('Close all paper positions before switching to live mode.');
      }
      if (this.state.dailyRisk?.locked || this.state.dailyRisk?.consecutiveLossLocked) {
        throw new Error('Resolve the existing persisted paper risk lock before enabling live mode.');
      }
      this.marketStream.stop();
      this.state.mode = 'LIVE';
      this.state.startingEquity = 0;
      this.state.liveRealizedPnl = 0;
      this.state.dailyRisk = undefined;
      this.state.pendingEntries = [];
      this.state.running = true;
      this.state.paused = true;
      this.state.liveBlockReason = 'Initial exchange reconciliation is in progress.';
      this.liveReconciliationHealthy = false;
      await this.persist();
    });
    try {
      await this.startStream();
    } catch (error) {
      await this.mutex.runExclusive(async () => {
        this.state.running = false;
        this.state.paused = true;
        this.state.liveBlockReason = `High-volatility universe selection or market-stream startup failed: ${safeMessage(error)}`;
        await this.record('risk.lock', { reason: 'LIVE_MARKET_UNIVERSE_FAILURE', message: safeMessage(error) });
        await this.persist();
      });
      throw error;
    }
    await this.mutex.runExclusive(async () => {
      try {
        await this.reconcileLiveState();
        if (!this.liveReconciliationHealthy) throw new Error(this.state.liveBlockReason ?? 'MEXC account did not reconcile safely.');
        if (this.state.dailyRisk?.locked || this.state.dailyRisk?.consecutiveLossLocked) {
          throw new Error('Live account is already over a configured risk threshold; operator reset is required before entries.');
        }
        this.state.liveBlockReason = undefined;
        this.state.paused = false;
        this.state.startedAt = Date.now();
        await this.record('mode.changed', { mode: 'LIVE', action: 'enabled', explicitOperatorConfirmation: true });
        await this.persist();
      } catch (error) {
        this.state.running = false;
        this.state.paused = true;
        this.state.liveBlockReason = safeMessage(error);
        await this.record('risk.lock', { reason: 'LIVE_PREFLIGHT_FAILED', message: safeMessage(error) });
        await this.persist();
        throw error;
      }
    });
  }

  async pauseNewEntries(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      this.state.paused = true;
      if (this.state.mode === 'LIVE') {
        try { await this.exchange.cancelOpenEntryOrders(); }
        catch (error) { await this.record('system.error', { component: 'pause-entry-cancel', message: safeMessage(error) }); }
      }
      await this.record('control.pause', { mode: this.state.mode, existingPositionsContinue: true });
      await this.persist();
    });
  }

  async resumeNewEntries(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (!this.state.running) throw new Error('Start the selected trading mode before resuming entries.');
      if (this.state.dailyRisk?.locked || this.state.dailyRisk?.consecutiveLossLocked) throw new Error('Risk lock is active; reset it with the authorized reset procedure first.');
      if (this.state.mode === 'LIVE') {
        const readiness = getLiveReadiness(this.config);
        if (!readiness.ready) throw new Error(`Live mode is blocked: ${readiness.blockers.join('; ')}`);
        await this.reconcileLiveState();
        if (!this.liveReconciliationHealthy) throw new Error(this.state.liveBlockReason ?? 'Exchange reconciliation is not healthy.');
      }
      this.state.liveBlockReason = undefined;
      this.state.paused = false;
      await this.record('control.resume', { mode: this.state.mode });
      await this.persist();
    });
  }

  async stop(): Promise<void> {
    await this.pauseNewEntries();
    this.marketStream.stop();
    await this.mutex.runExclusive(async () => {
      this.state.running = false;
      this.state.paused = true;
      await this.record('mode.changed', { mode: this.state.mode, action: 'stop-monitoring' });
      await this.persist();
    });
  }

  async setCompounding(enabled: boolean): Promise<void> {
    await this.mutex.runExclusive(async () => {
      this.state.compoundingEnabled = enabled;
      await this.record('config.changed', { compoundingEnabled: enabled, martingaleEnabled: false, averagingDownEnabled: false });
      await this.persist();
    });
  }

  async cancelPendingEntries(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (this.state.mode === 'LIVE') await this.exchange.cancelOpenEntryOrders();
      this.state.pendingEntries = [];
      await this.record('control.cancel-pending', { mode: this.state.mode, protectiveOrdersPreserved: true });
      await this.persist();
    });
  }

  async resetRiskLock(confirmation: string): Promise<void> {
    if (confirmation !== 'RESET DAILY RISK LOCK') throw new Error('Confirmation must exactly match RESET DAILY RISK LOCK.');
    await this.mutex.runExclusive(async () => {
      let equity: number;
      if (this.state.mode === 'LIVE') {
        const snapshot = await this.exchange.getAccountSnapshot();
        this.liveAccount = { ...snapshot, updatedAt: Date.now() };
        equity = snapshot.equity;
      } else equity = this.currentPaperEquity();
      if (!(equity > 0)) throw new Error('A fresh, positive account equity is required to reset the risk lock.');
      this.state.dailyRisk = resetDailyRiskState(this.state.dailyRisk ?? createDailyRiskState(equity, Date.now(), this.config.risk.timezone),
        equity, Date.now(), this.config.risk.timezone);
      if (this.state.mode !== 'LIVE' || this.liveReconciliationHealthy) this.state.liveBlockReason = undefined;
      await this.record('risk.lock-reset', { equity, timezone: this.config.risk.timezone, authorized: true });
      await this.persist();
    });
  }

  async emergencyCloseAll(confirmation: string): Promise<void> {
    const expected = this.state.mode === 'LIVE' ? 'CLOSE ALL LIVE POSITIONS' : 'CLOSE ALL PAPER POSITIONS';
    if (confirmation !== expected) throw new Error(`Confirmation must exactly match ${expected}.`);
    await this.mutex.runExclusive(async () => {
      this.state.paused = true;
      if (this.state.mode === 'LIVE') {
        await this.reconcileLiveState();
        const mode = await this.exchange.getPositionMode();
        for (const position of [...this.state.positions]) {
          if (position.source === 'EXTERNAL' && !position.protectiveOrderId) {
            // External positions are included only after the operator explicitly confirms close-all.
          }
          if (!position.exchangePositionId) continue;
          const clientId = randomUUID().replaceAll('-', '').slice(0, 32);
          try {
            await this.exchange.closePosition({ symbol: position.symbol, direction: position.direction,
              quantity: position.quantity, leverage: Math.min(this.config.risk.maxLeverage, this.contracts.get(position.symbol)?.maxLeverage ?? this.config.risk.maxLeverage),
              positionId: position.exchangePositionId, positionMode: mode, externalOid: clientId });
          } catch (error) {
            await this.record('system.error', { component: 'emergency-close', symbol: position.symbol, message: safeMessage(error) }, position.symbol, clientId);
          }
        }
        await this.reconcileLiveState();
      } else {
        for (const position of [...this.state.positions]) {
          if (position.source !== 'PAPER') continue;
          const market = this.marketContexts.get(position.symbol);
          const price = market?.currentPrice || position.entryPrice;
          this.closePaperPosition(position, price, Date.now(), 'EMERGENCY');
        }
      }
      this.state.pendingEntries = [];
      this.state.running = this.state.mode === 'LIVE' ? this.state.running : false;
      this.state.paused = true;
      await this.record('control.emergency-close', { mode: this.state.mode, remainingPositions: this.state.positions.length });
      await this.persist();
    });
  }

  async handleLiveReconciliationFailure(error: unknown): Promise<void> {
    this.liveReconciliationHealthy = false;
    this.state.liveBlockReason = `Exchange reconciliation failed: ${safeMessage(error)}`;
    this.state.paused = true;
    await this.record('risk.lock', { reason: 'EXCHANGE_RECONCILIATION_FAILURE', message: safeMessage(error) });
    await this.persist();
  }

  private async reconcileLiveState(): Promise<void> {
    if (this.state.mode !== 'LIVE') return;
    const previousManagedPositions = this.state.positions.filter((position) => position.source === 'LIVE');
    const [account, rawPositions, openOrders, protectiveOrders, positionMode] = await Promise.all([
      this.exchange.getAccountSnapshot(),
      this.exchange.getOpenPositions(),
      this.exchange.getOpenOrders(),
      this.exchange.getOpenProtectiveOrders(),
      this.exchange.getPositionMode(),
    ]);
    if (this.contracts.size === 0) {
      const specs = await this.exchange.getContractSpecs(this.config.symbols);
      this.contracts = new Map(specs.map((spec) => [spec.symbol, spec]));
    }
    const pendingOrderLookups = new Map<string, { order: MexcOrderResult | null; error?: string }>();
    for (const pending of this.state.pendingEntries) {
      if (!pending.externalOrderId) continue;
      try {
        const order = await this.exchange.getOrderByExternalId(pending.symbol, pending.externalOrderId);
        pendingOrderLookups.set(pending.externalOrderId, { order });
      } catch (error) {
        pendingOrderLookups.set(pending.externalOrderId, { order: null, error: safeMessage(error) });
      }
    }
    const botPositionIds = new Set([...pendingOrderLookups.values()]
      .map(({ order }) => order?.positionId)
      .filter((positionId): positionId is string => Boolean(positionId)));
    this.liveAccount = { ...account, updatedAt: Date.now() };
    this.livePositionMode = positionMode;
    const recovered: ManagedPosition[] = [];
    let unsafe: string | undefined;
    for (const raw of rawPositions) {
      const symbol = text(raw.symbol);
      const contract = this.contracts.get(symbol);
      if (!contract) {
        unsafe = `No verified contract specification is cached for open position ${symbol}.`;
        continue;
      }
      const normalized = MexcFuturesAdapter.normalizePosition(raw, contract.contractSize);
      const protection = protectiveOrders.find((order) => text(order.positionId) === normalized.id
        && finite(order.state) === 1 && finite(order.isFinished, 0) === 0);
      const protectiveQuantity = protection ? Math.max(finite(protection.vol), finite(protection.realityVol)) : 0;
      const stopPrice = finite(protection?.stopLossPrice);
      const targetPrice = finite(protection?.takeProfitPrice);
      const quantityMatches = Math.abs(protectiveQuantity - normalized.quantity) <= Math.max(contract.volUnit, normalized.quantity * 1e-6);
      const safeProtection = Boolean(protection && stopPrice > 0 && targetPrice > 0 && quantityMatches);
      const previous = this.state.positions.find((position) => position.id === normalized.id);
      const position: ManagedPosition = {
        ...normalized,
        source: previous?.source === 'LIVE' || botPositionIds.has(normalized.id) ? 'LIVE' : 'EXTERNAL',
        stopPrice: safeProtection ? stopPrice : Number.NaN,
        takeProfitPrice: safeProtection ? targetPrice : 0,
        originalTakeProfit: safeProtection ? targetPrice : 0,
        initialStopPrice: safeProtection ? stopPrice : Number.NaN,
        protectiveOrderId: safeProtection ? text(protection?.id) : undefined,
        stopDistance: safeProtection ? Math.abs(normalized.entryPrice - stopPrice) : 0,
        stopRisk: safeProtection ? estimateStopRiskPerContract(normalized.direction, normalized.entryPrice,
          Math.abs(normalized.entryPrice - stopPrice), {
            makerFeeRate: contract.makerFeeRate,
            takerFeeRate: contract.takerFeeRate,
            slippageRate: this.config.risk.estimatedSlippageRate,
            spreadRate: this.marketContexts.get(symbol)?.spreadRate ?? this.config.strategy.maxSpreadRate,
            contractSize: contract.contractSize,
          }) * normalized.quantity : Number.NaN,
        entryReferencePrice: normalized.entryPrice,
        entryFee: normalized.feesPaid,
        entrySlippage: 0,
        entrySpread: 0,
        entryRisk: safeProtection ? Math.abs(normalized.entryPrice - stopPrice) * normalized.quantity * contract.contractSize : Number.NaN,
        contractSize: contract.contractSize,
        takerFeeRate: contract.takerFeeRate,
        slippageRate: this.config.risk.estimatedSlippageRate,
        spreadRate: this.marketContexts.get(symbol)?.spreadRate ?? this.config.strategy.maxSpreadRate,
        barsHeld: previous?.barsHeld ?? Math.max(0, Math.floor((Date.now() - normalized.openedAt) / 60_000)),
        breakevenMoved: previous?.breakevenMoved ?? false,
        marginUsed: finite(raw.im, finite(raw.oim)),
        unrealizedPnl: finite(raw.unRealizedPnl),
        fundingCashFlow: finite(raw.holdFee),
        openedAt: finite(raw.createTime, Date.now()),
        exchangePositionId: normalized.id,
      };
      recovered.push(position);
      if (!safeProtection) {
        unsafe = `Position ${symbol} (${normalized.id}) has no verified, full-quantity exchange-side stop and target.`;
        await this.record('position.unprotected', { positionId: normalized.id, quantity: normalized.quantity,
          protectiveOrderFound: Boolean(protection), protectiveQuantity, stopPrice, targetPrice }, symbol);
        if (position.source === 'LIVE' && positionMode) await this.emergencyCloseManagedPosition(position, positionMode);
      }
    }
    const entryOrders = openOrders.filter((order) => [1, 3].includes(finite(order.side)) && finite(order.state) <= 2);
    const unresolvedOrders = entryOrders.filter((order) => !this.state.pendingEntries.some((pending) => pending.externalOrderId === text(order.externalOid)));
    if (unresolvedOrders.length) unsafe = `${unresolvedOrders.length} exchange entry order(s) have no persisted risk reservation.`;
    const recoveredIds = new Set(recovered.map((position) => position.id));
    const disappearedManaged = previousManagedPositions.filter((position) => !recoveredIds.has(position.id));
    if (disappearedManaged.length) {
      try {
        const earliest = Math.max(0, Math.min(...disappearedManaged.map((position) => position.openedAt)) - 5 * 60_000);
        const history = await this.exchange.getHistoricalPositions({ startTime: earliest, endTime: Date.now(), pageSize: 100 });
        for (const position of disappearedManaged) {
          const closed = history.find((item) => text(item.positionId) === position.id && finite(item.state) === 3);
          if (!closed) {
            unsafe = `Closed live position ${position.id} is missing from MEXC historical reconciliation.`;
            await this.record('position.close-unverified', { positionId: position.id, symbol: position.symbol }, position.symbol);
            continue;
          }
          const grossPnl = finite(closed.closeProfitLoss, finite(closed.realised));
          const fees = Math.abs(finite(closed.totalFee, finite(closed.fee)));
          const funding = finite(closed.holdFee);
          const netPnl = grossPnl - fees + funding;
          const trade: BacktestTrade = {
            id: position.id,
            symbol: position.symbol,
            direction: position.direction,
            entryTime: position.openedAt,
            exitTime: finite(closed.updateTime, Date.now()),
            entryPrice: finite(closed.openAvgPrice, position.entryPrice),
            exitPrice: finite(closed.closeAvgPrice, position.entryPrice),
            quantity: finite(closed.closeVol, position.quantity),
            grossPnl,
            fees,
            slippage: 0,
            fundingCashFlow: funding,
            netPnl,
            initialRisk: position.entryRisk,
            exitReason: 'EMERGENCY',
          };
          this.state.trades.unshift(trade);
          this.state.trades = this.state.trades.slice(0, 2_000);
          this.state.liveRealizedPnl += netPnl;
          this.state.totalFees += fees;
          this.state.totalFundingCashFlow += funding;
          const daily = this.state.dailyRisk ?? createDailyRiskState(this.state.startingEquity || account.equity, Date.now(), this.config.risk.timezone);
          const update = recordClosedTrade(daily, netPnl, this.config.risk.maxConsecutiveLosses, trade.exitTime);
          this.state.dailyRisk = update.state;
          await this.record('trade.closed', { ...trade, reconciledFromExchange: true }, position.symbol, position.id);
          if (update.newlyLocked) {
            this.state.paused = true;
            await this.record('risk.lock', { reason: 'MAX_CONSECUTIVE_LOSSES', consecutiveLosses: update.state.consecutiveLosses }, position.symbol);
            try { await this.exchange.cancelOpenEntryOrders(); } catch { /* lock remains persistent */ }
          }
        }
      } catch (error) {
        unsafe = `Closed-position history could not be reconciled: ${safeMessage(error)}`;
      }
    }
    this.state.positions = recovered;
    const persistedPending = [...this.state.pendingEntries];
    const openExternalOids = new Set(entryOrders.map((order) => text(order.externalOid)).filter(Boolean));
    const unresolvedPending: PendingEntry[] = [];
    for (const pending of persistedPending) {
      const externalOid = pending.externalOrderId;
      if (!externalOid || openExternalOids.has(externalOid)) continue;
      try {
        const lookup = pendingOrderLookups.get(externalOid);
        if (lookup?.error) throw new Error(lookup.error);
        const known = lookup?.order ?? null;
        if (!known) {
          if (pending.status === 'PENDING') continue;
          unresolvedPending.push({ ...pending, status: 'UNKNOWN' });
          unsafe = `Order ${externalOid} has an unresolved submission outcome; operator review is required.`;
          continue;
        }
        const state = finite(known.state, -1);
        const filledQuantity = finite(known.dealVol);
        const recoveredFill = filledQuantity > 0 && Boolean(known.positionId)
          && recovered.some((position) => position.id === known.positionId);
        if ((state === 4 || state === 5) && filledQuantity <= 0) {
          await this.record('order.reconciled-terminal', { externalOid, state, filledQuantity }, pending.symbol, externalOid);
          continue;
        }
        if (recoveredFill && [3, 4, 5].includes(state)) {
          await this.record('order.reconciled-fill', { externalOid, state, filledQuantity,
            positionId: known.positionId }, pending.symbol, externalOid);
          continue;
        }
        unresolvedPending.push({ ...pending, status: filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'UNKNOWN' });
        unsafe = `Order ${externalOid} is not present in the open-order list and could not be safely reconciled to a protected position.`;
      } catch (error) {
        unresolvedPending.push({ ...pending, status: 'UNKNOWN' });
        unsafe = `Order ${externalOid} reconciliation failed: ${safeMessage(error)}`;
      }
    }
    this.state.pendingEntries = [
      ...entryOrders.map((order) => {
        const externalOid = text(order.externalOid);
        const local = persistedPending.find((pending) => pending.externalOrderId === externalOid);
        const partiallyFilled = finite(order.dealVol) > 0;
        return local
          ? { ...local, status: partiallyFilled ? 'PARTIALLY_FILLED' as const : 'PENDING' as const }
          : {
            id: externalOid || text(order.orderId),
            symbol: text(order.symbol),
            direction: finite(order.side) === 1 ? 'LONG' as const : 'SHORT' as const,
            risk: Number.NaN,
            margin: finite(order.orderMargin),
            createdAt: finite(order.createTime, Date.now()),
            externalOrderId: externalOid,
            status: 'UNKNOWN' as const,
          };
      }),
      ...unresolvedPending.filter((pending) => !openExternalOids.has(pending.externalOrderId ?? '')),
    ];
    if (this.state.pendingEntries.some((pending) => pending.status === 'UNKNOWN')) {
      unsafe ??= 'One or more exchange entry orders have unresolved risk reservations.';
    }
    this.liveReconciliationHealthy = !unsafe && recovered.length <= this.config.risk.maxOpenPositions;
    this.state.liveBlockReason = unsafe ?? (recovered.length > this.config.risk.maxOpenPositions ? 'Exchange position count exceeds configured hard maximum.' : undefined);
    if (!(this.state.startingEquity > 0)) this.state.startingEquity = account.equity;
    this.state.dailyRisk ??= createDailyRiskState(account.equity, Date.now(), this.config.risk.timezone);
    await this.updateDailyRisk(account.equity, 'mexc-reconciliation');
    this.lastLiveReconcileAt = Date.now();
    await this.persist();
    await this.record('exchange.reconciled', {
      equity: account.equity,
      availableMargin: account.availableMargin,
      positions: recovered.length,
      pendingEntries: entryOrders.length,
      protectedPositions: recovered.filter((position) => Number.isFinite(position.stopRisk)).length,
      healthy: this.liveReconciliationHealthy,
      positionMode,
    });
  }

  private livePositionMode: 1 | 2 = 1;

  private async emergencyCloseManagedPosition(position: ManagedPosition, positionMode: 1 | 2): Promise<void> {
    if (!position.exchangePositionId) return;
    const clientId = randomUUID().replaceAll('-', '').slice(0, 32);
    try {
      await this.exchange.closePosition({
        symbol: position.symbol,
        direction: position.direction,
        quantity: position.quantity,
        leverage: this.config.risk.maxLeverage,
        positionId: position.exchangePositionId,
        positionMode,
        externalOid: clientId,
      });
      await this.record('position.emergency-close-requested', { positionId: position.id, clientOrderId: clientId, reason: 'protective-order-missing' }, position.symbol, clientId);
    } catch (error) {
      await this.record('risk.lock', { reason: 'EMERGENCY_CLOSE_FAILED', positionId: position.id, message: safeMessage(error) }, position.symbol, clientId);
      this.state.liveBlockReason = `Emergency close failed for ${position.symbol}; operator intervention required.`;
      this.liveReconciliationHealthy = false;
    }
  }

  private async processPaperCandle(candle: Candle, nextOpen: number, contract: ContractSpec, market: MarketContext, candles: Candle[]): Promise<void> {
    const now = candle.openTime + 60_000;
    const originalPositions = this.state.positions.filter((position) => position.symbol === candle.symbol && position.source === 'PAPER');
    for (const position of [...originalPositions]) {
      if (position.openedAt > candle.openTime) continue;
      if (Number.isFinite(candle.fundingRate) && candle.fundingRate !== 0) {
        const cashFlow = -sign(position.direction) * candle.fundingRate! * candle.close * position.quantity * contract.contractSize;
        position.fundingCashFlow += cashFlow;
        this.state.paperCash += cashFlow;
        this.state.totalFundingCashFlow += cashFlow;
        await this.record('funding.cashflow', { positionId: position.id, rate: candle.fundingRate, cashFlow, signed: true }, position.symbol);
      }
      const long = position.direction === 'LONG';
      const openGapStop = long ? candle.open <= position.stopPrice : candle.open >= position.stopPrice;
      const openGapTarget = long ? candle.open >= position.takeProfitPrice : candle.open <= position.takeProfitPrice;
      const stopTouched = long ? candle.low <= position.stopPrice : candle.high >= position.stopPrice;
      const targetTouched = long ? candle.high >= position.takeProfitPrice : candle.low <= position.takeProfitPrice;
      if (openGapStop) {
        this.closePaperPosition(position, candle.open, now, position.breakevenMoved ? 'BREAKEVEN' : 'STOP');
        continue;
      }
      if (openGapTarget) {
        this.closePaperPosition(position, candle.open, now, 'TARGET');
        continue;
      }
      if (stopTouched) {
        this.closePaperPosition(position, position.stopPrice, now, position.breakevenMoved ? 'BREAKEVEN' : 'STOP');
        continue;
      }
      if (targetTouched) {
        this.closePaperPosition(position, position.takeProfitPrice, now, 'TARGET');
        continue;
      }
      const reachedOneR = long
        ? candle.high >= position.entryPrice + position.stopDistance
        : candle.low <= position.entryPrice - position.stopDistance;
      if (!position.breakevenMoved && reachedOneR) {
        const breakEvenEstimate = costAwareBreakevenStop({ direction: position.direction, entryPrice: position.entryPrice,
          quantity: position.quantity, rates: { makerFeeRate: this.config.risk.estimatedMakerFeeRate,
            takerFeeRate: position.takerFeeRate, slippageRate: position.slippageRate,
            spreadRate: position.spreadRate, contractSize: position.contractSize } });
        const nextStop = roundPriceToTick(breakEvenEstimate, contract.priceUnit, long ? 'UP' : 'DOWN');
        const improves = long ? nextStop > position.stopPrice : nextStop < position.stopPrice;
        if (improves) {
          position.stopPrice = nextStop;
          position.breakevenMoved = true;
          position.stopRisk = Math.max(0, estimateStopRiskPerContract(position.direction, position.entryPrice,
            Math.abs(position.entryPrice - nextStop), { makerFeeRate: this.config.risk.estimatedMakerFeeRate,
              takerFeeRate: position.takerFeeRate, slippageRate: position.slippageRate,
              spreadRate: position.spreadRate, contractSize: position.contractSize }) * position.quantity);
          await this.record('position.stop-to-breakeven', { positionId: position.id, stopPrice: nextStop,
            takeProfitPrice: position.originalTakeProfit }, position.symbol);
        }
      }
      const movedStopHit = long ? candle.low <= position.stopPrice : candle.high >= position.stopPrice;
      if (position.breakevenMoved && movedStopHit) {
        this.closePaperPosition(position, position.stopPrice, now, 'BREAKEVEN');
        continue;
      }
      position.barsHeld += 1;
      if (position.barsHeld >= this.config.strategy.maxHoldingCandles) {
        this.closePaperPosition(position, nextOpen, now, 'TIME');
      }
    }

    const processed = this.state.processedCandleTimes[candle.symbol ?? contract.symbol] ?? 0;
    if (candle.openTime <= processed) return;
    this.state.processedCandleTimes[candle.symbol ?? contract.symbol] = candle.openTime;
    if (this.state.mode === 'LIVE') {
      await this.manageLivePositionsForCandle(candle, nextOpen, contract);
    }
    if (this.marketGapSymbols.has(contract.symbol)) {
      this.marketGapSymbols.delete(contract.symbol);
      await this.record('signal.rejected', { reason: 'MARKET_DATA_GAP', candleTime: candle.openTime,
        details: 'A missing 1-minute interval was detected; entries wait for a contiguous fresh candle.' }, contract.symbol);
      await this.persist();
      return;
    }
    const relevant = candles.filter((item) => item.complete).slice(-600);
    if (relevant.length < Math.max(this.config.indicators.emaSlow, this.config.indicators.atrLength, this.config.indicators.kdjLength)) {
      await this.persist();
      return;
    }
    const decision = evaluateSignal({
      symbol: contract.symbol,
      candles: relevant,
      market,
      contract,
      now: Date.now(),
      config: this.config,
    });
    const activePosition = this.state.positions.find((position) => position.symbol === contract.symbol);
    if (decision.accepted && decision.signal && activePosition
      && decision.signal.direction !== activePosition.direction) {
      if (activePosition.source === 'PAPER') this.closePaperPosition(activePosition, nextOpen, Date.now(), 'OPPOSITE_SIGNAL');
      else if (activePosition.source === 'LIVE') await this.closeLivePosition(activePosition, 'OPPOSITE_SIGNAL');
      await this.persist();
      return; // Never reverse into the same crossover candle.
    }
    if (!decision.accepted) {
      if (decision.candidate) {
        const rejectedSignal: SignalRecord = {
          id: randomUUID(), symbol: contract.symbol, createdAt: Date.now(), candleTime: candle.openTime,
          accepted: false, reason: decision.reason, details: decision.details,
          indicators: calculateIndicatorSeries(relevant, this.config.indicators).at(-1),
        };
        this.state.signalRecords.unshift(rejectedSignal);
        this.state.signalRecords = this.state.signalRecords.slice(0, 200);
        await this.record('signal.rejected', { reason: decision.reason, details: decision.details,
          candleTime: candle.openTime, indicators: rejectedSignal.indicators }, contract.symbol);
      }
      await this.persist();
      return;
    }
    if (!decision.signal || activePosition || this.state.pendingEntries.some((entry) => entry.symbol === contract.symbol)) {
      await this.persist();
      return;
    }
    if (!this.state.running || this.state.paused || this.state.dailyRisk?.locked || this.state.dailyRisk?.consecutiveLossLocked) {
      await this.record('signal.rejected', { reason: this.state.dailyRisk?.locked ? 'DAILY_RISK_LOCK' : 'PAUSED',
        candleTime: candle.openTime, details: 'The strategy signal was valid, but new entries are locked.' }, contract.symbol);
      await this.persist();
      return;
    }

    if (this.state.mode === 'LIVE') await this.processLiveSignal(decision.signal, nextOpen, contract, market);
    else await this.enterPaperPosition(decision.signal, nextOpen, contract, market);
    await this.persist();
  }

  private closePaperPosition(position: ManagedPosition, referencePrice: number, timestamp: number, reason: BacktestTrade['exitReason']): void {
    if (!this.state.positions.some((item) => item.id === position.id)) return;
    const directionSign = sign(position.direction);
    const adverse = -directionSign;
    const exitFill = referencePrice * (1 + adverse * (position.slippageRate + position.spreadRate / 2));
    const exitNotional = exitFill * position.quantity * position.contractSize;
    const exitFee = exitNotional * position.takerFeeRate;
    const exitSlippage = referencePrice * position.quantity * position.contractSize * position.slippageRate;
    const exitSpread = referencePrice * position.quantity * position.contractSize * position.spreadRate / 2;
    const grossPnl = directionSign * (referencePrice - position.entryReferencePrice) * position.quantity * position.contractSize;
    const netPnl = grossPnl - position.entryFee - exitFee - position.entrySlippage - exitSlippage
      - position.entrySpread - exitSpread + position.fundingCashFlow;
    this.state.paperCash += grossPnl - exitFee - exitSlippage - exitSpread;
    this.state.totalFees += exitFee;
    this.state.totalSlippage += exitSlippage + exitSpread;
    const trade: BacktestTrade = {
      id: position.id,
      symbol: position.symbol,
      direction: position.direction,
      entryTime: position.openedAt,
      exitTime: timestamp,
      entryPrice: position.entryReferencePrice,
      exitPrice: referencePrice,
      quantity: position.quantity,
      grossPnl,
      fees: position.entryFee + exitFee,
      slippage: position.entrySlippage + exitSlippage + position.entrySpread + exitSpread,
      fundingCashFlow: position.fundingCashFlow,
      netPnl,
      initialRisk: position.entryRisk,
      exitReason: reason,
    };
    this.state.trades.unshift(trade);
    this.state.trades = this.state.trades.slice(0, 2_000);
    this.state.positions = this.state.positions.filter((item) => item.id !== position.id);
    const previousDaily = this.state.dailyRisk ?? createDailyRiskState(this.state.startingEquity, timestamp, this.config.risk.timezone);
    const update = recordClosedTrade(previousDaily, netPnl, this.config.risk.maxConsecutiveLosses, timestamp);
    this.state.dailyRisk = update.state;
    void this.record('trade.closed', trade as unknown as Record<string, unknown>, position.symbol, position.id);
    if (update.newlyLocked) {
      this.state.paused = true;
      this.state.pendingEntries = [];
      void this.record('risk.lock', { reason: 'MAX_CONSECUTIVE_LOSSES', consecutiveLosses: update.state.consecutiveLosses }, position.symbol);
    }
    void this.updateDailyRisk(this.currentPaperEquity(), 'paper-position-close');
  }

  private async enterPaperPosition(signal: StrategySignal, nextOpen: number, contract: ContractSpec, market: MarketContext): Promise<void> {
    const feeRate = Math.max(contract.takerFeeRate, this.config.risk.estimatedTakerFeeRate);
    const fillPrice = nextOpen * (1 + sign(signal.direction) * (this.config.risk.estimatedSlippageRate + market.spreadRate / 2));
    const executableSignal = { ...signal, close: fillPrice };
    const account = this.riskAccount();
    const risk = assessPositionRisk({
      signal: executableSignal,
      contract,
      account,
      positions: this.state.positions,
      pendingEntries: this.state.pendingEntries,
      config: this.config.risk,
      context: { spreadRate: market.spreadRate, compoundingEnabled: this.state.compoundingEnabled },
    });
    if (!risk.accepted) {
      await this.recordRiskRejection(signal, risk);
      return;
    }
    const quantity = risk.quantity;
    const entryNotional = fillPrice * quantity * contract.contractSize;
    const entryFee = entryNotional * feeRate;
    const entrySlippage = nextOpen * quantity * contract.contractSize * this.config.risk.estimatedSlippageRate;
    const entrySpread = nextOpen * quantity * contract.contractSize * market.spreadRate / 2;
    const stopPrice = risk.stopPrice;
    const takeProfitPrice = risk.takeProfitPrice;
    const stopDistance = Math.abs(fillPrice - stopPrice);
    const stopRisk = estimateStopRiskPerContract(signal.direction, fillPrice, stopDistance, {
      makerFeeRate: Math.max(contract.makerFeeRate, this.config.risk.estimatedMakerFeeRate),
      takerFeeRate: feeRate,
      slippageRate: this.config.risk.estimatedSlippageRate,
      spreadRate: market.spreadRate,
      contractSize: contract.contractSize,
    }) * quantity;
    if (stopRisk > risk.riskBudget + 1e-7) {
      await this.recordRiskRejection(signal, { ...risk, accepted: false, reason: 'INDIVIDUAL_RISK_LIMIT',
        details: 'Actual simulated entry costs exceeded the pre-trade risk allocation.' });
      return;
    }
    this.state.paperCash -= entryFee + entrySlippage + entrySpread;
    this.state.totalFees += entryFee;
    this.state.totalSlippage += entrySlippage + entrySpread;
    const position: ManagedPosition = {
      id: `paper-${randomUUID()}`,
      symbol: signal.symbol,
      direction: signal.direction,
      quantity,
      entryPrice: fillPrice,
      entryReferencePrice: nextOpen,
      stopPrice,
      takeProfitPrice,
      stopRisk,
      marginUsed: risk.marginRequired,
      unrealizedPnl: 0,
      openedAt: candleStartTime(signal.candleTime + 60_000),
      barsHeld: 0,
      breakevenMoved: false,
      source: 'PAPER',
      feesPaid: entryFee,
      fundingCashFlow: 0,
      entryFee,
      entrySlippage,
      entrySpread,
      entryRisk: stopRisk,
      stopDistance,
      contractSize: contract.contractSize,
      takerFeeRate: feeRate,
      slippageRate: this.config.risk.estimatedSlippageRate,
      spreadRate: market.spreadRate,
      initialStopPrice: stopPrice,
      originalTakeProfit: takeProfitPrice,
    };
    this.state.positions.push(position);
    const signalRecord: SignalRecord = {
      id: randomUUID(), symbol: signal.symbol, createdAt: Date.now(), candleTime: signal.candleTime,
      direction: signal.direction, accepted: true, indicators: signal.indicators, decision: signal,
    };
    this.state.signalRecords.unshift(signalRecord);
    this.state.signalRecords = this.state.signalRecords.slice(0, 200);
    const orderId = `paper-${randomUUID()}`;
    await this.record('order.intent', { clientOrderId: orderId, status: 'PAPER_ACCEPTED',
      request: { symbol: signal.symbol, side: signal.direction, quantity, leverage: risk.leverage,
        stopPrice, takeProfitPrice, expectedRisk: risk.estimatedRisk } }, signal.symbol, orderId);
    await this.record('order.fill', { clientOrderId: orderId, status: 'PAPER_FILLED', quantity, fillPrice,
      fees: entryFee, slippage: entrySlippage, spread: entrySpread }, signal.symbol, orderId);
    await this.record('position.opened', { ...position }, signal.symbol, position.id);
    await this.saveEquitySnapshot();
  }

  private async recordRiskRejection(signal: StrategySignal, risk: RiskAssessment): Promise<void> {
    const event: SignalRecord = {
      id: randomUUID(), symbol: signal.symbol, createdAt: Date.now(), candleTime: signal.candleTime,
      direction: signal.direction, accepted: false, reason: risk.reason, details: risk.details,
      indicators: signal.indicators, decision: signal,
    };
    this.state.signalRecords.unshift(event);
    this.state.signalRecords = this.state.signalRecords.slice(0, 200);
    await this.record('signal.rejected', { reason: risk.reason, details: risk.details,
      riskBudget: risk.riskBudget, estimatedRisk: risk.estimatedRisk, aggregateRiskAfter: risk.aggregateRiskAfter,
      candleTime: signal.candleTime }, signal.symbol);
  }

  private async processLiveSignal(signal: StrategySignal, nextOpen: number, contract: ContractSpec, market: MarketContext): Promise<void> {
    await this.reconcileLiveState();
    if (!this.liveReconciliationHealthy || this.state.liveBlockReason) {
      await this.recordRiskRejection(signal, { ...emptyRisk(), accepted: false,
        reason: 'EXCHANGE_RECONCILIATION_REQUIRED', details: this.state.liveBlockReason ?? 'Exchange state is not fully reconciled.' });
      return;
    }
    const entryFillEstimate = nextOpen * (1 + sign(signal.direction) * (this.config.risk.estimatedSlippageRate + market.spreadRate / 2));
    const exactFees = await this.exchange.getFeeDetails(signal.symbol);
    const feeObject = Array.isArray(exactFees) ? (exactFees[0] ?? {}) : exactFees;
    const accountFeeRates = {
      makerFeeRate: finite((feeObject as Record<string, unknown>).realMakerFee, contract.makerFeeRate),
      takerFeeRate: finite((feeObject as Record<string, unknown>).realTakerFee, contract.takerFeeRate),
    };
    const signalAtExecution = { ...signal, close: entryFillEstimate };
    const assessment = assessPositionRisk({
      signal: signalAtExecution,
      contract,
      account: this.riskAccount(),
      positions: this.state.positions,
      pendingEntries: this.state.pendingEntries,
      config: this.config.risk,
      context: { spreadRate: market.spreadRate, compoundingEnabled: this.state.compoundingEnabled, accountFeeRates },
    });
    if (!assessment.accepted) {
      await this.recordRiskRejection(signal, assessment);
      return;
    }

    const clientOrderId = randomUUID().replaceAll('-', '').slice(0, 32);
    const pending: PendingEntry = {
      id: clientOrderId,
      symbol: signal.symbol,
      direction: signal.direction,
      risk: assessment.estimatedRisk,
      margin: assessment.marginRequired,
      createdAt: Date.now(),
      externalOrderId: clientOrderId,
      status: 'PENDING',
    };
    this.state.pendingEntries.push(pending);
    const request = { symbol: signal.symbol, direction: signal.direction, side: signal.direction === 'LONG' ? 1 : 3,
      quantity: assessment.quantity, leverage: assessment.leverage, openType: 1, type: 5,
      stopLossPrice: assessment.stopPrice, takeProfitPrice: assessment.takeProfitPrice };
    await this.record('order.intent', { clientOrderId, status: 'INTENT', request }, signal.symbol, clientOrderId);
    await this.persist();
    this.state.pendingEntries = this.state.pendingEntries.map((entry) => entry.id === clientOrderId
      ? { ...entry, status: 'SUBMITTING' }
      : entry);
    await this.record('order.submitting', { clientOrderId, externalOid: clientOrderId }, signal.symbol, clientOrderId);
    await this.persist();

    let submitted: MexcOrderResult | null = null;
    try {
      submitted = await this.exchange.placeOrder({
        symbol: signal.symbol,
        side: signal.direction === 'LONG' ? 1 : 3,
        quantity: assessment.quantity,
        leverage: assessment.leverage,
        externalOid: clientOrderId,
        positionMode: this.livePositionMode,
      });
    } catch (error) {
      let known: MexcOrderResult | null = null;
      try { known = await this.exchange.getOrderByExternalId(signal.symbol, clientOrderId); }
      catch (reconcileError) {
        this.state.pendingEntries = this.state.pendingEntries.map((entry) => entry.id === clientOrderId ? { ...entry, status: 'UNKNOWN' } : entry);
        this.liveReconciliationHealthy = false;
        this.state.liveBlockReason = 'Order submission outcome is unknown; do not retry until external-order reconciliation completes.';
        await this.record('risk.lock', { reason: 'UNKNOWN_ORDER_SUBMISSION', clientOrderId,
          submitError: safeMessage(error), queryError: safeMessage(reconcileError) }, signal.symbol, clientOrderId);
        await this.persist();
        return;
      }
      if (known) submitted = known;
      else if (error instanceof MexcApiError && error.status !== undefined && error.status < 500) {
        this.state.pendingEntries = this.state.pendingEntries.filter((entry) => entry.id !== clientOrderId);
        await this.record('order.rejected', { clientOrderId, message: safeMessage(error) }, signal.symbol, clientOrderId);
        return;
      } else {
        this.state.pendingEntries = this.state.pendingEntries.map((entry) => entry.id === clientOrderId ? { ...entry, status: 'UNKNOWN' } : entry);
        this.liveReconciliationHealthy = false;
        this.state.liveBlockReason = 'Order submission outcome is unknown; no retry was attempted.';
        await this.record('risk.lock', { reason: 'UNKNOWN_ORDER_SUBMISSION', clientOrderId, message: safeMessage(error) }, signal.symbol, clientOrderId);
        await this.persist();
        return;
      }
    }
    if (!submitted?.orderId) {
      this.state.liveBlockReason = 'MEXC did not return an order id; reconcile by client id before any retry.';
      this.liveReconciliationHealthy = false;
      await this.persist();
      return;
    }

    let latestOrder = submitted;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (latestOrder.dealVol && latestOrder.dealVol > 0) break;
      if (attempt < 3) await wait(250 * (attempt + 1));
      try { latestOrder = await this.exchange.getOrderById(submitted.orderId); }
      catch { /* State remains unknown; the next loop/reconciliation will not duplicate the client id. */ }
      if ([3, 4, 5].includes(latestOrder.state ?? -1)) break;
    }
    if (!(latestOrder.dealVol && latestOrder.dealVol > 0)) {
      try { await this.exchange.cancelOrders([submitted.orderId]); } catch { /* safe state is reconciled below */ }
      this.state.pendingEntries = this.state.pendingEntries.filter((entry) => entry.id !== clientOrderId);
      await this.record('order.not-filled', { clientOrderId, exchangeOrderId: submitted.orderId, state: latestOrder.state }, signal.symbol, clientOrderId);
      await this.reconcileLiveState();
      return;
    }
    if (latestOrder.state !== 3) {
      // Cancel any unfilled remainder; protection is sized to the observed filled quantity only.
      try { await this.exchange.cancelOrders([submitted.orderId]); } catch { /* reconcile actual remaining exposure */ }
    }

    const positions = await this.exchange.getOpenPositions();
    const rawPosition = positions.find((item) => text(item.symbol) === signal.symbol
      && finite(item.positionType) === (signal.direction === 'LONG' ? 1 : 2));
    const positionId = text(rawPosition?.positionId ?? latestOrder.positionId);
    const actualQty = Math.min(finite(rawPosition?.holdVol, latestOrder.dealVol), finite(latestOrder.dealVol, assessment.quantity));
    const averageFill = finite(latestOrder.dealAvgPrice, finite(rawPosition?.holdAvgPrice, entryFillEstimate));
    if (!positionId || !(actualQty > 0) || !(averageFill > 0)) {
      this.state.pendingEntries = this.state.pendingEntries.map((entry) => entry.id === clientOrderId ? { ...entry, status: 'UNKNOWN' } : entry);
      this.liveReconciliationHealthy = false;
      this.state.liveBlockReason = 'A confirmed order fill could not be joined to an exchange position; no duplicate order will be sent.';
      await this.record('risk.lock', { reason: 'FILLED_ORDER_POSITION_UNKNOWN', clientOrderId, orderId: submitted.orderId,
        filledQuantity: latestOrder.dealVol, positionId: positionId || null }, signal.symbol, clientOrderId);
      await this.persist();
      return;
    }

    const rawStopDistance = signal.atr * this.config.strategy.stopAtrMultiple;
    const stopPrice = roundPriceToTick(signal.direction === 'LONG' ? averageFill - rawStopDistance : averageFill + rawStopDistance,
      contract.priceUnit, signal.direction === 'LONG' ? 'UP' : 'DOWN');
    const takeProfitPrice = roundPriceToTick(signal.direction === 'LONG'
      ? averageFill + rawStopDistance * this.config.strategy.takeProfitR
      : averageFill - rawStopDistance * this.config.strategy.takeProfitR,
    contract.priceUnit, signal.direction === 'LONG' ? 'DOWN' : 'UP');
    const stopDistance = Math.abs(averageFill - stopPrice);
    const actualStopRisk = estimateStopRiskPerContract(signal.direction, averageFill, stopDistance, {
      makerFeeRate: accountFeeRates.makerFeeRate,
      takerFeeRate: accountFeeRates.takerFeeRate,
      slippageRate: this.config.risk.estimatedSlippageRate,
      spreadRate: market.spreadRate,
      contractSize: contract.contractSize,
    }) * actualQty;
    let protectionId = '';
    try {
      protectionId = await this.exchange.placePositionProtection({ positionId, quantity: actualQty,
        stopLossPrice: stopPrice, takeProfitPrice });
    } catch (error) {
      await this.record('position.protection-rejected', { positionId, message: safeMessage(error) }, signal.symbol, clientOrderId);
    }
    const verified = await this.verifyProtectiveOrder(positionId, actualQty, stopPrice, takeProfitPrice, contract);
    if (!verified) {
      const raw = rawPosition ?? { symbol: signal.symbol, holdVol: actualQty, positionId, positionType: signal.direction === 'LONG' ? 1 : 2,
        holdAvgPrice: averageFill, leverage: assessment.leverage, im: assessment.marginRequired };
      const managed: ManagedPosition = {
        id: positionId, symbol: signal.symbol, direction: signal.direction, quantity: actualQty, entryPrice: averageFill,
        entryReferencePrice: averageFill, stopPrice, takeProfitPrice, originalTakeProfit: takeProfitPrice,
        initialStopPrice: stopPrice, stopDistance, stopRisk: actualStopRisk, marginUsed: finite(rawPosition?.im, assessment.marginRequired),
        unrealizedPnl: 0, openedAt: finite(rawPosition?.createTime, Date.now()), barsHeld: 0, breakevenMoved: false,
        source: 'LIVE', feesPaid: finite(latestOrder.raw.takerFee, 0), fundingCashFlow: 0, protectiveOrderId: protectionId,
        exchangePositionId: positionId, entryFee: finite(latestOrder.raw.takerFee, 0), entrySlippage: 0, entrySpread: 0,
        entryRisk: actualStopRisk, contractSize: contract.contractSize, takerFeeRate: accountFeeRates.takerFeeRate,
        slippageRate: this.config.risk.estimatedSlippageRate, spreadRate: market.spreadRate, externalOrderId: clientOrderId,
      };
      this.state.positions.push(managed);
      this.state.pendingEntries = this.state.pendingEntries.filter((entry) => entry.id !== clientOrderId);
      this.liveReconciliationHealthy = false;
      this.state.liveBlockReason = 'Protective orders were not verified; the new entry was sent to emergency close and new entries are locked.';
      this.state.paused = true;
      await this.emergencyCloseManagedPosition(managed, this.livePositionMode);
      await this.record('risk.lock', { reason: 'PROTECTIVE_ORDER_UNVERIFIED', positionId, emergencyCloseAttempted: true }, signal.symbol, clientOrderId);
      await this.persist();
      return;
    }

    const position: ManagedPosition = {
      id: positionId,
      symbol: signal.symbol,
      direction: signal.direction,
      quantity: actualQty,
      entryPrice: averageFill,
      entryReferencePrice: averageFill,
      stopPrice,
      takeProfitPrice,
      originalTakeProfit: takeProfitPrice,
      initialStopPrice: stopPrice,
      stopDistance,
      stopRisk: actualStopRisk,
      marginUsed: finite(rawPosition?.im, assessment.marginRequired),
      unrealizedPnl: finite(rawPosition?.unRealizedPnl),
      openedAt: finite(rawPosition?.createTime, Date.now()),
      barsHeld: 0,
      breakevenMoved: false,
      source: 'LIVE',
      feesPaid: finite(latestOrder.raw.takerFee, 0),
      fundingCashFlow: 0,
      protectiveOrderId: protectionId,
      exchangePositionId: positionId,
      entryFee: finite(latestOrder.raw.takerFee, 0),
      entrySlippage: 0,
      entrySpread: 0,
      entryRisk: actualStopRisk,
      contractSize: contract.contractSize,
      takerFeeRate: accountFeeRates.takerFeeRate,
      slippageRate: this.config.risk.estimatedSlippageRate,
      spreadRate: market.spreadRate,
      externalOrderId: clientOrderId,
    };
    this.state.positions.push(position);
    this.state.pendingEntries = this.state.pendingEntries.filter((entry) => entry.id !== clientOrderId);
    await this.record('order.fill', { clientOrderId, exchangeOrderId: submitted.orderId, fillPrice: averageFill,
      filledQuantity: actualQty, fees: finite(latestOrder.raw.takerFee, 0), actualStopRisk,
      requestedRisk: assessment.riskBudget }, signal.symbol, clientOrderId);
    await this.record('position.opened', { ...position }, signal.symbol, position.id);
    if (actualStopRisk > assessment.riskBudget + Math.max(0.01, assessment.riskBudget * 0.02)) {
      this.state.liveBlockReason = 'Actual fill cost exceeded allocated risk; emergency close was requested.';
      this.state.paused = true;
      await this.emergencyCloseManagedPosition(position, this.livePositionMode);
      await this.record('risk.lock', { reason: 'ACTUAL_FILL_RISK_EXCEEDED', actualStopRisk, allocatedRisk: assessment.riskBudget }, signal.symbol, clientOrderId);
    }
    await this.reconcileLiveState();
  }

  private async verifyProtectiveOrder(positionId: string, quantity: number, stop: number, target: number, contract: ContractSpec): Promise<boolean> {
    await wait(250);
    const orders = await this.exchange.getOpenProtectiveOrders();
    const matching = orders.find((order) => text(order.positionId) === positionId && finite(order.state) === 1
      && finite(order.isFinished, 0) === 0 && finite(order.stopLossPrice) > 0 && finite(order.takeProfitPrice) > 0);
    if (!matching) return false;
    const actualVol = Math.max(finite(matching.vol), finite(matching.realityVol));
    const tolerance = Math.max(contract.volUnit, quantity * 1e-6);
    return Math.abs(actualVol - quantity) <= tolerance
      && near(finite(matching.stopLossPrice), stop, Math.max(contract.priceUnit, stop * 1e-8))
      && near(finite(matching.takeProfitPrice), target, Math.max(contract.priceUnit, target * 1e-8));
  }

  private async manageLivePositionsForCandle(candle: Candle, nextOpen: number, contract: ContractSpec): Promise<void> {
    const existing = this.state.positions.filter((position) => position.symbol === contract.symbol && position.source === 'LIVE');
    for (const position of existing) {
      if (position.openedAt > candle.openTime) continue;
      const long = position.direction === 'LONG';
      const reachedOneR = long ? candle.high >= position.entryPrice + position.stopDistance : candle.low <= position.entryPrice - position.stopDistance;
      if (!position.breakevenMoved && reachedOneR && position.protectiveOrderId) {
        const breakEvenEstimate = costAwareBreakevenStop({ direction: position.direction, entryPrice: position.entryPrice,
          quantity: position.quantity, rates: { makerFeeRate: contract.makerFeeRate, takerFeeRate: position.takerFeeRate,
            slippageRate: position.slippageRate, spreadRate: position.spreadRate, contractSize: contract.contractSize } });
        const stop = roundPriceToTick(breakEvenEstimate, contract.priceUnit, long ? 'UP' : 'DOWN');
        const improves = long ? stop > position.stopPrice : stop < position.stopPrice;
        if (improves) {
          try {
            await this.exchange.moveProtectiveStopToBreakeven(position.protectiveOrderId, stop);
            position.stopPrice = stop;
            position.breakevenMoved = true;
            position.stopRisk = Math.max(0, estimateStopRiskPerContract(position.direction, position.entryPrice,
              Math.abs(position.entryPrice - stop), { makerFeeRate: contract.makerFeeRate,
                takerFeeRate: position.takerFeeRate, slippageRate: position.slippageRate,
                spreadRate: position.spreadRate, contractSize: contract.contractSize }) * position.quantity);
            await this.record('position.stop-to-breakeven', { positionId: position.id, stopPrice: stop,
              takeProfitPrice: position.originalTakeProfit }, position.symbol);
          } catch (error) {
            this.state.liveBlockReason = `Breakeven stop update failed for ${position.symbol}.`;
            this.state.paused = true;
            await this.record('risk.lock', { reason: 'BREAKEVEN_STOP_UPDATE_FAILED', positionId: position.id,
              message: safeMessage(error) }, position.symbol);
          }
        }
      }
      position.barsHeld += 1;
      if (position.barsHeld >= this.config.strategy.maxHoldingCandles) {
        await this.closeLivePosition(position, 'TIME');
      }
    }
    if (Date.now() - this.lastLiveReconcileAt > 30_000) {
      try { await this.reconcileLiveState(); }
      catch (error) { await this.handleLiveReconciliationFailure(error); }
    }
  }

  private async closeLivePosition(position: ManagedPosition, reason: BacktestTrade['exitReason']): Promise<void> {
    if (!position.exchangePositionId) return;
    const clientId = randomUUID().replaceAll('-', '').slice(0, 32);
    try {
      await this.exchange.closePosition({ symbol: position.symbol, direction: position.direction,
        quantity: position.quantity, leverage: this.config.risk.maxLeverage,
        positionId: position.exchangePositionId, positionMode: this.livePositionMode, externalOid: clientId });
      await this.record('position.close-requested', { positionId: position.id, reason, clientOrderId: clientId }, position.symbol, clientId);
      await wait(350);
      await this.reconcileLiveState();
      if (this.state.positions.some((item) => item.id === position.id && item.quantity > 0)) {
        this.state.liveBlockReason = `Position ${position.symbol} was not confirmed closed after ${reason}.`;
        this.state.paused = true;
        await this.record('risk.lock', { reason: 'CLOSE_NOT_CONFIRMED', positionId: position.id, clientOrderId: clientId }, position.symbol, clientId);
      }
    } catch (error) {
      this.state.liveBlockReason = `Close request failed for ${position.symbol}; operator intervention required.`;
      this.state.paused = true;
      await this.record('risk.lock', { reason: 'CLOSE_REQUEST_FAILED', positionId: position.id,
        clientOrderId: clientId, message: safeMessage(error) }, position.symbol, clientId);
    }
  }

  private async handleCompletedCandle(symbol: string, candle: Candle, nextOpen: number): Promise<void> {
    if (this.shutdownRequested || !candle.complete) return;
    await this.mutex.runExclusive(async () => {
      if (this.shutdownRequested) return;
      const processedAt = this.state.processedCandleTimes[symbol] ?? 0;
      if (candle.openTime <= processedAt) return;
      const contract = this.marketStream.getContract(symbol) ?? this.contracts.get(symbol);
      const market = this.marketContexts.get(symbol) ?? this.marketStream.getMarket(symbol);
      if (!contract || !market) {
        await this.record('signal.rejected', { reason: 'STALE_MARKET_DATA', candleTime: candle.openTime,
          details: 'Contract metadata or bid/ask context is unavailable.' }, symbol);
        return;
      }
      const contiguousHistory = this.marketStream.getCandles(symbol).filter((item) => item.complete);
      await this.store.upsertCandles(symbol, [candle]);
      if (processedAt > 0 && candle.openTime - processedAt !== 60_000) {
        this.marketGapSymbols.add(symbol);
        await this.record('market.gap', { expected: processedAt + 60_000, received: candle.openTime }, symbol);
      }
      await this.processPaperCandle(candle, nextOpen, contract, market, contiguousHistory);
      await this.saveEquitySnapshot();
      await this.persist();
    });
  }

  private async saveEquitySnapshot(): Promise<void> {
    const account = this.accountForMode();
    if (account.source === 'UNSYNCED' || account.equity <= 0) return;
    await this.record('equity.snapshot', {
      mode: this.state.mode,
      equity: account.equity,
      availableMargin: account.availableMargin,
      realizedPnl: account.realizedPnl,
      unrealizedPnl: account.unrealizedPnl,
      fees: account.fees,
      fundingCashFlow: account.fundingCashFlow,
      dailyDrawdown: account.dailyDrawdown,
      aggregateRisk: account.aggregateRisk,
      marginUtilization: account.marginUtilization,
    });
  }

  async dashboard(): Promise<DashboardData> {
    await this.initialize();
    const markets: DashboardMarket[] = [];
    const volatilityBySymbol = new Map(this.marketStream.getUniverse().map((asset) => [asset.symbol, asset.dailyRangePct]));
    for (const symbol of this.config.symbols) {
      const market = this.marketContexts.get(symbol) ?? this.marketStream.getMarket(symbol);
      const candles = this.marketStream.getCandles(symbol);
      let indicators: ReturnType<typeof calculateIndicatorSeries>[number] | undefined;
      try { indicators = calculateIndicatorSeries(candles, this.config.indicators).at(-1); }
      catch { /* invalid or still warming up: display blank indicators */ }
      const contract = this.marketStream.getContract(symbol) ?? this.contracts.get(symbol);
      const observedAt = market?.observedAt ?? null;
      markets.push({
        symbol,
        price: market?.currentPrice ?? 0,
        bid: market?.bid ?? 0,
        ask: market?.ask ?? 0,
        spreadRate: market?.spreadRate ?? 0,
        liquidityUsd: market?.liquidityUsd ?? 0,
        volatilityPct: volatilityBySymbol.get(symbol),
        stale: !observedAt || Date.now() - observedAt > this.config.strategy.maxMarketDataAgeMs,
        observedAt,
        indicators,
        contractEnabled: contract ? contract.state === 0 && contract.apiAllowed : null,
        error: this.streamErrors.get(symbol) ?? this.streamErrors.get('stream'),
      });
    }
    const account = this.accountForMode();
    const positions = this.state.positions.map((position) => {
      const currentPrice = this.getMark(position.symbol) || position.entryPrice;
      const estimatedExitCosts = currentPrice * position.quantity * position.contractSize
        * (position.takerFeeRate + position.slippageRate + position.spreadRate / 2);
      const unrealizedPnl = sign(position.direction) * (currentPrice - position.entryReferencePrice) * position.quantity * position.contractSize
        - position.entryFee - position.entrySlippage - position.entrySpread - estimatedExitCosts + position.fundingCashFlow;
      const basis = Math.max(1e-12, position.entryPrice * position.quantity * position.contractSize);
      return { ...position, currentPrice, unrealizedPnl, pnlPct: unrealizedPnl / basis * 100 };
    });
    const equityEvents = await this.store.listEvents<Record<string, unknown>>({ type: 'equity.snapshot', limit: 60 });
    const equityCurve = equityEvents.reverse().map((event) => ({
      timestamp: event.occurredAt,
      equity: finite(event.payload.equity),
      realizedPnl: finite(event.payload.realizedPnl),
      unrealizedPnl: finite(event.payload.unrealizedPnl),
    }));
    const eventAlerts = await this.store.listEvents<Record<string, unknown>>({ limit: 100 });
    const alerts = eventAlerts
      .filter((event) => ['risk.lock', 'position.unprotected', 'system.error', 'market.gap'].includes(event.type))
      .slice(0, 8)
      .map((event) => ({
        type: event.type,
        at: event.occurredAt,
        symbol: event.symbol,
        message: String(event.payload.message ?? event.payload.reason ?? event.payload.component ?? event.type),
      }));
    const completed = this.state.trades;
    const wins = completed.filter((trade) => trade.netPnl > 0);
    const gains = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
    const losses = Math.abs(completed.filter((trade) => trade.netPnl < 0).reduce((sum, trade) => sum + trade.netPnl, 0));
    const liveReadiness = getLiveReadiness(this.config);
    const marketDataFresh = markets.some((market) => !market.stale);
    return {
      name: 'Royal USD',
      exchange: 'MEXC Futures',
      timeframe: '1m',
      mode: this.state.mode,
      status: this.status(),
      started: this.state.running,
      paused: this.state.paused,
      marketStream: this.marketStream.status,
      marketDataFresh,
      liveReady: liveReadiness.ready && this.liveReconciliationHealthy,
      liveBlockers: liveReadiness.blockers,
      liveBlockReason: this.state.liveBlockReason,
      config: {
        symbols: this.config.symbols,
        universe: { ...this.config.universe, selectedHighVolatilityAssets: this.marketStream.getUniverse().length },
        indicators: this.config.indicators,
        strategy: this.config.strategy,
        risk: this.config.risk,
        compoundingEnabled: this.state.compoundingEnabled,
        liveTradingDefault: false,
        maxSimultaneousPositions: this.config.risk.maxOpenPositions,
      },
      account,
      positions,
      pendingOrders: this.state.pendingEntries,
      markets,
      tradeHistory: this.state.trades.slice(0, 100),
      signals: this.state.signalRecords.slice(0, 100),
      equityCurve,
      alerts,
      performance: {
        totalTrades: completed.length,
        winRatePct: completed.length ? wins.length / completed.length * 100 : 0,
        profitFactor: losses ? gains / losses : 0,
        grossPnl: completed.reduce((sum, trade) => sum + trade.grossPnl, 0),
        netPnl: completed.reduce((sum, trade) => sum + trade.netPnl, 0),
        fees: this.state.totalFees,
        fundingCashFlow: this.state.totalFundingCashFlow,
        averageTrade: completed.length ? completed.reduce((sum, trade) => sum + trade.netPnl, 0) / completed.length : 0,
      },
      updatedAt: Date.now(),
    };
  }

  getMarketStream(): MexcMarketStream { return this.marketStream; }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.marketStream.stop();
    await this.mutex.runExclusive(async () => {
      this.state.running = false;
      this.state.paused = true;
      await this.persist();
    });
  }
}

function candleStartTime(timestamp: number): number { return Math.floor(timestamp / 60_000) * 60_000; }
function safeMessage(error: unknown): string {
  if (error instanceof MexcApiError) return error.message.slice(0, 240);
  if (error instanceof Error) return error.message.slice(0, 240);
  return 'Unknown error';
}
function wait(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function emptyRisk(): RiskAssessment {
  return { accepted: false, quantity: 0, estimatedRisk: 0, riskBudget: 0, aggregateRiskAfter: 0,
    marginRequired: 0, leverage: 0, stopPrice: 0, takeProfitPrice: 0, estimatedFees: 0,
    estimatedSlippage: 0, liquidationDistancePct: 0 };
}
