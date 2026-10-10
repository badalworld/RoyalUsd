import type {
  BacktestMetrics,
  BacktestReport,
  BacktestTrade,
  Candle,
  ContractSpec,
  Direction,
  IndicatorPoint,
  PendingEntry,
  PositionRisk,
  RiskAccountSnapshot,
  StrategySignal,
} from './types.js';
import type { AppConfig } from './config.js';
import { accountDate, createDailyRiskState, recordClosedTrade, updateDailyRiskState, type DailyRiskState } from './daily-risk.js';
import { calculateIndicatorSeries } from './indicators.js';
import { estimateStopRiskPerContract, fundingCashFlow, roundPriceToTick } from './accounting.js';
import { assessPositionRisk } from './risk.js';
import { evaluateSignal } from './strategy.js';

export interface BacktestStressOptions {
  feeMultiplier?: number;
  spreadRate?: number;
  slippageMultiplier?: number;
  gapShockRate?: number;
  executionDelayBars?: number;
  partialFillFraction?: number;
  outageEveryNOrders?: number;
}

export interface BacktestInput {
  barsBySymbol: Record<string, Candle[]>;
  contractsBySymbol: Record<string, ContractSpec>;
  config: AppConfig;
  initialEquity?: number;
  assumedSpreadRate?: number;
  stress?: BacktestStressOptions;
}

interface SimPosition extends PositionRisk {
  entryReferencePrice: number;
  entryFee: number;
  entrySlippage: number;
  entrySpread: number;
  entryRisk: number;
  stopDistance: number;
  stopRisk: number;
  contractSize: number;
  takerFeeRate: number;
  slippageRate: number;
  spreadRate: number;
  pendingExit?: { reason: BacktestTrade['exitReason']; scheduledTime: number };
}

interface PendingSimEntry {
  id: string;
  signal: StrategySignal;
  scheduledIndex: number;
  scheduledTime: number;
  risk: number;
  margin: number;
}

interface SegmentResult {
  metrics: BacktestMetrics;
  rejectedSignals: number;
  dataStart: number;
  dataEnd: number;
}

function defaultMarketContract(symbol: string): ContractSpec {
  return {
    symbol,
    contractSize: 1,
    priceUnit: 0.01,
    volUnit: 0.001,
    minVol: 0.001,
    maxVol: 1_000_000,
    minLeverage: 1,
    maxLeverage: 10,
    makerFeeRate: 0.0006,
    takerFeeRate: 0.0008,
    maintenanceMarginRate: 0.005,
    state: 0,
    apiAllowed: true,
    futureType: 1,
    quoteCoin: 'USDT',
    settleCoin: 'USDT',
  };
}

function sortedBars(barsBySymbol: Record<string, Candle[]>): Record<string, Candle[]> {
  const result: Record<string, Candle[]> = {};
  for (const [symbol, bars] of Object.entries(barsBySymbol)) {
    const sorted = bars.filter((bar) => bar.complete).map((bar) => ({ ...bar, symbol })).sort((a, b) => a.openTime - b.openTime);
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index]!.openTime === sorted[index - 1]!.openTime) throw new Error(`Duplicate ${symbol} candle at ${sorted[index]!.openTime}`);
    }
    result[symbol] = sorted;
  }
  return result;
}

function sign(direction: Direction): number { return direction === 'LONG' ? 1 : -1; }

function executionReferenceWithGap(reference: number, direction: Direction, isEntry: boolean, shock: number): number {
  if (!(shock > 0)) return reference;
  const adverse = (isEntry ? direction === 'LONG' : direction === 'SHORT') ? 1 : -1;
  return reference * (1 + adverse * shock);
}

function toRiskPosition(position: SimPosition, mark: number): PositionRisk {
  const unrealizedPnl = sign(position.direction) * (mark - position.entryReferencePrice) * position.quantity * position.contractSize;
  return {
    id: position.id,
    symbol: position.symbol,
    direction: position.direction,
    quantity: position.quantity,
    entryPrice: position.entryPrice,
    stopPrice: position.stopPrice,
    stopRisk: position.stopRisk,
    marginUsed: position.marginUsed,
    unrealizedPnl,
    openedAt: position.openedAt,
    barsHeld: position.barsHeld,
    breakevenMoved: position.breakevenMoved,
    takeProfitPrice: position.takeProfitPrice,
    protectiveOrderId: position.protectiveOrderId,
    source: 'PAPER',
    feesPaid: position.feesPaid,
    fundingCashFlow: position.fundingCashFlow,
  };
}

function buildMetrics(input: {
  initialEquity: number;
  cash: number;
  trades: BacktestTrade[];
  maxDrawdownPct: number;
  maxSimultaneousPositions: number;
  maxAggregateRiskPct: number;
  dailyLossLockEvents: number;
  marginLimitEvents: number;
  liquidationRiskEvents: number;
  maxConsecutiveLosses: number;
  fees: number;
  slippage: number;
  funding: number;
}): BacktestMetrics {
  const { initialEquity, trades } = input;
  const netPnl = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossPnl = trades.reduce((sum, trade) => sum + trade.grossPnl, 0);
  const winners = trades.filter((trade) => trade.netPnl > 0);
  const losers = trades.filter((trade) => trade.netPnl < 0);
  const grossWinners = winners.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLosers = Math.abs(losers.reduce((sum, trade) => sum + trade.netPnl, 0));
  const monthlyNetPnl: Record<string, number> = {};
  const perSymbolNetPnl: Record<string, number> = {};
  for (const trade of trades) {
    const date = new Date(trade.exitTime).toISOString().slice(0, 7);
    monthlyNetPnl[date] = (monthlyNetPnl[date] ?? 0) + trade.netPnl;
    perSymbolNetPnl[trade.symbol] = (perSymbolNetPnl[trade.symbol] ?? 0) + trade.netPnl;
  }
  const longTrades = trades.filter((trade) => trade.direction === 'LONG');
  const shortTrades = trades.filter((trade) => trade.direction === 'SHORT');
  return {
    initialEquity,
    finalEquity: input.cash,
    netReturnPct: initialEquity > 0 ? ((input.cash - initialEquity) / initialEquity) * 100 : 0,
    maxDrawdownPct: input.maxDrawdownPct,
    winRatePct: trades.length ? (winners.length / trades.length) * 100 : 0,
    profitFactor: grossLosers > 0 ? grossWinners / grossLosers : 0,
    expectancy: trades.length ? netPnl / trades.length : 0,
    averageWinner: winners.length ? grossWinners / winners.length : 0,
    averageLoser: losers.length ? losers.reduce((sum, trade) => sum + trade.netPnl, 0) / losers.length : 0,
    grossPnl,
    netPnl,
    totalFees: input.fees,
    totalSlippage: input.slippage,
    fundingCashFlow: input.funding,
    maxSimultaneousPositions: input.maxSimultaneousPositions,
    maxAggregateRiskPct: input.maxAggregateRiskPct,
    longTrades: longTrades.length,
    shortTrades: shortTrades.length,
    longNetPnl: longTrades.reduce((sum, trade) => sum + trade.netPnl, 0),
    shortNetPnl: shortTrades.reduce((sum, trade) => sum + trade.netPnl, 0),
    maxConsecutiveLosses: input.maxConsecutiveLosses,
    dailyLossLockEvents: input.dailyLossLockEvents,
    marginLimitEvents: input.marginLimitEvents,
    liquidationRiskEvents: input.liquidationRiskEvents,
    monthlyNetPnl,
    perSymbolNetPnl,
    trades,
  };
}

function runSegment(input: BacktestInput, startTime: number, endTime: number): SegmentResult {
  const config = input.config;
  const barsBySymbol = sortedBars(input.barsBySymbol);
  const symbols = Object.keys(barsBySymbol).filter((symbol) => barsBySymbol[symbol]!.length > 0).sort();
  const initialEquity = input.initialEquity ?? config.risk.paperInitialEquity;
  if (!(initialEquity > 0) || !Number.isFinite(initialEquity)) throw new Error('Backtest initial equity must be positive.');
  const spreadRate = input.stress?.spreadRate ?? input.assumedSpreadRate ?? 0.0004;
  const feeMultiplier = input.stress?.feeMultiplier ?? 1;
  const slippageRate = config.risk.estimatedSlippageRate * (input.stress?.slippageMultiplier ?? 1);
  const delayBars = Math.max(0, Math.floor(input.stress?.executionDelayBars ?? 0));
  const fillFraction = Math.min(1, Math.max(0, input.stress?.partialFillFraction ?? 1));
  const gapShockRate = Math.max(0, input.stress?.gapShockRate ?? 0);
  const outageEveryNOrders = Math.max(0, Math.floor(input.stress?.outageEveryNOrders ?? 0));

  const indicatorMap = new Map<string, IndicatorPoint[]>();
  const indexes = new Map<string, Map<number, number>>();
  const contracts = new Map<string, ContractSpec>();
  for (const symbol of symbols) {
    const bars = barsBySymbol[symbol]!;
    indicatorMap.set(symbol, calculateIndicatorSeries(bars, config.indicators));
    indexes.set(symbol, new Map(bars.map((bar, index) => [bar.openTime, index])));
    const supplied = input.contractsBySymbol[symbol] ?? defaultMarketContract(symbol);
    contracts.set(symbol, {
      ...supplied,
      makerFeeRate: Math.max(supplied.makerFeeRate, config.risk.estimatedMakerFeeRate) * feeMultiplier,
      takerFeeRate: Math.max(supplied.takerFeeRate, config.risk.estimatedTakerFeeRate) * feeMultiplier,
    });
  }
  const timeline = [...new Set(symbols.flatMap((symbol) => barsBySymbol[symbol]!.map((bar) => bar.openTime)))].sort((a, b) => a - b);
  const eventsAt = new Map<number, Array<{ symbol: string; index: number; candle: Candle }>>();
  for (const symbol of symbols) {
    barsBySymbol[symbol]!.forEach((candle, index) => {
      const bucket = eventsAt.get(candle.openTime) ?? [];
      bucket.push({ symbol, index, candle });
      eventsAt.set(candle.openTime, bucket);
    });
  }
  for (const bucket of eventsAt.values()) bucket.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const positions = new Map<string, SimPosition>();
  const pendingEntries = new Map<string, PendingSimEntry>();
  const trades: BacktestTrade[] = [];
  const marks = new Map<string, number>();
  let cash = initialEquity;
  let totalFees = 0;
  let totalSlippage = 0;
  let totalFunding = 0;
  let maxDrawdownPct = 0;
  let peakEquity = initialEquity;
  let maxSimultaneousPositions = 0;
  let maxAggregateRiskPct = 0;
  let dailyLossLockEvents = 0;
  let marginLimitEvents = 0;
  let liquidationRiskEvents = 0;
  let maxConsecutiveLosses = 0;
  let orderAttempts = 0;
  let dailyState: DailyRiskState | undefined;
  let rejectedSignals = 0;

  const markedGross = (priceOverride?: Map<string, number>): number => {
    let result = 0;
    for (const position of positions.values()) {
      const mark = priceOverride?.get(position.symbol) ?? marks.get(position.symbol) ?? position.entryReferencePrice;
      const gross = sign(position.direction) * (mark - position.entryReferencePrice) * position.quantity * position.contractSize;
      // Entry costs were already debited from cash when filled; only estimate close-side costs here.
      const estimatedExitCosts = mark * position.quantity * position.contractSize
        * (position.takerFeeRate + position.slippageRate + position.spreadRate / 2);
      result += gross - estimatedExitCosts;
    }
    return result;
  };
  const equityNow = (priceOverride?: Map<string, number>): number => cash + markedGross(priceOverride);
  const marginUsed = (): number => [...positions.values()].reduce((sum, position) => sum + position.marginUsed, 0);
  const currentPositionRisks = (priceOverride?: Map<string, number>): PositionRisk[] => [...positions.values()].map((position) => toRiskPosition(
    position,
    priceOverride?.get(position.symbol) ?? marks.get(position.symbol) ?? position.entryReferencePrice,
  ));
  const pendingReservations = (exceptId?: string): PendingEntry[] => [...pendingEntries.values()]
    .filter((entry) => entry.id !== exceptId)
    .map((entry) => ({ id: entry.id, symbol: entry.signal.symbol, direction: entry.signal.direction,
      risk: entry.risk, margin: entry.margin, createdAt: entry.signal.candleTime, status: 'PENDING' }));
  const updateDay = (equity: number, timestamp: number): void => {
    const update = updateDailyRiskState({
      state: dailyState,
      equity,
      timestamp,
      timezone: config.risk.timezone,
      maxDailyLoss: config.risk.dailyMaxLoss,
      maxConsecutiveLosses: config.risk.maxConsecutiveLosses,
    });
    dailyState = update.state;
    if (update.newlyLocked) dailyLossLockEvents += 1;
    if (dailyState.locked) pendingEntries.clear();
  };
  const observeEquity = (timestamp: number, priceOverride?: Map<string, number>): void => {
    const equity = equityNow(priceOverride);
    updateDay(equity, timestamp);
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) maxDrawdownPct = Math.max(maxDrawdownPct, Math.max(0, (peakEquity - equity) / peakEquity * 100));
  };

  const closePosition = (
    position: SimPosition,
    referencePrice: number,
    timestamp: number,
    reason: BacktestTrade['exitReason'],
    contract: ContractSpec,
  ): void => {
    if (!positions.has(position.id)) return;
    const adverse = sign(position.direction) * -1;
    const exitReference = (reason === 'STOP' || reason === 'BREAKEVEN' || reason === 'EMERGENCY')
      ? executionReferenceWithGap(referencePrice, position.direction, false, gapShockRate)
      : referencePrice;
    const executionFill = exitReference * (1 + adverse * (slippageRate + spreadRate / 2));
    const exitNotional = executionFill * position.quantity * contract.contractSize;
    const exitFee = exitNotional * position.takerFeeRate;
    const exitSlipCost = referencePrice * position.quantity * contract.contractSize * slippageRate;
    const exitSpreadCost = referencePrice * position.quantity * contract.contractSize * spreadRate / 2;
    const grossPnl = sign(position.direction) * (exitReference - position.entryReferencePrice) * position.quantity * contract.contractSize;
    const netPnl = grossPnl - position.entryFee - exitFee - position.entrySlippage - exitSlipCost
      - position.entrySpread - exitSpreadCost + position.fundingCashFlow;
    // Funding was applied to cash at its settlement timestamp; do not book it again on close.
    cash += grossPnl - exitFee - exitSlipCost - exitSpreadCost;
    totalFees += exitFee;
    totalSlippage += exitSlipCost + exitSpreadCost;
    trades.push({
      id: position.id,
      symbol: position.symbol,
      direction: position.direction,
      entryTime: position.openedAt,
      exitTime: timestamp,
      entryPrice: position.entryReferencePrice,
      exitPrice: exitReference,
      quantity: position.quantity,
      grossPnl,
      fees: position.entryFee + exitFee,
      slippage: position.entrySlippage + exitSlipCost + position.entrySpread + exitSpreadCost,
      fundingCashFlow: position.fundingCashFlow,
      netPnl,
      initialRisk: position.entryRisk,
      exitReason: reason,
    });
    positions.delete(position.id);
    if (dailyState) {
      const updated = recordClosedTrade(dailyState, netPnl, config.risk.maxConsecutiveLosses, timestamp);
      dailyState = updated.state;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, dailyState.consecutiveLosses);
      if (updated.newlyLocked) {
        dailyLossLockEvents += 1;
        pendingEntries.clear();
      }
    }
  };

  const manageCandle = (symbol: string, candle: Candle, timestamp: number): void => {
    const position = [...positions.values()].find((item) => item.symbol === symbol);
    if (!position) return;
    const contract = contracts.get(symbol)!;
    if (Number.isFinite(candle.fundingRate) && candle.fundingRate !== 0) {
      const cashFlow = fundingCashFlow(position.direction, candle.fundingRate!, candle.close * position.quantity * contract.contractSize);
      position.fundingCashFlow += cashFlow;
      cash += cashFlow;
      totalFunding += cashFlow;
    }

    const long = position.direction === 'LONG';
    const openGapStop = long ? candle.open <= position.stopPrice : candle.open >= position.stopPrice;
    const openGapTarget = long ? candle.open >= position.takeProfitPrice : candle.open <= position.takeProfitPrice;
    const stopTouched = long ? candle.low <= position.stopPrice : candle.high >= position.stopPrice;
    const targetTouched = long ? candle.high >= position.takeProfitPrice : candle.low <= position.takeProfitPrice;
    // If both are reachable inside one OHLC bar, assume the adverse stop was first.
    if (openGapStop) {
      closePosition(position, candle.open, timestamp, position.breakevenMoved ? 'BREAKEVEN' : 'STOP', contract);
      return;
    }
    if (openGapTarget) {
      closePosition(position, candle.open, timestamp, 'TARGET', contract);
      return;
    }
    if (stopTouched) {
      closePosition(position, position.stopPrice, timestamp, position.breakevenMoved ? 'BREAKEVEN' : 'STOP', contract);
      return;
    }
    if (targetTouched) {
      closePosition(position, position.takeProfitPrice, timestamp, 'TARGET', contract);
      return;
    }

    const oneR = position.stopDistance;
    const reachedOneR = long ? candle.high >= position.entryPrice + oneR : candle.low <= position.entryPrice - oneR;
    if (!position.breakevenMoved && reachedOneR) {
      const roundTripCostPerUnit = 2 * (position.takerFeeRate + slippageRate) + spreadRate;
      const breakEvenOffset = position.entryPrice * roundTripCostPerUnit;
      const breakEvenEstimate = position.entryPrice + sign(position.direction) * breakEvenOffset;
      const breakEvenStop = roundPriceToTick(breakEvenEstimate, contract.priceUnit, long ? 'UP' : 'DOWN');
      if ((long && breakEvenStop > position.stopPrice) || (!long && breakEvenStop < position.stopPrice)) {
        position.stopPrice = breakEvenStop;
        position.stopRisk = Math.max(0, estimateStopRiskPerContract(position.direction, position.entryPrice,
          Math.abs(position.entryPrice - breakEvenStop), {
            makerFeeRate: config.risk.estimatedMakerFeeRate,
            takerFeeRate: position.takerFeeRate,
            slippageRate,
            spreadRate,
            contractSize: contract.contractSize,
          }) * position.quantity);
        position.breakevenMoved = true;
      }
    }

    const movedStopTouched = long ? candle.low <= position.stopPrice : candle.high >= position.stopPrice;
    if (position.breakevenMoved && movedStopTouched) {
      closePosition(position, position.stopPrice, timestamp, 'BREAKEVEN', contract);
      return;
    }
    position.barsHeld += 1;
    if (position.barsHeld >= config.strategy.maxHoldingCandles) {
      const nextIndex = (indexes.get(symbol)?.get(candle.openTime) ?? -1) + 1;
      const nextBar = barsBySymbol[symbol]?.[nextIndex];
      if (nextBar) position.pendingExit = { reason: 'TIME', scheduledTime: nextBar.openTime };
    }
  };

  for (const timestamp of timeline) {
    const bucket = eventsAt.get(timestamp)!;
    const currentOpens = new Map(bucket.map(({ symbol, candle }) => [symbol, candle.open]));
    for (const { symbol, candle } of bucket) marks.set(symbol, candle.open);
    if (timestamp < startTime || timestamp >= endTime) {
      for (const { symbol, candle } of bucket) marks.set(symbol, candle.close);
      continue;
    }

    // Existing close instructions are market-executed at the next available open.
    for (const { symbol, candle } of bucket) {
      for (const position of [...positions.values()]) {
        if (position.symbol === symbol && position.pendingExit?.scheduledTime === timestamp) {
          const reason = position.pendingExit.reason;
          closePosition(position, candle.open, timestamp, reason, contracts.get(symbol)!);
        }
      }
    }
    observeEquity(timestamp, currentOpens);

    // Pending entries reserve both a symbol and risk while waiting for the next bar.
    for (const { symbol, index, candle } of bucket) {
      const pending = pendingEntries.get(symbol);
      if (!pending || pending.scheduledIndex !== index) continue;
      pendingEntries.delete(symbol);
      if (dailyState?.locked || dailyState?.consecutiveLossLocked || positions.size >= config.risk.maxOpenPositions) continue;
      orderAttempts += 1;
      if (outageEveryNOrders > 0 && orderAttempts % outageEveryNOrders === 0) continue;
      const contract = contracts.get(symbol)!;
      const fillReference = executionReferenceWithGap(candle.open, pending.signal.direction, true, gapShockRate);
      const entryFill = fillReference * (1 + sign(pending.signal.direction) * (slippageRate + spreadRate / 2));
      const executableSignal = { ...pending.signal, close: entryFill };
      const equity = equityNow(currentOpens);
      const account: RiskAccountSnapshot = {
        equity,
        availableMargin: Math.max(0, equity - marginUsed()),
        startingEquity: initialEquity,
        dailyStartingEquity: dailyState?.startingEquity ?? initialEquity,
        realizedPnl: cash - initialEquity,
        unrealizedPnl: markedGross(currentOpens),
        dailyDrawdown: dailyState?.drawdown ?? 0,
        dailyLocked: dailyState?.locked ?? false,
        consecutiveLossLocked: dailyState?.consecutiveLossLocked ?? false,
        reconciliationHealthy: true,
      };
      const risk = assessPositionRisk({
        signal: executableSignal,
        contract,
        account,
        positions: currentPositionRisks(currentOpens),
        pendingEntries: pendingReservations(pending.id),
        config: { ...config.risk, estimatedTakerFeeRate: config.risk.estimatedTakerFeeRate * feeMultiplier,
          estimatedMakerFeeRate: config.risk.estimatedMakerFeeRate * feeMultiplier,
          estimatedSlippageRate: slippageRate },
        context: { spreadRate, compoundingEnabled: config.risk.compoundingEnabled },
      });
      if (!risk.accepted) {
        if (risk.reason === 'MARGIN_LIMIT') marginLimitEvents += 1;
        if (risk.reason === 'LIQUIDATION_SAFETY') liquidationRiskEvents += 1;
        continue;
      }
      const quantity = Math.floor((risk.quantity * fillFraction + contract.volUnit * 1e-10) / contract.volUnit) * contract.volUnit;
      if (quantity < contract.minVol) continue;
      const actualNotional = entryFill * quantity * contract.contractSize;
      const entryFee = actualNotional * contract.takerFeeRate;
      const entrySlippage = candle.open * quantity * contract.contractSize * slippageRate;
      const entrySpread = candle.open * quantity * contract.contractSize * spreadRate / 2;
      const rawStopDistance = pending.signal.atr * config.strategy.stopAtrMultiple;
      const stopPrice = roundPriceToTick(pending.signal.direction === 'LONG' ? entryFill - rawStopDistance : entryFill + rawStopDistance,
        contract.priceUnit, pending.signal.direction === 'LONG' ? 'UP' : 'DOWN');
      const takeProfitPrice = roundPriceToTick(pending.signal.direction === 'LONG'
        ? entryFill + rawStopDistance * config.strategy.takeProfitR
        : entryFill - rawStopDistance * config.strategy.takeProfitR,
      contract.priceUnit, pending.signal.direction === 'LONG' ? 'DOWN' : 'UP');
      if ((pending.signal.direction === 'LONG' && (stopPrice >= entryFill || takeProfitPrice <= entryFill))
        || (pending.signal.direction === 'SHORT' && (stopPrice <= entryFill || takeProfitPrice >= entryFill))) continue;
      const actualStopDistance = Math.abs(entryFill - stopPrice);
      const stopRisk = estimateStopRiskPerContract(pending.signal.direction, entryFill, actualStopDistance, {
        makerFeeRate: contract.makerFeeRate,
        takerFeeRate: contract.takerFeeRate,
        slippageRate,
        spreadRate,
        contractSize: contract.contractSize,
      }) * quantity;
      cash -= entryFee + entrySlippage + entrySpread;
      totalFees += entryFee;
      totalSlippage += entrySlippage + entrySpread;
      const position: SimPosition = {
        id: pending.id,
        symbol,
        direction: pending.signal.direction,
        quantity,
        entryPrice: entryFill,
        entryReferencePrice: candle.open,
        stopPrice,
        takeProfitPrice,
        stopRisk,
        marginUsed: actualNotional / risk.leverage,
        unrealizedPnl: 0,
        openedAt: timestamp,
        barsHeld: 0,
        breakevenMoved: false,
        source: 'PAPER',
        feesPaid: entryFee,
        fundingCashFlow: 0,
        entryFee,
        entrySlippage,
        entrySpread,
        entryRisk: stopRisk,
        stopDistance: actualStopDistance,
        contractSize: contract.contractSize,
        takerFeeRate: contract.takerFeeRate,
        slippageRate,
        spreadRate,
      };
      positions.set(position.id, position);
      maxSimultaneousPositions = Math.max(maxSimultaneousPositions, positions.size);
      maxAggregateRiskPct = Math.max(maxAggregateRiskPct,
        positions.size ? [...positions.values()].reduce((sum, item) => sum + item.stopRisk, 0) / Math.max(equity, 1e-9) * 100 : 0);
    }

    // Complete this minute: settle funding, enforce conservative protective-order fills, then scan signals.
    for (const { symbol, candle } of bucket) {
      marks.set(symbol, candle.close);
      manageCandle(symbol, candle, timestamp + 60_000);
    }
    observeEquity(timestamp + 60_000);

    for (const { symbol, index, candle } of bucket) {
      const bars = barsBySymbol[symbol]!;
      if (index < Math.max(config.indicators.emaSlow, config.indicators.atrLength, config.indicators.kdjLength) - 1) continue;
      const nextIndex = index + 1 + delayBars;
      const nextCandle = bars[nextIndex];
      if (!nextCandle || candle.openTime < startTime || nextCandle.openTime >= endTime) continue;
      const historyWindow = Math.max(60, config.indicators.emaSlow + config.strategy.emaCrossCooldownCandles + 5);
      const startIndex = Math.max(0, index - historyWindow + 1);
      const history = bars.slice(startIndex, index + 1);
      const pointPrefix = indicatorMap.get(symbol)!.slice(startIndex, index + 1);
      const signalNow = candle.openTime + 60_000;
      const market = {
        symbol,
        bid: candle.close * (1 - spreadRate / 2),
        ask: candle.close * (1 + spreadRate / 2),
        spreadRate,
        liquidityUsd: 100_000_000,
        observedAt: signalNow,
        currentPrice: candle.close,
      };
      const decision = evaluateSignal({ symbol, candles: history, indicatorPoints: pointPrefix, market,
        contract: contracts.get(symbol)!, now: signalNow, config });
      const activePosition = [...positions.values()].find((position) => position.symbol === symbol);
      if (activePosition && decision.accepted && decision.signal && decision.signal.direction !== activePosition.direction) {
        activePosition.pendingExit = { reason: 'OPPOSITE_SIGNAL', scheduledTime: nextCandle.openTime };
      }
      if (!decision.accepted) {
        if (decision.candidate) rejectedSignals += 1;
        continue;
      }
      if (!decision.signal || activePosition || pendingEntries.has(symbol) || dailyState?.locked) continue;

      const signal = decision.signal;
      const equity = equityNow();
      const account: RiskAccountSnapshot = {
        equity,
        availableMargin: Math.max(0, equity - marginUsed()),
        startingEquity: initialEquity,
        dailyStartingEquity: dailyState?.startingEquity ?? initialEquity,
        realizedPnl: cash - initialEquity,
        unrealizedPnl: markedGross(),
        dailyDrawdown: dailyState?.drawdown ?? 0,
        dailyLocked: dailyState?.locked ?? false,
        consecutiveLossLocked: dailyState?.consecutiveLossLocked ?? false,
        reconciliationHealthy: true,
      };
      const risk = assessPositionRisk({
        signal,
        contract: contracts.get(symbol)!,
        account,
        positions: currentPositionRisks(),
        pendingEntries: pendingReservations(),
        config: { ...config.risk, estimatedTakerFeeRate: config.risk.estimatedTakerFeeRate * feeMultiplier,
          estimatedMakerFeeRate: config.risk.estimatedMakerFeeRate * feeMultiplier,
          estimatedSlippageRate: slippageRate },
        context: { spreadRate, compoundingEnabled: config.risk.compoundingEnabled },
      });
      if (!risk.accepted) {
        if (risk.reason === 'MARGIN_LIMIT') marginLimitEvents += 1;
        if (risk.reason === 'LIQUIDATION_SAFETY') liquidationRiskEvents += 1;
        continue;
      }
      if (positions.size + pendingEntries.size >= config.risk.maxOpenPositions) continue;
      const id = `bt-${symbol}-${signal.candleTime}-${signal.direction}`;
      const reservation: PendingSimEntry = {
        id,
        signal,
        scheduledIndex: nextIndex,
        scheduledTime: nextCandle.openTime,
        risk: risk.estimatedRisk,
        margin: risk.marginRequired,
      };
      pendingEntries.set(symbol, reservation);
      maxAggregateRiskPct = Math.max(maxAggregateRiskPct,
        (risk.aggregateRiskAfter / Math.max(equity, 1e-9)) * 100);
    }

    const equity = equityNow();
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) maxDrawdownPct = Math.max(maxDrawdownPct, Math.max(0, (peakEquity - equity) / peakEquity * 100));
  }

  // Close residual positions at the final available mark rather than pretending they are still liquid.
  const lastTime = timeline.filter((time) => time < endTime).at(-1) ?? 0;
  for (const position of [...positions.values()]) {
    const finalPrice = marks.get(position.symbol) ?? position.entryReferencePrice;
    closePosition(position, finalPrice, lastTime + 60_000, 'EMERGENCY', contracts.get(position.symbol)!);
  }
  const finalEquity = cash;
  const metrics = buildMetrics({
    initialEquity,
    cash: finalEquity,
    trades,
    maxDrawdownPct,
    maxSimultaneousPositions,
    maxAggregateRiskPct,
    dailyLossLockEvents,
    marginLimitEvents,
    liquidationRiskEvents,
    maxConsecutiveLosses,
    fees: totalFees,
    slippage: totalSlippage,
    funding: totalFunding,
  });
  return {
    metrics,
    rejectedSignals,
    dataStart: timeline[0] ?? 0,
    dataEnd: timeline.at(-1) ?? 0,
  };
}

function metricsSummary(metrics: BacktestMetrics): BacktestReport['stressScenarios'][string] {
  return {
    netReturnPct: metrics.netReturnPct,
    maxDrawdownPct: metrics.maxDrawdownPct,
    totalFees: metrics.totalFees,
    maxSimultaneousPositions: metrics.maxSimultaneousPositions,
    dailyLossLockEvents: metrics.dailyLossLockEvents,
    marginLimitEvents: metrics.marginLimitEvents,
  };
}

export function runBacktest(input: BacktestInput): BacktestReport {
  const barsBySymbol = sortedBars(input.barsBySymbol);
  const allTimes = [...new Set(Object.values(barsBySymbol).flatMap((bars) => bars.map((bar) => bar.openTime)))].sort((a, b) => a - b);
  if (allTimes.length < 3) throw new Error('Backtest needs at least three unique completed 1-minute timestamps.');
  const symbols = Object.keys(barsBySymbol).filter((symbol) => barsBySymbol[symbol]!.length > 0).sort();
  const first = allTimes[0]!;
  const oneThird = Math.max(1, Math.floor(allTimes.length * 0.6));
  const twoThird = Math.max(oneThird + 1, Math.floor(allTimes.length * 0.8));
  const validationStart = allTimes[Math.min(oneThird, allTimes.length - 1)]!;
  const outOfSampleStart = allTimes[Math.min(twoThird, allTimes.length - 1)]!;
  const endExclusive = allTimes.at(-1)! + 60_000;
  const development = runSegment(input, first, validationStart);
  const validation = runSegment(input, validationStart, outOfSampleStart);
  const outOfSample = runSegment(input, outOfSampleStart, endExclusive);
  const base = runSegment(input, first, endExclusive);
  const defaultSpread = input.assumedSpreadRate ?? 0.0004;
  const stressScenarios: BacktestReport['stressScenarios'] = {
    fees_2x: metricsSummary(runSegment({ ...input, stress: { ...input.stress, feeMultiplier: 2 } }, first, endExclusive).metrics),
    spread_2x: metricsSummary(runSegment({ ...input, stress: { ...input.stress, spreadRate: defaultSpread * 2 } }, first, endExclusive).metrics),
    slippage_3x: metricsSummary(runSegment({ ...input, stress: { ...input.stress, slippageMultiplier: 3 } }, first, endExclusive).metrics),
    gaps_0_5pct: metricsSummary(runSegment({ ...input, stress: { ...input.stress, gapShockRate: 0.005 } }, first, endExclusive).metrics),
    delayed_one_bar: metricsSummary(runSegment({ ...input, stress: { ...input.stress, executionDelayBars: 1 } }, first, endExclusive).metrics),
    half_fills: metricsSummary(runSegment({ ...input, stress: { ...input.stress, partialFillFraction: 0.5 } }, first, endExclusive).metrics),
    api_outage_every_3rd_order: metricsSummary(runSegment({ ...input, stress: { ...input.stress, outageEveryNOrders: 3 } }, first, endExclusive).metrics),
  };
  const warnings = [
    'Historical OHLCV does not contain queue position, actual spread/depth, private account fees, liquidation marks, or exact fills; configured assumptions are modeled.',
    'Out-of-sample is chronological and uses the unchanged strategy/configuration; no profitability or production readiness is implied.',
    'Conservative bar rule: if stop and target are both touched in one candle, the stop is assumed first; exits execute on the next available market opportunity.',
    `Assumed backtest spread is ${(defaultSpread * 10_000).toFixed(2)} basis points full-width; replace with exchange depth snapshots for stronger evidence.`,
  ];
  const candleCount = Object.values(barsBySymbol).reduce((sum, bars) => sum + bars.length, 0);
  return {
    generatedAt: Date.now(),
    configVersion: 'kdj-9-3-3_ema-9-21_atr-14_v1',
    dataStart: first,
    dataEnd: allTimes.at(-1)!,
    candleCount,
    symbols,
    splits: { development: development.metrics, validation: validation.metrics, outOfSample: outOfSample.metrics },
    stressScenarios,
    warnings: [...warnings, `Full-period summary: ${base.metrics.trades.length} completed trades, ${base.rejectedSignals} candidate signals rejected by configured gates.`],
  };
}

export function chronologicalSplitRanges(timestamps: number[]): { development: [number, number]; validation: [number, number]; outOfSample: [number, number] } {
  const sorted = [...new Set(timestamps)].sort((a, b) => a - b);
  if (sorted.length < 3) throw new Error('Need at least three timestamps for a chronological split.');
  const split60 = Math.max(1, Math.floor(sorted.length * 0.6));
  const split80 = Math.max(split60 + 1, Math.floor(sorted.length * 0.8));
  return {
    development: [sorted[0]!, sorted[Math.min(split60, sorted.length - 1)]!],
    validation: [sorted[Math.min(split60, sorted.length - 1)]!, sorted[Math.min(split80, sorted.length - 1)]!],
    outOfSample: [sorted[Math.min(split80, sorted.length - 1)]!, sorted.at(-1)! + 60_000],
  };
}
