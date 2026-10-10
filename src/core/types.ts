export type Direction = 'LONG' | 'SHORT';
export type TradingMode = 'BACKTEST' | 'PAPER' | 'LIVE';
export type RuntimeStatus = 'STOPPED' | 'CONNECTING' | 'RUNNING' | 'PAUSED' | 'DEGRADED' | 'LOCKED';

export interface Candle {
  symbol?: string;
  openTime: number; // Unix milliseconds, candle window start
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  complete: boolean;
  /** Signed MEXC funding rate when this candle contains a funding timestamp. */
  fundingRate?: number;
}

export interface IndicatorPoint {
  openTime: number;
  close: number;
  high: number;
  low: number;
  k: number;
  d: number;
  j: number;
  emaFast: number;
  emaSlow: number;
  atr: number | null;
  ready: boolean;
}

export interface ContractSpec {
  symbol: string;
  contractSize: number;
  priceUnit: number;
  volUnit: number;
  minVol: number;
  maxVol: number;
  minLeverage: number;
  maxLeverage: number;
  makerFeeRate: number;
  takerFeeRate: number;
  maintenanceMarginRate: number;
  state: number;
  apiAllowed: boolean;
  futureType: number;
  quoteCoin: string;
  settleCoin: string;
}

export interface OrderBookLevel {
  price: number;
  volume: number;
}

export interface MarketContext {
  symbol: string;
  bid: number;
  ask: number;
  spreadRate: number;
  liquidityUsd: number;
  observedAt: number;
  currentPrice: number;
}

export type RejectReason =
  | 'WARMUP'
  | 'INVALID_CANDLES'
  | 'INCOMPLETE_CANDLE'
  | 'STALE_MARKET_DATA'
  | 'NO_CROSSOVER'
  | 'KDJ_ZONE'
  | 'J_NOT_CONFIRMING'
  | 'EMA_TREND'
  | 'CLOSE_VS_EMA'
  | 'INVALID_ATR'
  | 'ABNORMAL_CANDLE'
  | 'SPREAD_TOO_WIDE'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'CONTRACT_DISABLED'
  | 'DUPLICATE_OR_CONFLICTING_POSITION'
  | 'POSITION_LIMIT'
  | 'PAUSED'
  | 'DAILY_RISK_LOCK'
  | 'CONSECUTIVE_LOSS_LOCK'
  | 'AGGREGATE_RISK_LIMIT'
  | 'INDIVIDUAL_RISK_LIMIT'
  | 'MARGIN_LIMIT'
  | 'LIQUIDATION_SAFETY'
  | 'MINIMUM_SIZE'
  | 'NET_REWARD_NOT_POSITIVE'
  | 'INVALID_ACCOUNT_SNAPSHOT'
  | 'EXCHANGE_RECONCILIATION_REQUIRED'
  | 'SYMBOL_RISK_LIMIT';

export interface StrategySignal {
  symbol: string;
  direction: Direction;
  candleTime: number;
  close: number;
  atr: number;
  stopDistance: number;
  targetDistance: number;
  indicators: IndicatorPoint;
  estimatedNetRewardPerContract: number;
}

export interface SignalDecision {
  accepted: boolean;
  /** True once a fresh K/D crossover has produced a candidate worth auditing. */
  candidate?: boolean;
  signal?: StrategySignal;
  reason?: RejectReason;
  details?: string;
}

export interface PositionRisk {
  id: string;
  symbol: string;
  direction: Direction;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  stopRisk: number; // quote-currency amount, including estimated exit costs
  marginUsed: number;
  unrealizedPnl: number;
  openedAt: number;
  barsHeld: number;
  breakevenMoved: boolean;
  takeProfitPrice: number;
  protectiveOrderId?: string;
  exchangePositionId?: string;
  source: 'PAPER' | 'LIVE' | 'EXTERNAL';
  feesPaid: number;
  fundingCashFlow: number;
}

export interface PendingEntry {
  id: string;
  symbol: string;
  direction: Direction;
  risk: number;
  margin: number;
  createdAt: number;
  externalOrderId?: string;
  status: 'PENDING' | 'SUBMITTING' | 'UNKNOWN' | 'PARTIALLY_FILLED';
}

export interface RiskAccountSnapshot {
  equity: number;
  availableMargin: number;
  startingEquity: number;
  dailyStartingEquity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  dailyDrawdown: number;
  dailyLocked: boolean;
  consecutiveLossLocked: boolean;
  reconciliationHealthy: boolean;
}

export interface RiskAssessment {
  accepted: boolean;
  reason?: RejectReason;
  details?: string;
  quantity: number;
  estimatedRisk: number;
  riskBudget: number;
  aggregateRiskAfter: number;
  marginRequired: number;
  leverage: number;
  stopPrice: number;
  takeProfitPrice: number;
  estimatedFees: number;
  estimatedSlippage: number;
  liquidationDistancePct: number;
}

export interface SignalRecord {
  id: string;
  symbol: string;
  createdAt: number;
  candleTime: number;
  direction?: Direction;
  accepted: boolean;
  reason?: string;
  details?: string;
  indicators?: IndicatorPoint;
  decision?: StrategySignal;
}

export interface AccountSnapshot {
  equity: number;
  availableMargin: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fees: number;
  fundingCashFlow: number;
  dailyDrawdown: number;
  marginUtilization: number;
  aggregateRisk: number;
  dailyStartingEquity: number;
  dailyLocked: boolean;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  source: 'PAPER' | 'MEXC' | 'UNSYNCED';
  updatedAt: number;
}

export interface AuditEvent<T = Record<string, unknown>> {
  id?: number;
  type: string;
  symbol?: string;
  occurredAt: number;
  correlationId?: string;
  payload: T;
}

export interface BacktestTrade {
  id: string;
  symbol: string;
  direction: Direction;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  fundingCashFlow: number;
  netPnl: number;
  initialRisk: number;
  exitReason: 'STOP' | 'TARGET' | 'BREAKEVEN' | 'OPPOSITE_SIGNAL' | 'TIME' | 'EMERGENCY';
}

export interface BacktestMetrics {
  initialEquity: number;
  finalEquity: number;
  netReturnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  profitFactor: number;
  expectancy: number;
  averageWinner: number;
  averageLoser: number;
  grossPnl: number;
  netPnl: number;
  totalFees: number;
  totalSlippage: number;
  fundingCashFlow: number;
  maxSimultaneousPositions: number;
  maxAggregateRiskPct: number;
  longTrades: number;
  shortTrades: number;
  longNetPnl: number;
  shortNetPnl: number;
  maxConsecutiveLosses: number;
  dailyLossLockEvents: number;
  marginLimitEvents: number;
  liquidationRiskEvents: number;
  monthlyNetPnl: Record<string, number>;
  perSymbolNetPnl: Record<string, number>;
  trades: BacktestTrade[];
}

export interface BacktestReport {
  generatedAt: number;
  configVersion: string;
  dataStart: number;
  dataEnd: number;
  candleCount: number;
  symbols: string[];
  splits: {
    development: BacktestMetrics;
    validation: BacktestMetrics;
    outOfSample: BacktestMetrics;
  };
  stressScenarios: Record<string, Pick<BacktestMetrics, 'netReturnPct' | 'maxDrawdownPct' | 'totalFees' | 'maxSimultaneousPositions' | 'dailyLossLockEvents' | 'marginLimitEvents'>>;
  warnings: string[];
}
