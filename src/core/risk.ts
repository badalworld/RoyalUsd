import type {
  ContractSpec,
  PendingEntry,
  PositionRisk,
  RejectReason,
  RiskAccountSnapshot,
  RiskAssessment,
  StrategySignal,
} from './types.js';
import type { RiskConfig } from './config.js';
import { estimateStopRiskPerContract, roundPriceToTick } from './accounting.js';

export interface RiskCheckContext {
  spreadRate: number;
  compoundingEnabled: boolean;
  accountFeeRates?: { makerFeeRate: number; takerFeeRate: number };
  perSymbolRiskLimit?: number;
}

function rejected(reason: RejectReason, details: string): RiskAssessment {
  return {
    accepted: false,
    reason,
    details,
    quantity: 0,
    estimatedRisk: 0,
    riskBudget: 0,
    aggregateRiskAfter: 0,
    marginRequired: 0,
    leverage: 0,
    stopPrice: 0,
    takeProfitPrice: 0,
    estimatedFees: 0,
    estimatedSlippage: 0,
    liquidationDistancePct: 0,
  };
}

function floorToStep(value: number, step: number): number {
  const precision = Math.max(0, Math.min(12, (step.toString().split('.')[1] ?? '').length));
  const units = Math.floor((value + step * 1e-10) / step);
  return Number((units * step).toFixed(precision));
}

function riskOfOpenPositions(positions: PositionRisk[]): number {
  return positions.reduce((sum, position) => sum + Math.max(0, position.stopRisk), 0);
}

/**
 * Sizing uses authoritative, reconciled equity and reserves aggregate risk before order submission.
 * Quantity is in MEXC contracts; contractSize converts one contract into base-asset exposure.
 */
export function assessPositionRisk(input: {
  signal: StrategySignal;
  contract: ContractSpec;
  account: RiskAccountSnapshot;
  positions: PositionRisk[];
  pendingEntries: PendingEntry[];
  config: RiskConfig;
  context: RiskCheckContext;
}): RiskAssessment {
  const { signal, contract, account, positions, pendingEntries, config, context } = input;
  const validAccount = [account.equity, account.availableMargin, account.startingEquity,
    account.dailyStartingEquity, account.dailyDrawdown].every(Number.isFinite)
    && account.equity > 0
    && account.availableMargin >= 0
    && account.startingEquity > 0
    && account.dailyStartingEquity > 0
    && account.dailyDrawdown >= 0;
  if (!validAccount) return rejected('INVALID_ACCOUNT_SNAPSHOT', 'Risk sizing requires a fresh, positive, reconciled equity and margin snapshot.');
  if (!account.reconciliationHealthy) return rejected('EXCHANGE_RECONCILIATION_REQUIRED', 'Exchange positions, open orders, or protective orders are not reconciled.');
  if (account.dailyLocked || account.dailyDrawdown >= account.dailyStartingEquity * config.dailyMaxLoss) {
    return rejected('DAILY_RISK_LOCK', 'Persistent daily loss lock is active. Existing positions must remain protected.');
  }
  if (account.consecutiveLossLocked) return rejected('CONSECUTIVE_LOSS_LOCK', 'Configured consecutive-loss lock is active.');
  if (positions.length + pendingEntries.length >= config.maxOpenPositions) {
    return rejected('POSITION_LIMIT', `Hard maximum of ${config.maxOpenPositions} positions includes pending entries.`);
  }
  if (positions.some((position) => position.symbol === signal.symbol)
    || pendingEntries.some((entry) => entry.symbol === signal.symbol)) {
    return rejected('DUPLICATE_OR_CONFLICTING_POSITION', 'An open position or pending entry already exists for this contract.');
  }
  if (positions.some((position) => !Number.isFinite(position.stopRisk) || position.stopRisk < 0)) {
    return rejected('EXCHANGE_RECONCILIATION_REQUIRED', 'An existing position has unknown stop risk; no new risk may be allocated.');
  }
  if (contract.state !== 0 || contract.futureType !== 1 || !contract.apiAllowed || contract.quoteCoin !== 'USDT' || contract.settleCoin !== 'USDT') {
    return rejected('CONTRACT_DISABLED', 'Only enabled, API-allowed USDT-margined perpetuals may be sized.');
  }
  if (!(contract.contractSize > 0) || !(contract.volUnit > 0) || !(contract.minVol > 0)
    || !(contract.maxVol >= contract.minVol) || !(contract.priceUnit > 0)) {
    return rejected('CONTRACT_DISABLED', 'Exchange contract precision, contract size, or quantity bounds are invalid.');
  }

  const entryPrice = signal.close;
  if (![entryPrice, signal.atr, signal.stopDistance, signal.targetDistance, contract.priceUnit].every(Number.isFinite)
    || !(entryPrice > 0) || !(signal.atr > 0) || !(signal.stopDistance > 0) || !(signal.targetDistance > 0)) {
    return rejected('INVALID_ATR', 'Signal prices and stop distance must be finite and positive.');
  }
  let stopPrice: number;
  let takeProfitPrice: number;
  try {
    stopPrice = roundPriceToTick(signal.direction === 'LONG' ? entryPrice - signal.stopDistance : entryPrice + signal.stopDistance,
      contract.priceUnit, signal.direction === 'LONG' ? 'UP' : 'DOWN');
    takeProfitPrice = roundPriceToTick(signal.direction === 'LONG' ? entryPrice + signal.targetDistance : entryPrice - signal.targetDistance,
      contract.priceUnit, signal.direction === 'LONG' ? 'DOWN' : 'UP');
  } catch {
    return rejected('INVALID_ATR', 'Protective prices cannot be represented at the contract tick size.');
  }
  const roundedStopDistance = Math.abs(entryPrice - stopPrice);
  if (!(roundedStopDistance > 0)
    || (signal.direction === 'LONG' && (stopPrice >= entryPrice || takeProfitPrice <= entryPrice))
    || (signal.direction === 'SHORT' && (stopPrice <= entryPrice || takeProfitPrice >= entryPrice))) {
    return rejected('INVALID_ATR', 'Tick-rounded stop and target must remain on the protective side of the entry.');
  }
  const leverage = Math.min(config.maxLeverage, contract.maxLeverage);
  if (leverage < Math.max(1, contract.minLeverage)) return rejected('MARGIN_LIMIT', 'Configured leverage is outside the contract leverage range.');

  const maintenanceRate = Math.max(0, contract.maintenanceMarginRate);
  const liquidationDistancePct = 1 / leverage - maintenanceRate;
  const stopDistancePct = signal.stopDistance / entryPrice;
  if (!(liquidationDistancePct > 0)
    || stopDistancePct >= liquidationDistancePct * config.minLiquidationBufferFraction) {
    return {
      ...rejected('LIQUIDATION_SAFETY', 'Stop distance is too close to a conservative estimated liquidation boundary.'),
      liquidationDistancePct,
    };
  }

  const aggregateRisk = riskOfOpenPositions(positions) + pendingEntries.reduce((sum, entry) => sum + Math.max(0, entry.risk), 0);
  const aggregateAllowance = account.equity * config.aggregatePortfolioRiskLimit - aggregateRisk;
  if (!(aggregateAllowance > 0)) {
    return {
      ...rejected('AGGREGATE_RISK_LIMIT', 'No aggregate stop-risk allowance remains.'),
      aggregateRiskAfter: aggregateRisk,
    };
  }

  const dailyAllowance = account.dailyStartingEquity * config.dailyMaxLoss - account.dailyDrawdown;
  if (!(dailyAllowance > 0)) return rejected('DAILY_RISK_LOCK', 'No daily loss allowance remains.');
  const baseEquity = context.compoundingEnabled ? account.equity : account.startingEquity;
  const nominalRiskBudget = baseEquity * config.riskPerTrade;
  const symbolAllowance = context.perSymbolRiskLimit === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, account.equity * context.perSymbolRiskLimit);
  const permittedRisk = Math.min(nominalRiskBudget, aggregateAllowance, dailyAllowance, symbolAllowance);
  if (!(permittedRisk > 0)) {
    const reason: RejectReason = aggregateAllowance <= 0 ? 'AGGREGATE_RISK_LIMIT'
      : symbolAllowance <= 0 ? 'SYMBOL_RISK_LIMIT' : 'INDIVIDUAL_RISK_LIMIT';
    return rejected(reason, 'Individual, aggregate, symbol, or daily risk allowance is exhausted.');
  }

  const feeRate = Math.max(contract.takerFeeRate, context.accountFeeRates?.takerFeeRate ?? 0, config.estimatedTakerFeeRate);
  const makerRate = Math.max(contract.makerFeeRate, context.accountFeeRates?.makerFeeRate ?? 0, config.estimatedMakerFeeRate);
  const rates = {
    makerFeeRate: makerRate,
    takerFeeRate: feeRate,
    slippageRate: config.estimatedSlippageRate,
    spreadRate: context.spreadRate,
    contractSize: contract.contractSize,
  };
  const riskPerContract = estimateStopRiskPerContract(signal.direction, entryPrice, roundedStopDistance, rates);
  if (!Number.isFinite(riskPerContract) || riskPerContract <= 0) return rejected('INVALID_ATR', 'Per-contract stop risk cannot be calculated.');

  const maxRiskQuantity = permittedRisk / riskPerContract;
  const maxNotional = account.availableMargin * config.maxMarginUtilization * leverage;
  const notionalPerContract = entryPrice * contract.contractSize;
  const maxMarginQuantity = maxNotional / notionalPerContract;
  const rawQuantity = Math.min(maxRiskQuantity, maxMarginQuantity, contract.maxVol);
  const quantity = floorToStep(rawQuantity, contract.volUnit);
  if (!Number.isFinite(quantity) || quantity < contract.minVol) {
    const marginCanFitMinimum = maxMarginQuantity >= contract.minVol;
    return rejected(marginCanFitMinimum ? 'MINIMUM_SIZE' : 'MARGIN_LIMIT', marginCanFitMinimum
      ? 'Risk-sized quantity is below the exchange minimum after precision rounding.'
      : 'Available isolated margin cannot safely support the exchange minimum quantity.');
  }

  const estimatedRisk = quantity * riskPerContract;
  const marginRequired = quantity * notionalPerContract / leverage;
  const estimatedFees = (entryPrice + stopPrice) * quantity * contract.contractSize * feeRate;
  const estimatedSlippage = (entryPrice + stopPrice) * quantity * contract.contractSize * config.estimatedSlippageRate;
  if (marginRequired > account.availableMargin * config.maxMarginUtilization + 1e-8) {
    return rejected('MARGIN_LIMIT', 'Rounded order size exceeds the configured margin utilization cap.');
  }
  if (estimatedRisk > permittedRisk + 1e-7) {
    return rejected('INDIVIDUAL_RISK_LIMIT', 'Rounded order size would exceed the risk allocation.');
  }

  return {
    accepted: true,
    quantity,
    estimatedRisk,
    riskBudget: permittedRisk,
    aggregateRiskAfter: aggregateRisk + estimatedRisk,
    marginRequired,
    leverage,
    stopPrice,
    takeProfitPrice,
    estimatedFees,
    estimatedSlippage,
    liquidationDistancePct,
  };
}

export function sumAggregateRisk(positions: PositionRisk[], pending: PendingEntry[]): number {
  return riskOfOpenPositions(positions) + pending.reduce((sum, entry) => sum + Math.max(0, entry.risk), 0);
}
