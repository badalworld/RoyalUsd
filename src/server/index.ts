import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../core/config.js';
import { runBacktest } from '../core/backtest.js';
import type { BacktestInput } from '../core/backtest.js';
import type { BacktestReport, Candle, ContractSpec } from '../core/types.js';
import { MexcFuturesAdapter } from '../exchange/mexc.js';
import { TradingRuntime } from './runtime.js';
import { createStore } from './store.js';

const config = loadConfig();
if (config.nodeEnv === 'production' && !config.live.dashboardTokenConfigured) {
  throw new Error('DASHBOARD_API_TOKEN must be configured before starting in production.');
}
const store = await createStore({ databaseUrl: config.databaseUrl, sqlitePath: config.sqlitePath });
const exchange = new MexcFuturesAdapter({
  baseUrl: config.mexcRestUrl,
  apiKey: process.env.MEXC_API_KEY?.trim(),
  apiSecret: process.env.MEXC_API_SECRET?.trim(),
});
const runtime = new TradingRuntime(config, store, exchange);
await runtime.initialize();

const app = express();
app.disable('x-powered-by');
app.use((_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '8mb', strict: true }));

const controlAttempts = new Map<string, { count: number; resetAt: number }>();
function rateLimit(request: Request, response: Response, next: NextFunction): void {
  const key = request.ip ?? request.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const existing = controlAttempts.get(key);
  if (!existing || now >= existing.resetAt) controlAttempts.set(key, { count: 1, resetAt: now + 60_000 });
  else existing.count += 1;
  if ((controlAttempts.get(key)?.count ?? 0) > 40) {
    response.status(429).json({ error: 'Too many operator requests. Wait before retrying.' });
    return;
  }
  next();
}

function authorized(request: Request): boolean {
  const token = process.env.DASHBOARD_API_TOKEN?.trim();
  if (!token) return config.nodeEnv !== 'production';
  const supplied = request.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function requireAuth(request: Request, response: Response, next: NextFunction): void {
  if (!authorized(request)) {
    response.status(401).json({ error: 'Operator authentication required.' });
    return;
  }
  next();
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    Promise.resolve(handler(request, response)).catch(next);
  };
}

function requireObjectBody(request: Request): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new Error('Request body must be a JSON object.');
  return request.body as Record<string, unknown>;
}

function validateBacktestBody(body: Record<string, unknown>): BacktestInput {
  const barsBySymbol = body.barsBySymbol;
  if (!barsBySymbol || typeof barsBySymbol !== 'object' || Array.isArray(barsBySymbol)) throw new Error('barsBySymbol is required.');
  const entries = Object.entries(barsBySymbol as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 30) throw new Error('Backtest accepts between one and thirty symbols.');
  let totalCandles = 0;
  const normalized: Record<string, Candle[]> = {};
  for (const [symbol, value] of entries) {
    if (!/^[A-Z0-9]{2,24}_USDT$/.test(symbol) || !Array.isArray(value)) throw new Error(`Invalid candle list for ${symbol}.`);
    totalCandles += value.length;
    if (totalCandles > 50_000) throw new Error('HTTP backtests are limited to 50,000 candle rows; use the CLI for larger datasets.');
    normalized[symbol] = value.map((raw) => {
      if (!raw || typeof raw !== 'object') throw new Error(`Invalid ${symbol} candle.`);
      const candle = raw as Record<string, unknown>;
      const result: Candle = {
        symbol,
        openTime: Number(candle.openTime),
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume: Number(candle.volume),
        complete: candle.complete === true,
      };
      if (candle.fundingRate !== undefined) result.fundingRate = Number(candle.fundingRate);
      if (![result.openTime, result.open, result.high, result.low, result.close, result.volume].every(Number.isFinite)) {
        throw new Error(`Non-finite candle field for ${symbol}.`);
      }
      return result;
    });
  }
  const rawSpecs = body.contractsBySymbol;
  const contractMap: Record<string, ContractSpec> = {};
  if (rawSpecs && typeof rawSpecs === 'object' && !Array.isArray(rawSpecs)) {
    for (const [symbol, value] of Object.entries(rawSpecs as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') throw new Error(`Invalid contract metadata for ${symbol}.`);
      contractMap[symbol] = value as ContractSpec;
    }
  }
  const equity = body.initialEquity === undefined ? config.risk.paperInitialEquity : Number(body.initialEquity);
  if (!Number.isFinite(equity) || equity <= 0) throw new Error('initialEquity must be a positive number.');
  const assumedSpreadRate = body.assumedSpreadRate === undefined ? 0.0004 : Number(body.assumedSpreadRate);
  if (!Number.isFinite(assumedSpreadRate) || assumedSpreadRate < 0 || assumedSpreadRate > 0.1) throw new Error('assumedSpreadRate is invalid.');
  return {
    barsBySymbol: normalized,
    contractsBySymbol: contractMap,
    config,
    initialEquity: equity,
    assumedSpreadRate,
  };
}

app.get('/api/health', (_request, response) => response.json({
  ok: true,
  service: 'royal-usd-api',
  timestamp: Date.now(),
}));

app.get('/api/dashboard', requireAuth, asyncRoute(async (_request, response) => {
  response.json(await runtime.dashboard());
}));

app.get('/api/events', requireAuth, asyncRoute(async (request, response) => {
  const limit = Math.min(500, Math.max(1, Number(request.query.limit ?? 100) || 100));
  const type = typeof request.query.type === 'string' ? request.query.type : undefined;
  const symbol = typeof request.query.symbol === 'string' ? request.query.symbol : undefined;
  response.json(await store.listEvents({ limit, type, symbol }));
}));

app.post('/api/paper/start', requireAuth, rateLimit, asyncRoute(async (_request, response) => {
  await runtime.startPaper();
  response.json(await runtime.dashboard());
}));
app.post('/api/control/pause', requireAuth, rateLimit, asyncRoute(async (_request, response) => {
  await runtime.pauseNewEntries();
  response.json(await runtime.dashboard());
}));
app.post('/api/control/resume', requireAuth, rateLimit, asyncRoute(async (_request, response) => {
  await runtime.resumeNewEntries();
  response.json(await runtime.dashboard());
}));
app.post('/api/control/stop', requireAuth, rateLimit, asyncRoute(async (_request, response) => {
  await runtime.stop();
  response.json(await runtime.dashboard());
}));
app.post('/api/control/live/enable', requireAuth, rateLimit, asyncRoute(async (request, response) => {
  const body = requireObjectBody(request);
  await runtime.enableLive(String(body.confirmation ?? ''));
  response.json(await runtime.dashboard());
}));
app.post('/api/control/emergency-close', requireAuth, rateLimit, asyncRoute(async (request, response) => {
  const body = requireObjectBody(request);
  await runtime.emergencyCloseAll(String(body.confirmation ?? ''));
  response.json(await runtime.dashboard());
}));
app.post('/api/control/cancel-pending', requireAuth, rateLimit, asyncRoute(async (_request, response) => {
  await runtime.cancelPendingEntries();
  response.json(await runtime.dashboard());
}));
app.post('/api/control/compounding', requireAuth, rateLimit, asyncRoute(async (request, response) => {
  const body = requireObjectBody(request);
  if (typeof body.enabled !== 'boolean') throw new Error('enabled must be true or false.');
  await runtime.setCompounding(body.enabled);
  response.json(await runtime.dashboard());
}));
app.post('/api/control/risk/reset', requireAuth, rateLimit, asyncRoute(async (request, response) => {
  const body = requireObjectBody(request);
  await runtime.resetRiskLock(String(body.confirmation ?? ''));
  response.json(await runtime.dashboard());
}));

app.post('/api/backtest', requireAuth, rateLimit, asyncRoute(async (request, response) => {
  const body = requireObjectBody(request);
  const input = validateBacktestBody(body);
  const report: BacktestReport = runBacktest(input);
  await store.appendEvent({ type: 'backtest.completed', occurredAt: Date.now(), payload: {
    configVersion: report.configVersion,
    symbols: report.symbols,
    candleCount: report.candleCount,
    outOfSample: {
      initialEquity: report.splits.outOfSample.initialEquity,
      finalEquity: report.splits.outOfSample.finalEquity,
      netReturnPct: report.splits.outOfSample.netReturnPct,
      maxDrawdownPct: report.splits.outOfSample.maxDrawdownPct,
      tradeCount: report.splits.outOfSample.trades.length,
    },
  } });
  response.json(report);
}));

app.use('/api', (_request, response) => response.status(404).json({ error: 'Unknown API route.' }));

if (existsSync(resolve('dist'))) {
  app.use(express.static(resolve('dist'), { index: false, maxAge: config.nodeEnv === 'production' ? '1h' : 0 }));
  app.get(/.*/, (request, response, next) => {
    if (request.path.startsWith('/api/')) return next();
    response.sendFile(resolve('dist/index.html'));
  });
}

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : 'Unexpected server error.';
  void store.appendEvent({ type: 'system.error', occurredAt: Date.now(), payload: { component: 'http-api', message: message.slice(0, 300) } }).catch(() => undefined);
  response.status(400).json({ error: message.slice(0, 300) });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`Royal USD API listening on http://${config.host}:${config.port} (${config.nodeEnv})`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; safely stopping new entries and market feeds.`);
  server.close();
  await runtime.shutdown();
  await store.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
