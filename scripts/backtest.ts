import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runBacktest } from '../src/core/backtest.js';
import type { Candle, ContractSpec } from '../src/core/types.js';
import { loadConfig } from '../src/core/config.js';
import { MexcFuturesAdapter } from '../src/exchange/mexc.js';

const MINUTE = 60_000;
const CHUNK_MINUTES = 1_990;

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1];
}
function has(name: string): boolean { return process.argv.includes(name); }
function parseSymbolList(value: string): string[] {
  const symbols = value.split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length || symbols.some((symbol) => !/^[A-Z0-9]{2,24}_USDT$/.test(symbol))) throw new Error('Provide valid comma-separated symbols, e.g. BTC_USDT,ETH_USDT.');
  return [...new Set(symbols)];
}
function parseTimestamp(value: string): number {
  const number = Number(value);
  if (Number.isFinite(number)) return number < 10_000_000_000 ? number * 1000 : number;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) throw new Error(`Invalid timestamp: ${value}`);
  return date;
}
function csvRows(csv: string): { barsBySymbol: Record<string, Candle[]>; symbols: string[] } {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error('CSV must contain a header and at least one row.');
  const header = lines[0]!.split(',').map((field) => field.trim().toLowerCase());
  const required = ['symbol', 'opentime', 'open', 'high', 'low', 'close', 'volume'];
  for (const name of required) if (!header.includes(name)) throw new Error(`CSV header is missing ${name}.`);
  const index = Object.fromEntries(header.map((field, at) => [field, at]));
  const barsBySymbol: Record<string, Candle[]> = {};
  for (const [lineNumber, line] of lines.slice(1).entries()) {
    const fields = line.split(',').map((field) => field.trim());
    const valueOf = (name: string): string | undefined => index[name] === undefined ? undefined : fields[index[name]!] ?? '';
    const symbol = (valueOf('symbol') ?? '').toUpperCase();
    if (!/^[A-Z0-9]{2,24}_USDT$/.test(symbol)) throw new Error(`Invalid symbol on CSV line ${lineNumber + 2}.`);
    const openTime = parseTimestamp(valueOf('opentime') ?? '');
    const candle: Candle = {
      symbol,
      openTime,
      open: Number(valueOf('open')),
      high: Number(valueOf('high')),
      low: Number(valueOf('low')),
      close: Number(valueOf('close')),
      volume: Number(valueOf('volume')),
      complete: index.complete === undefined ? true : ['1', 'true', 'yes'].includes((valueOf('complete') ?? '').toLowerCase()),
    };
    if (index.fundingrate !== undefined && valueOf('fundingrate') !== '') candle.fundingRate = Number(valueOf('fundingrate'));
    if (![candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) {
      throw new Error(`Non-finite value on CSV line ${lineNumber + 2}.`);
    }
    (barsBySymbol[symbol] ??= []).push(candle);
  }
  for (const bars of Object.values(barsBySymbol)) bars.sort((a, b) => a.openTime - b.openTime);
  return { barsBySymbol, symbols: Object.keys(barsBySymbol).sort() };
}

async function downloadHistory(adapter: MexcFuturesAdapter, symbol: string, start: number, end: number): Promise<Candle[]> {
  const chunkMs = CHUNK_MINUTES * MINUTE;
  const bars = new Map<number, Candle>();
  for (let cursor = start; cursor < end; cursor += chunkMs) {
    const segmentEnd = Math.min(end, cursor + chunkMs - 1);
    const response = await adapter.getCandles(symbol, cursor, segmentEnd, 'Min1');
    for (const candle of response) {
      if (candle.openTime >= start && candle.openTime + MINUTE <= end) bars.set(candle.openTime, { ...candle, complete: true });
    }
    process.stderr.write(`\r${symbol}: fetched through ${new Date(segmentEnd).toISOString()}`);
  }
  process.stderr.write('\n');
  return [...bars.values()].sort((a, b) => a.openTime - b.openTime);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const adapter = new MexcFuturesAdapter({ baseUrl: config.mexcRestUrl,
    apiKey: process.env.MEXC_API_KEY?.trim(), apiSecret: process.env.MEXC_API_SECRET?.trim() });
  let barsBySymbol: Record<string, Candle[]>;
  let symbols: string[];
  let contractsBySymbol: Record<string, ContractSpec> = {};
  let assumptionsWarning: string | undefined;

  if (has('--download')) {
    const downloadedSymbols = parseSymbolList(argument('--symbols', config.symbols.join(','))!);
    const days = Number(argument('--days', '30'));
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('--days must be an integer from 1 to 365.');
    const end = Math.floor(Date.now() / MINUTE) * MINUTE;
    const start = end - days * 24 * 60 * MINUTE;
    barsBySymbol = {};
    symbols = downloadedSymbols;
    const specs = await adapter.getContractSpecs(downloadedSymbols);
    contractsBySymbol = Object.fromEntries(specs.map((spec) => [spec.symbol, spec]));
    for (const symbol of downloadedSymbols) barsBySymbol[symbol] = await downloadHistory(adapter, symbol, start, end);
    const csvPath = resolve(argument('--csv-output', `data/mexc-1m-${days}d.csv`)!);
    await mkdir(dirname(csvPath), { recursive: true });
    const rows = ['symbol,openTime,open,high,low,close,volume,complete,fundingRate'];
    for (const symbol of symbols) for (const candle of barsBySymbol[symbol]!) {
      rows.push([symbol, candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume, 'true', candle.fundingRate ?? ''].join(','));
    }
    await writeFile(csvPath, `${rows.join('\n')}\n`);
    console.log(`Saved ${rows.length - 1} MEXC candle rows to ${csvPath}`);
  } else {
    const inputPath = argument('--input');
    if (!inputPath) throw new Error('Use --input <csv> or --download --symbols BTC_USDT,ETH_USDT --days 30.');
    const parsed = csvRows(await readFile(resolve(inputPath), 'utf8'));
    barsBySymbol = parsed.barsBySymbol;
    symbols = parsed.symbols;
    const contractsFile = argument('--contracts');
    if (contractsFile) contractsBySymbol = JSON.parse(await readFile(resolve(contractsFile), 'utf8')) as Record<string, ContractSpec>;
    else assumptionsWarning = 'No MEXC contract metadata was supplied: the backtest uses an explicitly synthetic 1.0 contract multiplier/precision for symbols without metadata.';
  }

  const equity = Number(argument('--equity', String(config.risk.paperInitialEquity)));
  const spreadBps = Number(argument('--spread-bps', '4'));
  if (!(equity > 0) || !Number.isFinite(equity)) throw new Error('--equity must be positive.');
  if (!(spreadBps >= 0) || !Number.isFinite(spreadBps)) throw new Error('--spread-bps must be non-negative.');
  const report = runBacktest({ barsBySymbol, contractsBySymbol, config, initialEquity: equity, assumedSpreadRate: spreadBps / 10_000 });
  if (assumptionsWarning) report.warnings.unshift(assumptionsWarning);
  const outputPath = resolve(argument('--output', 'reports/latest-backtest.json')!);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  const oos = report.splits.outOfSample;
  console.log(`\nChronological MEXC KDJ backtest: ${symbols.join(', ')}`);
  console.log(`Candles: ${report.candleCount.toLocaleString()} | OOS trades: ${oos.trades.length}`);
  console.log(`Out-of-sample: equity ${oos.initialEquity.toFixed(2)} → ${oos.finalEquity.toFixed(2)} USDT | net ${oos.netReturnPct.toFixed(2)}% | max DD ${oos.maxDrawdownPct.toFixed(2)}% | win ${oos.winRatePct.toFixed(1)}%`);
  console.log(`OOS fees ${oos.totalFees.toFixed(2)} USDT | funding cash flow ${oos.fundingCashFlow.toFixed(2)} USDT | max positions ${oos.maxSimultaneousPositions}`);
  console.log(`Stress scenarios: ${Object.keys(report.stressScenarios).join(', ')}`);
  console.log(`Report: ${outputPath}`);
  for (const warning of report.warnings) console.warn(`WARNING: ${warning}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
