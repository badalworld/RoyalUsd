import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import type { AuditEvent, Candle } from '../core/types.js';

export interface AuditStore {
  appendEvent<T>(event: AuditEvent<T>): Promise<number>;
  listEvents<T = Record<string, unknown>>(options?: { type?: string; symbol?: string; limit?: number }): Promise<Array<AuditEvent<T>>>;
  getState<T>(key: string): Promise<T | undefined>;
  setState<T>(key: string, value: T): Promise<void>;
  upsertCandles(symbol: string, candles: Candle[], timeframe?: string): Promise<void>;
  getCandles(symbol: string, limit: number, timeframe?: string): Promise<Candle[]>;
  close(): Promise<void>;
}

function json<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function serializable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
}

function asEvent<T>(row: Record<string, unknown>, timestampField: string): AuditEvent<T> {
  return {
    id: Number(row.id),
    type: String(row.event_type),
    symbol: row.symbol ? String(row.symbol) : undefined,
    occurredAt: Number(row[timestampField]),
    correlationId: row.correlation_id ? String(row.correlation_id) : undefined,
    payload: typeof row.payload === 'string' ? json<T>(row.payload) : row.payload as T,
  };
}

const SQLITE_SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS runtime_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  symbol TEXT,
  occurred_at_ms INTEGER NOT NULL,
  correlation_id TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_type_time_idx ON audit_events(event_type, occurred_at_ms DESC);
CREATE INDEX IF NOT EXISTS audit_events_symbol_time_idx ON audit_events(symbol, occurred_at_ms DESC);
CREATE TABLE IF NOT EXISTS market_candles (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT '1m',
  open_time_ms INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  is_complete INTEGER NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(symbol, timeframe, open_time_ms)
);
CREATE INDEX IF NOT EXISTS market_candles_symbol_time_idx ON market_candles(symbol, open_time_ms DESC);
CREATE TABLE IF NOT EXISTS strategy_configs (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at_ms INTEGER NOT NULL,
  config TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system'
);
CREATE TABLE IF NOT EXISTS equity_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at_ms INTEGER NOT NULL,
  mode TEXT NOT NULL,
  equity REAL NOT NULL,
  available_margin REAL NOT NULL,
  realized_pnl REAL NOT NULL,
  unrealized_pnl REAL NOT NULL,
  fees REAL NOT NULL,
  funding_cash_flow REAL NOT NULL,
  daily_drawdown REAL NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS equity_snapshots_time_idx ON equity_snapshots(occurred_at_ms DESC);
CREATE TABLE IF NOT EXISTS order_intents (
  client_order_id TEXT PRIMARY KEY,
  exchange_order_id TEXT UNIQUE,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  request TEXT NOT NULL,
  response TEXT
);
`;

export class SqliteAuditStore implements AuditStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    const resolved = path === ':memory:' ? path : resolve(path);
    if (resolved !== ':memory:') mkdirSync(dirname(resolved), { recursive: true });
    this.db = new DatabaseSync(resolved);
    this.db.exec(SQLITE_SCHEMA);
  }

  async appendEvent<T>(event: AuditEvent<T>): Promise<number> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`
        INSERT INTO audit_events(event_type, symbol, occurred_at_ms, correlation_id, payload)
        VALUES (?, ?, ?, ?, ?)
      `).run(event.type, event.symbol ?? null, event.occurredAt, event.correlationId ?? null, serializable(event.payload));
      const id = Number(result.lastInsertRowid);
      if (event.type === 'equity.snapshot') {
        const payload = event.payload as Record<string, unknown>;
        this.db.prepare(`INSERT INTO equity_snapshots(
          occurred_at_ms, mode, equity, available_margin, realized_pnl, unrealized_pnl,
          fees, funding_cash_flow, daily_drawdown, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          event.occurredAt,
          String(payload.mode ?? 'PAPER'),
          Number(payload.equity ?? 0),
          Number(payload.availableMargin ?? 0),
          Number(payload.realizedPnl ?? 0),
          Number(payload.unrealizedPnl ?? 0),
          Number(payload.fees ?? 0),
          Number(payload.fundingCashFlow ?? 0),
          Number(payload.dailyDrawdown ?? 0),
          serializable(payload),
        );
      } else if (event.type === 'order.intent') {
        const payload = event.payload as Record<string, unknown>;
        const clientOrderId = String(payload.clientOrderId ?? '');
        if (clientOrderId) {
          this.db.prepare(`INSERT INTO order_intents(client_order_id, exchange_order_id, symbol, status,
            created_at_ms, updated_at_ms, request, response) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(client_order_id) DO UPDATE SET status=excluded.status,
            exchange_order_id=COALESCE(excluded.exchange_order_id, order_intents.exchange_order_id),
            updated_at_ms=excluded.updated_at_ms, response=COALESCE(excluded.response, order_intents.response)`)
            .run(clientOrderId, payload.exchangeOrderId === undefined ? null : String(payload.exchangeOrderId), event.symbol ?? 'UNKNOWN', String(payload.status ?? 'INTENT'),
              event.occurredAt, event.occurredAt, serializable(payload.request ?? {}),
              payload.response === undefined ? null : serializable(payload.response));
        }
      } else if (event.type === 'config.changed') {
        this.db.prepare('INSERT INTO strategy_configs(created_at_ms, config, actor) VALUES (?, ?, ?)')
          .run(event.occurredAt, serializable(event.payload), 'operator');
      }
      this.db.exec('COMMIT');
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async listEvents<T = Record<string, unknown>>(options: { type?: string; symbol?: string; limit?: number } = {}): Promise<Array<AuditEvent<T>>> {
    const limit = Math.max(1, Math.min(2_000, Math.floor(options.limit ?? 100)));
    const filters: string[] = [];
    const args: Array<string | number> = [];
    if (options.type) { filters.push('event_type = ?'); args.push(options.type); }
    if (options.symbol) { filters.push('symbol = ?'); args.push(options.symbol); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM audit_events ${where} ORDER BY id DESC LIMIT ?`).all(...args, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => asEvent<T>(row, 'occurred_at_ms'));
  }

  async getState<T>(key: string): Promise<T | undefined> {
    const row = this.db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value === undefined ? undefined : json<T>(row.value);
  }

  async setState<T>(key: string, value: T): Promise<void> {
    this.db.prepare(`INSERT INTO runtime_state(key, value, updated_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at_ms=excluded.updated_at_ms`)
      .run(key, serializable(value), Date.now());
  }

  async upsertCandles(symbol: string, candles: Candle[], timeframe = '1m'): Promise<void> {
    const statement = this.db.prepare(`INSERT INTO market_candles(
      symbol, timeframe, open_time_ms, open, high, low, close, volume, is_complete, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, timeframe, open_time_ms) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
      volume=excluded.volume, is_complete=excluded.is_complete, payload=excluded.payload`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const candle of candles) {
        statement.run(symbol, timeframe, candle.openTime, candle.open, candle.high, candle.low,
          candle.close, candle.volume, candle.complete ? 1 : 0, serializable(candle));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async getCandles(symbol: string, limit: number, timeframe = '1m'): Promise<Candle[]> {
    const count = Math.max(1, Math.min(10_000, Math.floor(limit)));
    const rows = this.db.prepare(`SELECT payload FROM market_candles
      WHERE symbol = ? AND timeframe = ? ORDER BY open_time_ms DESC LIMIT ?`).all(symbol, timeframe, count) as Array<{ payload: string }>;
    return rows.reverse().map((row) => json<Candle>(row.payload));
  }

  async close(): Promise<void> { this.db.close(); }
}

export class PostgresAuditStore implements AuditStore {
  private readonly pool: Pool;
  private initialized = false;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  }

  async migrate(): Promise<void> {
    if (this.initialized) return;
    const migrationPath = resolve(fileURLToPath(new URL('../../migrations/001_initial.sql', import.meta.url)));
    const migration = await readFile(migrationPath, 'utf8');
    await this.pool.query(migration);
    this.initialized = true;
  }

  async appendEvent<T>(event: AuditEvent<T>): Promise<number> {
    await this.migrate();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO audit_events(event_type, symbol, occurred_at, correlation_id, payload)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5::jsonb) RETURNING id`,
        [event.type, event.symbol ?? null, event.occurredAt, event.correlationId ?? null, serializable(event.payload)],
      );
      const id = Number(inserted.rows[0]?.id ?? 0);
      if (event.type === 'equity.snapshot') {
        const payload = event.payload as Record<string, unknown>;
        await client.query(`INSERT INTO equity_snapshots(occurred_at, mode, equity, available_margin,
          realized_pnl, unrealized_pnl, fees, funding_cash_flow, daily_drawdown, payload)
          VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`, [
          event.occurredAt,
          String(payload.mode ?? 'PAPER'), Number(payload.equity ?? 0), Number(payload.availableMargin ?? 0),
          Number(payload.realizedPnl ?? 0), Number(payload.unrealizedPnl ?? 0), Number(payload.fees ?? 0),
          Number(payload.fundingCashFlow ?? 0), Number(payload.dailyDrawdown ?? 0), serializable(payload),
        ]);
      } else if (event.type === 'order.intent') {
        const payload = event.payload as Record<string, unknown>;
        const clientOrderId = String(payload.clientOrderId ?? '');
        if (clientOrderId) await client.query(`INSERT INTO order_intents(client_order_id, exchange_order_id,
          symbol, status, request, response) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
          ON CONFLICT(client_order_id) DO UPDATE SET status=EXCLUDED.status,
          exchange_order_id=COALESCE(EXCLUDED.exchange_order_id, order_intents.exchange_order_id),
          updated_at=now(), response=COALESCE(EXCLUDED.response, order_intents.response)`, [
          clientOrderId, payload.exchangeOrderId ?? null, event.symbol ?? 'UNKNOWN', String(payload.status ?? 'INTENT'),
          serializable(payload.request ?? {}), payload.response === undefined ? null : serializable(payload.response),
        ]);
      } else if (event.type === 'config.changed') {
        await client.query('INSERT INTO strategy_configs(config, actor) VALUES ($1::jsonb, $2)', [serializable(event.payload), 'operator']);
      }
      await client.query('COMMIT');
      return id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listEvents<T = Record<string, unknown>>(options: { type?: string; symbol?: string; limit?: number } = {}): Promise<Array<AuditEvent<T>>> {
    await this.migrate();
    const limit = Math.max(1, Math.min(2_000, Math.floor(options.limit ?? 100)));
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (options.type) { args.push(options.type); clauses.push(`event_type = $${args.length}`); }
    if (options.symbol) { args.push(options.symbol); clauses.push(`symbol = $${args.length}`); }
    args.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(`SELECT id, event_type, symbol,
      (extract(epoch from occurred_at) * 1000)::bigint AS occurred_at_ms,
      correlation_id, payload FROM audit_events ${where} ORDER BY id DESC LIMIT $${args.length}`, args);
    return result.rows.map((row) => asEvent<T>(row as Record<string, unknown>, 'occurred_at_ms'));
  }

  async getState<T>(key: string): Promise<T | undefined> {
    await this.migrate();
    const result = await this.pool.query('SELECT value FROM runtime_state WHERE key = $1', [key]);
    return result.rows[0] ? result.rows[0].value as T : undefined;
  }

  async setState<T>(key: string, value: T): Promise<void> {
    await this.migrate();
    await this.pool.query(`INSERT INTO runtime_state(key, value) VALUES ($1, $2::jsonb)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [key, serializable(value)]);
  }

  async upsertCandles(symbol: string, candles: Candle[], timeframe = '1m'): Promise<void> {
    await this.migrate();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const candle of candles) await client.query(`INSERT INTO market_candles(
        symbol, timeframe, open_time_ms, open, high, low, close, volume, is_complete, payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT(symbol, timeframe, open_time_ms) DO UPDATE SET open=EXCLUDED.open, high=EXCLUDED.high,
      low=EXCLUDED.low, close=EXCLUDED.close, volume=EXCLUDED.volume, is_complete=EXCLUDED.is_complete,
      payload=EXCLUDED.payload`, [symbol, timeframe, candle.openTime, candle.open, candle.high, candle.low,
        candle.close, candle.volume, candle.complete, serializable(candle)]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getCandles(symbol: string, limit: number, timeframe = '1m'): Promise<Candle[]> {
    await this.migrate();
    const count = Math.max(1, Math.min(10_000, Math.floor(limit)));
    const result = await this.pool.query('SELECT payload FROM market_candles WHERE symbol=$1 AND timeframe=$2 ORDER BY open_time_ms DESC LIMIT $3', [symbol, timeframe, count]);
    return result.rows.reverse().map((row) => row.payload as Candle);
  }

  async close(): Promise<void> { await this.pool.end(); }
}

export async function createStore(options: { databaseUrl?: string; sqlitePath: string }): Promise<AuditStore> {
  if (options.databaseUrl) {
    const store = new PostgresAuditStore(options.databaseUrl);
    await store.migrate();
    return store;
  }
  return new SqliteAuditStore(options.sqlitePath);
}
