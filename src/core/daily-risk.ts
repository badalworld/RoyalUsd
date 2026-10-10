export interface DailyRiskState {
  calendarDate: string;
  startingEquity: number;
  currentEquity: number;
  drawdown: number;
  locked: boolean;
  lockReason?: string;
  lockedAt?: number;
  consecutiveLosses: number;
  consecutiveLossLocked: boolean;
}

export function accountDate(timestamp: number, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(timestamp);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    throw new Error(`Invalid account timezone: ${timezone}`);
  }
}

export function createDailyRiskState(equity: number, timestamp: number, timezone: string): DailyRiskState {
  if (!(equity > 0) || !Number.isFinite(equity)) throw new Error('Cannot initialize daily risk with invalid equity');
  return {
    calendarDate: accountDate(timestamp, timezone),
    startingEquity: equity,
    currentEquity: equity,
    drawdown: 0,
    locked: false,
    consecutiveLosses: 0,
    consecutiveLossLocked: false,
  };
}

/**
 * Daily lock is latched across calendar resets. A new date establishes a fresh equity
 * baseline, but does not silently unlock a prior lock; an authenticated operator reset is required.
 */
export function updateDailyRiskState(input: {
  state?: DailyRiskState;
  equity: number;
  timestamp: number;
  timezone: string;
  maxDailyLoss: number;
  maxConsecutiveLosses: number;
}): { state: DailyRiskState; newlyLocked: boolean } {
  const { equity, timestamp, timezone, maxDailyLoss, maxConsecutiveLosses } = input;
  if (!(equity > 0) || !Number.isFinite(equity)) throw new Error('Daily risk update requires a valid equity snapshot');
  const today = accountDate(timestamp, timezone);
  const previous = input.state;
  const dateChanged = !previous || previous.calendarDate !== today;
  const state: DailyRiskState = dateChanged
    ? {
        calendarDate: today,
        startingEquity: equity,
        currentEquity: equity,
        drawdown: 0,
        locked: previous?.locked ?? false,
        lockReason: previous?.lockReason,
        lockedAt: previous?.lockedAt,
        consecutiveLosses: previous?.consecutiveLosses ?? 0,
        consecutiveLossLocked: previous?.consecutiveLossLocked ?? false,
      }
    : { ...previous };
  const previousLock = state.locked;
  state.currentEquity = equity;
  state.drawdown = Math.max(0, state.startingEquity - equity);
  if (!state.locked && state.drawdown >= state.startingEquity * maxDailyLoss) {
    state.locked = true;
    state.lockReason = 'DAILY_MAX_LOSS';
    state.lockedAt = timestamp;
  }
  if (!state.consecutiveLossLocked && state.consecutiveLosses >= maxConsecutiveLosses) {
    state.consecutiveLossLocked = true;
    state.lockReason = 'MAX_CONSECUTIVE_LOSSES';
    state.lockedAt = timestamp;
  }
  return { state, newlyLocked: !previousLock && state.locked };
}

export function recordClosedTrade(state: DailyRiskState, netPnl: number, maxConsecutiveLosses: number, timestamp: number): {
  state: DailyRiskState;
  newlyLocked: boolean;
} {
  if (!Number.isFinite(netPnl)) throw new Error('Cannot update loss streak with invalid PnL');
  const next = { ...state };
  const wasLocked = next.consecutiveLossLocked;
  if (netPnl < 0) next.consecutiveLosses += 1;
  else if (netPnl > 0) next.consecutiveLosses = 0;
  if (!next.consecutiveLossLocked && next.consecutiveLosses >= maxConsecutiveLosses) {
    next.consecutiveLossLocked = true;
    next.locked = true;
    next.lockReason = 'MAX_CONSECUTIVE_LOSSES';
    next.lockedAt = timestamp;
  }
  return { state: next, newlyLocked: !wasLocked && next.consecutiveLossLocked };
}

export function resetDailyRiskState(state: DailyRiskState, currentEquity: number, timestamp: number, timezone: string): DailyRiskState {
  if (!(currentEquity > 0) || !Number.isFinite(currentEquity)) throw new Error('Cannot reset risk lock without a valid current equity');
  return {
    calendarDate: accountDate(timestamp, timezone),
    startingEquity: currentEquity,
    currentEquity,
    drawdown: 0,
    locked: false,
    consecutiveLosses: 0,
    consecutiveLossLocked: false,
  };
}
