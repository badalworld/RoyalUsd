import type { Direction, PositionRisk } from './types.js';

export interface CostRates {
  makerFeeRate: number;
  takerFeeRate: number;
  slippageRate: number;
  spreadRate: number;
  contractSize: number;
}

export interface TradeCostBreakdown {
  grossPnl: number;
  entryFee: number;
  exitFee: number;
  slippageCost: number;
  spreadCost: number;
  fundingCashFlow: number;
  netPnl: number;
}

/** Round a protective price to an exchange tick without widening the initial stop. */
export function roundPriceToTick(price: number, tick: number, mode: 'UP' | 'DOWN'): number {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tick) || tick <= 0) {
    throw new TypeError('Price and tick must be finite positive numbers');
  }
  const scaled = price / tick;
  const units = mode === 'UP' ? Math.ceil(scaled - 1e-10) : Math.floor(scaled + 1e-10);
  const source = tick.toString().toLowerCase();
  const [coefficient = source, exponentText] = source.split('e');
  const decimalPlaces = coefficient.includes('.') ? coefficient.length - coefficient.indexOf('.') - 1 : 0;
  const exponent = exponentText ? Number(exponentText) : 0;
  const precision = Math.max(0, Math.min(12, decimalPlaces - exponent));
  const result = Number((units * tick).toFixed(precision));
  if (!Number.isFinite(result) || result <= 0) throw new TypeError('Tick-rounded protective price is invalid');
  return result;
}

export function estimateRoundTripCosts(
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  rates: CostRates,
  feeKind: 'MAKER' | 'TAKER' = 'TAKER',
): Omit<TradeCostBreakdown, 'grossPnl' | 'fundingCashFlow' | 'netPnl'> {
  const feeRate = feeKind === 'MAKER' ? rates.makerFeeRate : rates.takerFeeRate;
  const entryNotional = entryPrice * quantity * rates.contractSize;
  const exitNotional = exitPrice * quantity * rates.contractSize;
  const entryFee = entryNotional * feeRate;
  const exitFee = exitNotional * feeRate;
  const slippageCost = (entryNotional + exitNotional) * rates.slippageRate;
  // spreadRate is the full bid/ask width; a market order crosses roughly half on each side.
  const spreadCost = (entryNotional + exitNotional) * rates.spreadRate / 2;
  return { entryFee, exitFee, slippageCost, spreadCost };
}

export function estimateStopRiskPerContract(
  direction: Direction,
  entryPrice: number,
  stopDistance: number,
  rates: CostRates,
  feeKind: 'MAKER' | 'TAKER' = 'TAKER',
): number {
  const stopPrice = direction === 'LONG' ? entryPrice - stopDistance : entryPrice + stopDistance;
  if (stopPrice <= 0 || stopDistance <= 0 || rates.contractSize <= 0) return Number.POSITIVE_INFINITY;
  const grossLoss = stopDistance * rates.contractSize;
  const costs = estimateRoundTripCosts(entryPrice, stopPrice, 1, rates, feeKind);
  return grossLoss + costs.entryFee + costs.exitFee + costs.slippageCost + costs.spreadCost;
}

export function estimateTargetNetRewardPerContract(
  direction: Direction,
  entryPrice: number,
  targetDistance: number,
  rates: CostRates,
  feeKind: 'MAKER' | 'TAKER' = 'TAKER',
): number {
  const targetPrice = direction === 'LONG' ? entryPrice + targetDistance : entryPrice - targetDistance;
  if (targetPrice <= 0 || targetDistance <= 0 || rates.contractSize <= 0) return Number.NEGATIVE_INFINITY;
  const grossReward = targetDistance * rates.contractSize;
  const costs = estimateRoundTripCosts(entryPrice, targetPrice, 1, rates, feeKind);
  return grossReward - costs.entryFee - costs.exitFee - costs.slippageCost - costs.spreadCost;
}

export function calculateTradePnl(input: {
  direction: Direction;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  contractSize: number;
  entryFee: number;
  exitFee: number;
  slippageCost: number;
  spreadCost: number;
  fundingCashFlow: number;
}): TradeCostBreakdown {
  const sign = input.direction === 'LONG' ? 1 : -1;
  const grossPnl = sign * (input.exitPrice - input.entryPrice) * input.quantity * input.contractSize;
  const netPnl = grossPnl - input.entryFee - input.exitFee - input.slippageCost - input.spreadCost + input.fundingCashFlow;
  return { ...input, grossPnl, netPnl };
}

export function costAwareBreakevenStop(input: {
  direction: Direction;
  entryPrice: number;
  quantity: number;
  rates: CostRates;
}): number {
  const sign = input.direction === 'LONG' ? 1 : -1;
  const entryNotional = input.entryPrice * input.quantity * input.rates.contractSize;
  // Approximate the exit-side price-dependent cost at entry notional; the stop is never widened.
  const roundTripRate = 2 * (input.rates.takerFeeRate + input.rates.slippageRate) + input.rates.spreadRate;
  const costPerUnit = entryNotional * roundTripRate / (input.quantity * input.rates.contractSize);
  return input.entryPrice + sign * costPerUnit;
}

export function calculateUnrealizedPnl(position: PositionRisk, markPrice: number, contractSize: number): number {
  const sign = position.direction === 'LONG' ? 1 : -1;
  const gross = sign * (markPrice - position.entryPrice) * position.quantity * contractSize;
  const markNotional = markPrice * position.quantity * contractSize;
  const estimatedExitFee = markNotional * 0.0008;
  return gross - estimatedExitFee + position.fundingCashFlow;
}

export function fundingCashFlow(direction: Direction, fundingRate: number, notional: number): number {
  // Positive funding: longs pay shorts. A positive return value is cash received.
  const sideSign = direction === 'LONG' ? 1 : -1;
  return -sideSign * fundingRate * notional;
}
