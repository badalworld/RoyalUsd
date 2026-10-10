-- Royal USD audit-first persistence. JSONB event payloads preserve the full exchange
-- response/request context while indexed columns support reliable replay and review.
CREATE TABLE IF NOT EXISTS runtime_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  symbol text,
  occurred_at timestamptz NOT NULL,
  correlation_id text,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_type_time_idx ON audit_events(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_symbol_time_idx ON audit_events(symbol, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_correlation_idx ON audit_events(correlation_id);

CREATE TABLE IF NOT EXISTS market_candles (
  symbol text NOT NULL,
  timeframe text NOT NULL DEFAULT '1m',
  open_time_ms bigint NOT NULL,
  open numeric NOT NULL,
  high numeric NOT NULL,
  low numeric NOT NULL,
  close numeric NOT NULL,
  volume numeric NOT NULL,
  is_complete boolean NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(symbol, timeframe, open_time_ms)
);
CREATE INDEX IF NOT EXISTS market_candles_symbol_time_idx ON market_candles(symbol, open_time_ms DESC);

CREATE TABLE IF NOT EXISTS strategy_configs (
  version bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  config jsonb NOT NULL,
  actor text NOT NULL DEFAULT 'system'
);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  mode text NOT NULL,
  equity numeric NOT NULL,
  available_margin numeric NOT NULL,
  realized_pnl numeric NOT NULL,
  unrealized_pnl numeric NOT NULL,
  fees numeric NOT NULL,
  funding_cash_flow numeric NOT NULL,
  daily_drawdown numeric NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS equity_snapshots_time_idx ON equity_snapshots(occurred_at DESC);

-- All live orders are first durably recorded with a unique client id before submission.
CREATE TABLE IF NOT EXISTS order_intents (
  client_order_id text PRIMARY KEY,
  exchange_order_id text UNIQUE,
  symbol text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  request jsonb NOT NULL,
  response jsonb
);
