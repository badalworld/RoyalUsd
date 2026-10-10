# Royal USD

Royal USD is a risk-first MEXC USDT-margined perpetual futures research and execution system. It includes a completed-1-minute-candle KDJ/EMA/ATR scanner, a React operator dashboard, a paper engine, an exchange adapter, persisted audit/risk state, restart reconciliation, and a chronological backtester.

> **Safety status:** PAPER is the default and does not send exchange orders. LIVE is disabled by default. No MEXC account, private credential, private endpoint, live fill, fee schedule, protective order, or restart recovery has been exercised against a real account here. Treat those behaviors as unverified until you validate them independently. Backtests and paper results are not evidence of future profitability. Futures can lose more than the planned stop risk during gaps, fast markets, outages, or liquidation events.

## What the strategy does

Signals are evaluated once per **completed** 1-minute candle. A running WebSocket candle is not a signal candle, a missed crossover is not chased, and a candle timestamp already processed by the runtime is not entered a second time.

Default signal rules:

- Indicators: KDJ 9 / 3 / 3, EMA 9 and 21, and Wilder ATR 14.
- LONG: a new K-over-D crossover with K and D below 30; J rising; EMA 9 above EMA 21; close above EMA 9.
- SHORT: a new K-under-D crossover with K and D above 70; J falling; EMA 9 below EMA 21; close below EMA 9.
- Reject stale/incomplete data, missing warm-up, invalid/zero ATR, abnormally large candles, wide spread, inadequate order-book depth, unsupported contracts, and signals whose modeled target reward does not cover modeled costs.
- Initial stop: 1.0 × ATR. Initial target: 1.5R. A configured time exit is evaluated after 15 candles. Stops may be moved toward cost-aware breakeven; initial stop risk is never widened.

These are implementation defaults, not a claim that the rules are profitable. The public market feed, exchange contract metadata, and actual fills can differ from a historical CSV or test fixture.

## High-volatility universe

Automatic discovery is on by default. At stream startup Royal USD considers active, API-enabled MEXC USDT perpetuals with valid contract metadata, then ranks those having a valid 24-hour ticker by `(24h high − 24h low) / last price`. The default minimum range is **2%**; the selected universe is capped at **100 assets** (`MAX_SCANNER_ASSETS`, hard-limited to 1–100). Existing managed/pending symbols reserve places within that cap. This scan cap is separate from the hard maximum of **10 open or pending positions**.

The range is a backward-looking screening/ranking proxy, not a volatility forecast or a directional signal; it does not establish or guarantee predictive accuracy. Each actual entry must still pass the strategy, spread, order-book depth, contract, and portfolio-risk checks. Discovery happens when the stream starts; restart the stream to refresh the selected universe. If no eligible candidate is returned and there are no already-managed/pending symbols to keep subscribed, automatic mode fails startup rather than quietly scanning the manual watchlist. To use a fixed watchlist instead, set `AUTO_DISCOVER_HIGH_VOLATILITY=false`; `SYMBOLS` is only used in that mode. Configure the defaults in `.env` with `AUTO_DISCOVER_HIGH_VOLATILITY`, `MAX_SCANNER_ASSETS`, and `MIN_DAILY_RANGE_PCT`.

## Capital and execution controls

| Setting | Default | Meaning |
| --- | ---: | --- |
| Configured individual risk | 8% of eligible equity | A ceiling used for sizing, not a target or override of tighter limits. Costs are included in the estimate. |
| Aggregate open stop-risk cap | 20% of current equity | Independent portfolio ceiling. Open positions and persisted pending entries reserve risk. |
| Daily loss threshold | 50% of the account-timezone starting equity | A persistent lock threshold, not permission to risk the entire amount. An operator reset is required after a lock. |
| Maximum positions | 10 | Hard maximum, including pending entries; never a target. A symbol may have only one managed or pending entry. |
| Maximum leverage | 10× | Capped again by the contract's exchange metadata. |
| Margin mode | Isolated | Orders request isolated margin (`openType=1`); account/position mode still needs live verification. |
| Maximum margin utilization | 50% | Limits notional sized from available margin. |
| Compounding | On | Applies the fixed configured risk percentage to current eligible equity; absolute size may grow with equity, but no win-streak multiplier or risk-percentage step-up is applied. Can be disabled in the dashboard. |
| Martingale / averaging down | Off / not implemented | No automatic loss doubling or uncontrolled averaging down. |
| Paper starting equity | 10,000 USDT | Virtual account only. |

All limits intersect: quantity is reduced to the tightest of the individual allocation, remaining aggregate risk, daily allowance, margin availability/utilization, contract leverage/precision/maximum volume, and the 10-position cap. Unknown/unprotected exchange state blocks new live entries. Protective orders do not guarantee execution at their trigger price.

Paper execution models fees, funding when supplied, spread, slippage, stop/target collisions, gaps, and delayed/partial fills where the simulator supports them. Those are assumptions, not exchange fills. Live trade accounting uses exchange responses/history where available; exact fee/funding/history field behavior remains account- and API-version-dependent.

## Requirements and local development

- Node.js **22.13+** (the SQLite implementation uses Node's built-in `node:sqlite`).
- npm.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

Open the Vite address printed by the dev server. `npm run dev` starts the Express API on `0.0.0.0:3001` and the dashboard on Vite's default port. The dashboard talks to the API through a relative `/api` URL and Vite proxy; it does not call the browser's `localhost` for its backend.

The service reads environment variables from the process and loads a local `.env` file when present. Start from:

```bash
cp .env.example .env
```

Keep `.env`, database files, candle exports, reports, and credentials out of Git. In development, a dashboard token is optional; in production, `DASHBOARD_API_TOKEN` is required. Use a long random token, TLS, and a private network or authenticated reverse proxy. The token is held in browser session memory only and sent as a Bearer header; do not share the console or browser session with untrusted users.

## Paper operation

1. Leave `ALLOW_LIVE_TRADING=false` and the live-acceptance flags false.
2. Start the service and open the dashboard. It is stopped by default.
3. Select **Start paper trading** to subscribe to public MEXC market data. PAPER makes no private account call and cannot submit a real order.
4. Monitor feed freshness, rejected-signal reasons, position risk, margin estimates, fees/funding, and persisted events. Pause/stop are not position-close commands; existing positions remain open and need continued monitoring when the engine is running.
5. Paper positions and risk state are persisted locally. After a process restart, the runtime does not automatically resume trading.

SQLite is the default store (`./data/royalusd.sqlite`). For a managed deployment, `DATABASE_URL` enables PostgreSQL storage and the initial migration is applied by the application. Back up SQLite using a consistent snapshot/backup procedure while stopped or using SQLite's backup facilities; copying only the main file while WAL writes are active can omit recent state.

## Backtesting

CSV input must include `symbol,openTime,open,high,low,close,volume`; `openTime` may be Unix seconds, Unix milliseconds, or an ISO timestamp. An optional `complete` column filters unfinished bars, and `fundingRate` can supply funding assumptions.

```bash
npm run backtest -- --input ./data/bars.csv --contracts ./data/contracts.json \
  --equity 10000 --spread-bps 4 --output ./reports/btc-report.json
```

Or download up to 365 days of paginated MEXC 1-minute candles (public endpoints; contract metadata is also queried):

```bash
npm run backtest -- --download --symbols BTC_USDT,ETH_USDT --days 30 \
  --csv-output ./data/mexc-1m-30d.csv --output ./reports/latest.json
```

Use actual contract multipliers, volume/price increments, fee rates, and funding data when available; the CLI explicitly warns when contract metadata is missing and synthetic assumptions are used. Reports contain chronological development/validation/out-of-sample segments and fee, spread, slippage, gap, delay, partial-fill, and outage stresses. One-minute OHLCV cannot reconstruct order-book queue position, exact intrabar path, real spread/depth, exchange liquidation marks, or guaranteed stop fills. The simulator assumes the stop is touched first when both stop and target are within the same bar. A backtest is a diagnostic tool, not a guarantee or deployment approval.

## Deployment and live-mode gate

For a production build, install all dependencies before building the frontend, then run with production environment variables:

```bash
npm ci
npm run typecheck && npm test && npm run build
NODE_ENV=production npm start
```

An optional multi-stage image builds the UI and runs the API as the unprivileged `node` user. Docker is not required for local development; the image build itself was not run in this environment.

```bash
docker build -t royal-usd:local .
# Set NODE_ENV=production and a strong DASHBOARD_API_TOKEN in .env before running.
docker run -d --name royal-usd --restart unless-stopped \
  --env-file .env -e NODE_ENV=production \
  -p 127.0.0.1:3001:3001 -v royalusd-data:/data royal-usd:local
```

The container stores SQLite state in `/data`; keep the named volume and back it up. Bind the host port to loopback when a TLS reverse proxy runs on the same host. Set `HOST=0.0.0.0` only behind a properly secured network boundary. Terminate TLS at a trusted reverse proxy; do not expose the unauthenticated development server or database port. Keep the dashboard token and exchange credentials in a secret manager or protected environment file. MEXC keys should have only the minimum necessary futures permissions and **must not** have withdrawal permission. Consider a dedicated account/subaccount with tightly limited funds.

LIVE requires all of the following and is not enabled simply by adding credentials:

1. `ALLOW_LIVE_TRADING=true` on the server.
2. Non-empty MEXC key and secret in the server environment (never the browser).
3. Explicit operator-attestation flags set true only after completing their real checks: `MEXC_LIVE_API_PERMISSION_VERIFIED`, `MEXC_LIVE_FEES_VERIFIED`, `MEXC_PROTECTIVE_ORDERS_TESTED`, `BACKTEST_ACCEPTED`, `PAPER_ACCEPTANCE_PASSED`, and `RECOVERY_TEST_PASSED`.
4. A configured production `DASHBOARD_API_TOKEN`.
5. Exact confirmation text **ENABLE LIVE TRADING** in the authenticated dashboard/API action.
6. Successful fresh account, position, open-order, contract, position-mode, and protective-order reconciliation. Any unknown order outcome, missing full-quantity protection, or unsafe exchange state blocks entries.

Those boolean flags are operator attestations, not automated proof. Do not set them to bypass tests. Before live use, verify MEXC's current documentation, key permissions, account mode, isolated-margin behavior, leverage/precision limits, fee schedule, funding, position-level TPSL direction/volume/trigger/execution behavior, and history/recovery responses using an account and methods you are authorized to use. Those behaviors have not been validated against a real account by this repository build. The adapter currently reads the first page of up to 100 open orders and up to 100 historical positions; use a dedicated account without unrelated open orders and manually verify account state. Pagination/behavior beyond those pages remains unverified.

A restart intentionally leaves a persisted LIVE runtime stopped and paused. Review the exchange account and dashboard reconciliation status, then use **Reconcile & resume live** with exact confirmation only if you intend to re-enable entries. A daily/consecutive-loss lock requires the explicit **RESET DAILY RISK LOCK** action after reviewing current equity and exposure; calendar rollover does not silently unlock it. Emergency close-all is account-sensitive and requires an explicit phrase; confirm the account scope and exchange state before using it.

## Operator endpoints

API routes are under `/api`; all routes except `/api/health` require the dashboard token when one is configured (production requires it). Important routes:

- `GET /api/health`, `GET /api/dashboard`, `GET /api/events`
- `POST /api/paper/start`, `POST /api/control/pause`, `/resume`, `/stop`
- `POST /api/control/live/enable` with `{"confirmation":"ENABLE LIVE TRADING"}`
- `POST /api/control/cancel-pending`, `/compounding`, `/risk/reset`
- `POST /api/control/emergency-close` with the mode-specific confirmation phrase
- `POST /api/backtest` for up to 50,000 candle rows; use the CLI for larger datasets

All dashboard actions go through backend guards; no exchange order keys or raw order-create route are exposed to the browser.

### MEXC API key settings

The dashboard's **Settings** page accepts the MEXC API key and secret. The browser sends them once over the operator-authenticated API; the server never returns the secret and shows only a masked key preview.

- `GET /api/settings/mexc-credentials` returns status only (configured flags, masked key, source).
- `PUT /api/settings/mexc-credentials` with `{"apiKey","apiSecret"}` saves them.
- `DELETE /api/settings/mexc-credentials` removes the saved pair and falls back to `MEXC_API_KEY` / `MEXC_API_SECRET` if set.

Saved credentials are encrypted with AES-256-GCM only when `CREDENTIAL_ENCRYPTION_KEY` is set on the server. Without it they live in server memory until restart. Changing credentials is refused while live trading is active or live positions are open. Use `DASHBOARD_API_TOKEN` in any networked deployment, because these routes can overwrite exchange credentials.

## Validation status and limitations

`npm run typecheck`, `npm test`, and `npm run build` are the local verification checks. Tests cover indicator math, closed-candle decisions, sizing/limits, daily-lock latching, MEXC request signing and no-retry order behavior, persistence, paper/live gate behavior, restart pausing, and backtest reporting. They do **not** establish that MEXC will accept every request, that an exchange-side stop will trigger/fill as expected, or that any trading strategy will be profitable. No live order should be attempted without separate explicit authorization and real-account safety validation.
