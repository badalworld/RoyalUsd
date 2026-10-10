import type {
  Candle,
  ContractSpec,
  IndicatorPoint,
  MarketContext,
  RejectReason,
  SignalDecision,
} from './types.js';
import type { AppConfig } from './config.js';
import { calculateIndicatorSeries } from './indicators.js';
import { estimateTargetNetRewardPerContract, roundPriceToTick } from './accounting.js';

interface DecisionContext {
  symbol: string;
  candles: Candle[];
  /** Optional causal prefix precomputed by the shared indicator engine. */
  indicatorPoints?: IndicatorPoint[];
  market: MarketContext;
  contract: ContractSpec;
  now?: number;
  config: Pick<AppConfig, 'indicators' | 'strategy' | 'risk'>;
  /** Account-specific rates, when verified. Larger values are used conservatively. */
  feeRates?: { makerFeeRate: number; takerFeeRate: number };
}

function rejected(reason: RejectReason, details: string, candidate = false): SignalDecision {
  return { accepted: false, candidate, reason, details };
}

function lastCompleted(candles: Candle[]): Candle | undefined {
  return [...candles].reverse().find((candle) => candle.complete);
}

export function evaluateSignal(context: DecisionContext): SignalDecision {
  const { symbol, candles, market, contract, config } = context;
  const now = context.now ?? Date.now();
  if (!Array.isArray(candles) || candles.length === 0) return rejected('INVALID_CANDLES', 'No candle history is available.');
  const completed = candles.filter((candle) => candle.complete);
  const candle = lastCompleted(candles);
  let points: IndicatorPoint[];
  try {
    points = context.indicatorPoints ?? calculateIndicatorSeries(candles, config.indicators);
    if (points.length !== completed.length || points.at(-1)?.openTime !== candle?.openTime) {
      return rejected('INVALID_CANDLES', 'Indicator prefix does not match the completed candles.');
    }
  } catch (error) {
    return rejected('INVALID_CANDLES', error instanceof Error ? error.message : 'Candle validation failed.');
  }
  if (!candle || points.length < 2) return rejected('WARMUP', 'At least two completed indicator points are required.');
  if (!candle.complete) return rejected('INCOMPLETE_CANDLE', 'The signal candle has not closed.');

  const current = points.at(-1)!;
  const previous = points.at(-2)!;
  if (!current.ready || current.atr === null) return rejected('WARMUP', 'Waiting for KDJ, EMA 21, and ATR 14 warm-up history.');
  const closeTime = candle.openTime + 60_000;
  if (now < closeTime) return rejected('INCOMPLETE_CANDLE', 'The candle close timestamp is still in the future.');
  if (now - closeTime > config.strategy.maxSignalCandleAgeMs
    || now - market.observedAt > config.strategy.maxMarketDataAgeMs
    || market.observedAt > now + 1_000) {
    return rejected('STALE_MARKET_DATA', 'The completed candle or live market context is stale.');
  }

  const longCross = previous.k <= previous.d && current.k > current.d;
  const shortCross = previous.k >= previous.d && current.k < current.d;
  if (!longCross && !shortCross) return rejected('NO_CROSSOVER', 'No new K/D crossover on this completed candle.');
  const direction = longCross ? 'LONG' : 'SHORT';
  const signalCandidate = (reason: RejectReason, details: string): SignalDecision => rejected(reason, details, true);

  if (direction === 'LONG' && !(current.k < config.strategy.minKdjLong && current.d < config.strategy.minKdjLong)) {
    return signalCandidate('KDJ_ZONE', `Long crossover requires K and D below ${config.strategy.minKdjLong}.`);
  }
  if (direction === 'SHORT' && !(current.k > config.strategy.maxKdjShort && current.d > config.strategy.maxKdjShort)) {
    return signalCandidate('KDJ_ZONE', `Short crossover requires K and D above ${config.strategy.maxKdjShort}.`);
  }
  if (direction === 'LONG' && !(current.j > previous.j)) return signalCandidate('J_NOT_CONFIRMING', 'J did not rise across the crossover.');
  if (direction === 'SHORT' && !(current.j < previous.j)) return signalCandidate('J_NOT_CONFIRMING', 'J did not fall across the crossover.');

  const emaSigns = completed.map((item, index) => {
    const point = points[index];
    return point ? Math.sign(point.emaFast - point.emaSlow) : 0;
  });
  let lastEmaCrossIndex = -Infinity;
  for (let index = 1; index < emaSigns.length; index += 1) {
    if (emaSigns[index] !== 0 && emaSigns[index - 1] !== 0 && emaSigns[index] !== emaSigns[index - 1]) lastEmaCrossIndex = index;
  }
  const currentIndex = points.length - 1;
  if (config.strategy.emaCrossCooldownCandles > 0
    && currentIndex - lastEmaCrossIndex <= config.strategy.emaCrossCooldownCandles) {
    return signalCandidate('EMA_TREND', 'Signal is inside the configured EMA cross cooldown.');
  }
  if (direction === 'LONG' && !(current.emaFast > current.emaSlow)) {
    return signalCandidate('EMA_TREND', 'Long entry requires EMA 9 above EMA 21.');
  }
  if (direction === 'SHORT' && !(current.emaFast < current.emaSlow)) {
    return signalCandidate('EMA_TREND', 'Short entry requires EMA 9 below EMA 21.');
  }
  if (direction === 'LONG' && !(candle.close > current.emaFast)) {
    return signalCandidate('CLOSE_VS_EMA', 'Long entry requires close above EMA 9.');
  }
  if (direction === 'SHORT' && !(candle.close < current.emaFast)) {
    return signalCandidate('CLOSE_VS_EMA', 'Short entry requires close below EMA 9.');
  }
  if (!(current.atr > 0) || !Number.isFinite(current.atr)) {
    return signalCandidate('INVALID_ATR', 'ATR 14 must be positive and finite.');
  }
  if (candle.high - candle.low > config.strategy.maxCandleRangeAtr * current.atr) {
    return signalCandidate('ABNORMAL_CANDLE', `Candle range exceeds ${config.strategy.maxCandleRangeAtr} × ATR.`);
  }
  if (!Number.isFinite(market.bid) || !Number.isFinite(market.ask) || market.bid <= 0 || market.ask < market.bid) {
    return signalCandidate('STALE_MARKET_DATA', 'Best bid/ask snapshot is invalid.');
  }
  if (!Number.isFinite(market.spreadRate) || market.spreadRate > config.strategy.maxSpreadRate) {
    return signalCandidate('SPREAD_TOO_WIDE', `Observed spread ${market.spreadRate} exceeds configured maximum ${config.strategy.maxSpreadRate}.`);
  }
  if (!Number.isFinite(market.liquidityUsd) || market.liquidityUsd < config.strategy.minDepthLiquidityUsd) {
    return signalCandidate('INSUFFICIENT_LIQUIDITY', `Order-book liquidity is below ${config.strategy.minDepthLiquidityUsd} USDT.`);
  }
  if (contract.state !== 0 || contract.futureType !== 1 || contract.quoteCoin !== 'USDT' || contract.settleCoin !== 'USDT' || !contract.apiAllowed) {
    return signalCandidate('CONTRACT_DISABLED', 'Contract is not an API-enabled USDT perpetual.');
  }
  if (!(contract.contractSize > 0) || !(contract.volUnit > 0) || !(contract.minVol > 0) || !(contract.priceUnit > 0)) {
    return signalCandidate('CONTRACT_DISABLED', 'Contract sizing metadata is missing or invalid.');
  }

  const stopDistance = current.atr * config.strategy.stopAtrMultiple;
  const targetDistance = stopDistance * config.strategy.takeProfitR;
  const entryReference = direction === 'LONG' ? market.ask : market.bid;
  let roundedTarget: number;
  try {
    roundedTarget = roundPriceToTick(direction === 'LONG' ? entryReference + targetDistance : entryReference - targetDistance,
      contract.priceUnit, direction === 'LONG' ? 'DOWN' : 'UP');
  } catch {
    return signalCandidate('NET_REWARD_NOT_POSITIVE', 'Target price cannot be represented at the contract tick size.');
  }
  if ((direction === 'LONG' && roundedTarget <= entryReference) || (direction === 'SHORT' && roundedTarget >= entryReference)) {
    return signalCandidate('NET_REWARD_NOT_POSITIVE', 'Tick-rounded target is not beyond the entry reference.');
  }
  const executableTargetDistance = Math.abs(roundedTarget - entryReference);
  const makerFeeRate = Math.max(contract.makerFeeRate, context.feeRates?.makerFeeRate ?? 0, config.risk.estimatedMakerFeeRate);
  const takerFeeRate = Math.max(contract.takerFeeRate, context.feeRates?.takerFeeRate ?? 0, config.risk.estimatedTakerFeeRate);
  const estimatedNetRewardPerContract = estimateTargetNetRewardPerContract(
    direction,
    entryReference,
    executableTargetDistance,
    {
      makerFeeRate,
      takerFeeRate,
      slippageRate: config.risk.estimatedSlippageRate,
      spreadRate: market.spreadRate,
      contractSize: contract.contractSize,
    },
  );
  if (!(estimatedNetRewardPerContract > config.strategy.minimumNetRewardAfterCosts)) {
    return signalCandidate('NET_REWARD_NOT_POSITIVE', 'Estimated 1.5R reward does not cover modeled fees, spread, and slippage.');
  }

  const signal = {
    symbol,
    direction,
    candleTime: candle.openTime,
    close: candle.close,
    atr: current.atr,
    stopDistance,
    targetDistance,
    indicators: current,
    estimatedNetRewardPerContract,
  } as const;
  return { accepted: true, candidate: true, signal };
}
