import type { Direction, TradingMode } from './types.js';

export interface IndicatorConfig {
  kdjLength: number;
  kSmoothing: number;
  dSmoothing: number;
  emaFast: number;
  emaSlow: number;
  atrLength: number;
}

export interface StrategyConfig {
  maxCandleRangeAtr: number;
  maxSpreadRate: number;
  minDepthLiquidityUsd: number;
  maxMarketDataAgeMs: number;
  maxSignalCandleAgeMs: number;
  minKdjLong: number;
  maxKdjShort: number;
  emaCrossCooldownCandles: number;
  stopAtrMultiple: number;
  takeProfitR: number;
  maxHoldingCandles: number;
  minimumNetRewardAfterCosts: number;
}

export interface RiskConfig {
  riskPerTrade: number;
  dailyMaxLoss: number;
  aggregatePortfolioRiskLimit: number;
  maxOpenPositions: number;
  maxLeverage: number;
  marginMode: 'ISOLATED';
  maxMarginUtilization: number;
  estimatedTakerFeeRate: number;
  estimatedMakerFeeRate: number;
  estimatedSlippageRate: number;
  minLiquidationBufferFraction: number;
  maxConsecutiveLosses: number;
  timezone: string;
  paperInitialEquity: number;
  compoundingEnabled: boolean;
  martingaleEnabled: false;
  averagingDownEnabled: false;
}

export interface AppConfig {
  port: number;
  host: string;
  databaseUrl?: string;
  sqlitePath: string;
  mexcRestUrl: string;
  mexcWebsocketUrl: string;
  symbols: string[];
  universe: {
    autoDiscoverHighVolatility: boolean;
    maxAssets: number;
    minDailyRangePct: number;
  };
  indicators: IndicatorConfig;
  strategy: StrategyConfig;
  risk: RiskConfig;
  live: {
    allowLiveTrading: boolean;
    hasApiKey: boolean;
    hasApiSecret: boolean;
    apiPermissionVerified: boolean;
    feesVerified: boolean;
    protectiveOrdersTested: boolean;
    backtestAccepted: boolean;
    paperAcceptancePassed: boolean;
    recoveryTestPassed: boolean;
    dashboardTokenConfigured: boolean;
  };
  nodeEnv: string;
}

function numberValue(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a finite number`);
  return parsed;
}

function boolValue(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function clampConfigured(value: number, min: number, max: number, name: string): number {
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const symbols = (env.SYMBOLS ?? 'BTC_USDT,ETH_USDT,SOL_USDT,XRP_USDT,DOGE_USDT')
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
  if (!symbols.length || symbols.length > 100 || symbols.some((symbol) => !/^[A-Z0-9]{2,24}_USDT$/.test(symbol))) {
    throw new Error('SYMBOLS must contain 1–100 comma-separated USDT perpetual symbols, e.g. BTC_USDT');
  }
  if (new Set(symbols).size !== symbols.length) throw new Error('SYMBOLS cannot contain duplicates');
  const maxScannerAssets = clampConfigured(numberValue(env, 'MAX_SCANNER_ASSETS', 100), 1, 100, 'MAX_SCANNER_ASSETS');
  if (!Number.isInteger(maxScannerAssets)) throw new Error('MAX_SCANNER_ASSETS must be an integer from 1 to 100');
  const minDailyRangePct = clampConfigured(numberValue(env, 'MIN_DAILY_RANGE_PCT', 2), 0.1, 100, 'MIN_DAILY_RANGE_PCT');

  const maxLeverage = clampConfigured(numberValue(env, 'MAX_LEVERAGE', 10), 1, 10, 'MAX_LEVERAGE');
  const maxOpenPositions = clampConfigured(numberValue(env, 'MAX_OPEN_POSITIONS', 10), 1, 10, 'MAX_OPEN_POSITIONS');
  const riskPerTrade = clampConfigured(numberValue(env, 'RISK_PER_TRADE', 0.08), 0.0001, 0.08, 'RISK_PER_TRADE');
  const dailyMaxLoss = clampConfigured(numberValue(env, 'DAILY_MAX_LOSS', 0.5), 0.001, 0.5, 'DAILY_MAX_LOSS');
  const aggregatePortfolioRiskLimit = clampConfigured(
    numberValue(env, 'AGGREGATE_PORTFOLIO_RISK_LIMIT', 0.2),
    0.001,
    1,
    'AGGREGATE_PORTFOLIO_RISK_LIMIT',
  );
  const estimatedTakerFeeRate = clampConfigured(numberValue(env, 'TAKER_FEE_RATE', 0.0008), 0, 0.05, 'TAKER_FEE_RATE');
  const estimatedMakerFeeRate = clampConfigured(numberValue(env, 'MAKER_FEE_RATE', 0.0006), 0, 0.05, 'MAKER_FEE_RATE');
  const estimatedSlippageRate = clampConfigured(numberValue(env, 'SLIPPAGE_RATE', 0.0005), 0, 0.05, 'SLIPPAGE_RATE');
  const paperInitialEquity = clampConfigured(numberValue(env, 'PAPER_INITIAL_EQUITY', 10_000), 1, 1_000_000_000, 'PAPER_INITIAL_EQUITY');
  const kSmoothing = clampConfigured(numberValue(env, 'KDJ_SMOOTHING_K', 3), 1, 50, 'KDJ_SMOOTHING_K');
  const dSmoothing = clampConfigured(numberValue(env, 'KDJ_SMOOTHING_D', 3), 1, 50, 'KDJ_SMOOTHING_D');
  if (!Number.isInteger(kSmoothing) || !Number.isInteger(dSmoothing)) {
    throw new Error('KDJ_SMOOTHING_K and KDJ_SMOOTHING_D must be positive integers');
  }

  const config: AppConfig = {
    port: Math.round(clampConfigured(numberValue(env, 'PORT', 3001), 1, 65535, 'PORT')),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    sqlitePath: env.SQLITE_PATH ?? './data/royalusd.sqlite',
    mexcRestUrl: (env.MEXC_REST_URL ?? 'https://api.mexc.com').replace(/\/$/, ''),
    mexcWebsocketUrl: env.MEXC_WS_URL ?? 'wss://contract.mexc.com/edge',
    symbols,
    universe: {
      autoDiscoverHighVolatility: boolValue(env, 'AUTO_DISCOVER_HIGH_VOLATILITY', true),
      maxAssets: maxScannerAssets,
      minDailyRangePct,
    },
    indicators: {
      kdjLength: Math.round(clampConfigured(numberValue(env, 'KDJ_LENGTH', 9), 2, 500, 'KDJ_LENGTH')),
      kSmoothing,
      dSmoothing,
      emaFast: Math.round(clampConfigured(numberValue(env, 'EMA_FAST', 9), 2, 500, 'EMA_FAST')),
      emaSlow: Math.round(clampConfigured(numberValue(env, 'EMA_SLOW', 21), 2, 500, 'EMA_SLOW')),
      atrLength: Math.round(clampConfigured(numberValue(env, 'ATR_LENGTH', 14), 2, 500, 'ATR_LENGTH')),
    },
    strategy: {
      maxCandleRangeAtr: clampConfigured(numberValue(env, 'MAX_CANDLE_RANGE_ATR', 2.5), 0.1, 20, 'MAX_CANDLE_RANGE_ATR'),
      maxSpreadRate: clampConfigured(numberValue(env, 'MAX_SPREAD_RATE', 0.001), 0, 0.1, 'MAX_SPREAD_RATE'),
      minDepthLiquidityUsd: clampConfigured(numberValue(env, 'MIN_DEPTH_LIQUIDITY_USD', 5_000), 0, 100_000_000, 'MIN_DEPTH_LIQUIDITY_USD'),
      maxMarketDataAgeMs: Math.round(clampConfigured(numberValue(env, 'MAX_MARKET_DATA_AGE_MS', 15_000), 1_000, 300_000, 'MAX_MARKET_DATA_AGE_MS')),
      maxSignalCandleAgeMs: Math.round(clampConfigured(numberValue(env, 'MAX_SIGNAL_CANDLE_AGE_MS', 90_000), 60_000, 600_000, 'MAX_SIGNAL_CANDLE_AGE_MS')),
      minKdjLong: clampConfigured(numberValue(env, 'KDJ_LONG_MAX', 30), 1, 50, 'KDJ_LONG_MAX'),
      maxKdjShort: clampConfigured(numberValue(env, 'KDJ_SHORT_MIN', 70), 50, 99, 'KDJ_SHORT_MIN'),
      emaCrossCooldownCandles: Math.round(clampConfigured(numberValue(env, 'EMA_CROSS_COOLDOWN_CANDLES', 3), 0, 100, 'EMA_CROSS_COOLDOWN_CANDLES')),
      stopAtrMultiple: clampConfigured(numberValue(env, 'STOP_ATR_MULTIPLE', 1), 0.1, 10, 'STOP_ATR_MULTIPLE'),
      takeProfitR: clampConfigured(numberValue(env, 'TAKE_PROFIT_R', 1.5), 0.1, 20, 'TAKE_PROFIT_R'),
      maxHoldingCandles: Math.round(clampConfigured(numberValue(env, 'MAX_HOLDING_CANDLES', 15), 1, 10_000, 'MAX_HOLDING_CANDLES')),
      minimumNetRewardAfterCosts: clampConfigured(numberValue(env, 'MIN_NET_REWARD_AFTER_COSTS', 0), 0, 100, 'MIN_NET_REWARD_AFTER_COSTS'),
    },
    risk: {
      riskPerTrade,
      dailyMaxLoss,
      aggregatePortfolioRiskLimit,
      maxOpenPositions,
      maxLeverage,
      marginMode: 'ISOLATED',
      maxMarginUtilization: clampConfigured(numberValue(env, 'MAX_MARGIN_UTILIZATION', 0.5), 0.01, 0.9, 'MAX_MARGIN_UTILIZATION'),
      estimatedTakerFeeRate,
      estimatedMakerFeeRate,
      estimatedSlippageRate,
      minLiquidationBufferFraction: clampConfigured(numberValue(env, 'LIQUIDATION_BUFFER_FRACTION', 0.5), 0.1, 0.9, 'LIQUIDATION_BUFFER_FRACTION'),
      maxConsecutiveLosses: Math.round(clampConfigured(numberValue(env, 'MAX_CONSECUTIVE_LOSSES', 3), 1, 100, 'MAX_CONSECUTIVE_LOSSES')),
      timezone: env.ACCOUNT_TIMEZONE ?? 'UTC',
      paperInitialEquity,
      compoundingEnabled: boolValue(env, 'COMPOUNDING_ENABLED', true),
      martingaleEnabled: false,
      averagingDownEnabled: false,
    },
    live: {
      allowLiveTrading: boolValue(env, 'ALLOW_LIVE_TRADING', false),
      hasApiKey: Boolean(env.MEXC_API_KEY?.trim()),
      hasApiSecret: Boolean(env.MEXC_API_SECRET?.trim()),
      apiPermissionVerified: boolValue(env, 'MEXC_LIVE_API_PERMISSION_VERIFIED', false),
      feesVerified: boolValue(env, 'MEXC_LIVE_FEES_VERIFIED', false),
      protectiveOrdersTested: boolValue(env, 'MEXC_PROTECTIVE_ORDERS_TESTED', false),
      backtestAccepted: boolValue(env, 'BACKTEST_ACCEPTED', false),
      paperAcceptancePassed: boolValue(env, 'PAPER_ACCEPTANCE_PASSED', false),
      recoveryTestPassed: boolValue(env, 'RECOVERY_TEST_PASSED', false),
      dashboardTokenConfigured: Boolean(env.DASHBOARD_API_TOKEN?.trim()),
    },
    nodeEnv: env.NODE_ENV ?? 'development',
  };
  if (config.indicators.emaFast >= config.indicators.emaSlow) throw new Error('EMA_FAST must be smaller than EMA_SLOW');
  return config;
}

export const FIXED_DEFAULTS = {
  exchange: 'MEXC Futures' as const,
  contractType: 'USDT-margined perpetual' as const,
  timeframe: '1m' as const,
  directions: ['LONG', 'SHORT'] as Direction[],
  defaultMode: 'PAPER' as TradingMode,
  liveTradingDefault: false,
};

export function getLiveReadiness(config: AppConfig): { ready: boolean; blockers: string[] } {
  const checks: Array<[string, boolean]> = [
    ['server-side ALLOW_LIVE_TRADING is not enabled', config.live.allowLiveTrading],
    ['MEXC API key is missing', config.live.hasApiKey],
    ['MEXC API secret is missing', config.live.hasApiSecret],
    ['futures order permissions have not been verified', config.live.apiPermissionVerified],
    ['account-specific fee schedule has not been verified', config.live.feesVerified],
    ['protective-order behavior has not been tested on the exchange', config.live.protectiveOrdersTested],
    ['backtest acceptance has not been recorded', config.live.backtestAccepted],
    ['paper-trading acceptance has not been recorded', config.live.paperAcceptancePassed],
    ['restart and recovery acceptance has not been recorded', config.live.recoveryTestPassed],
    ['dashboard authentication token is not configured', config.live.dashboardTokenConfigured || config.nodeEnv !== 'production'],
  ];
  const blockers = checks.filter(([, passed]) => !passed).map(([message]) => message);
  return { ready: blockers.length === 0, blockers };
}
