import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { BacktestReport, Candle } from '../src/core/types.js';
import type { DashboardData, DashboardMarket } from '../src/server/runtime.js';

type Section = 'overview' | 'backtest' | 'risk' | 'activity';

const money = (value: number, digits = 2) => Number.isFinite(value)
  ? new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
  : '—';
const signedMoney = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}$${money(Math.abs(value))}`;
const pct = (value: number, digits = 2) => Number.isFinite(value) ? `${value.toFixed(digits)}%` : '—';
const shortTime = (timestamp?: number | null) => timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const fullTime = (timestamp?: number | null) => timestamp ? new Date(timestamp).toLocaleString() : '—';
const compactNumber = (value: number) => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '—';
const pretty = (value?: string) => value ? value.toLowerCase().replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) : '—';

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  const token = sessionStorage.getItem('royalusd-operator-token');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers, cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error('AUTH_REQUIRED');
  if (!response.ok) throw new Error(body.error ?? `Request failed with HTTP ${response.status}`);
  return body as T;
}

function Glyph({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="4" rx="1.4"/><rect x="14" y="10" width="7" height="11" rx="1.4"/><rect x="3" y="13" width="7" height="8" rx="1.4"/></>,
    backtest: <><path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 6-7"/><path d="M16 6h4v4"/></>,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/></>,
    activity: <><path d="M3 12h4l3-8 4 16 3-8h4"/></>,
    crown: <><path d="m2 8 5 4 5-8 5 8 5-4-2 11H4L2 8Z"/><path d="M5 22h14"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1a1.7 1.7 0 1 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.3a1.7 1.7 0 1 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.7 1.7 0 0 0-1.2-2.9h-.3a1.7 1.7 0 1 1 0-3.4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1A1.7 1.7 0 1 1 7.6 3.3l.1.1a1.7 1.7 0 0 0 2.9-1.2v-.3a1.7 1.7 0 1 1 3.4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.3a1.7 1.7 0 1 1 0 3.4h-.2a1.7 1.7 0 0 0-1.2 2.9Z"/></>,
    play: <path d="m8 5 12 7-12 7V5Z"/>,
    pause: <><path d="M8 5h3v14H8z"/><path d="M15 5h3v14h-3z"/></>,
    refresh: <><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2"/></>,
    close: <><path d="m18 6-12 12M6 6l12 12"/></>,
    arrow: <><path d="M7 17 17 7"/><path d="M7 7h10v10"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3"/></>,
    alert: <><path d="m10.3 3.9-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></>,
    upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.overview}</svg>;
}

function StatusDot({ status }: { status: string }) {
  const type = status === 'RUNNING' ? 'good' : status === 'LOCKED' ? 'danger' : status === 'CONNECTING' ? 'pending' : 'muted';
  return <span className={`status-dot ${type}`} />;
}

function Empty({ title, description }: { title: string; description: string }) {
  return <div className="empty-state"><div className="empty-icon"><Glyph name="activity" size={20}/></div><strong>{title}</strong><span>{description}</span></div>;
}

function EquityChart({ data }: { data: DashboardData['equityCurve'] }) {
  if (data.length < 2) return <div className="chart-empty"><div className="chart-grid"><span/><span/><span/><span/></div><div><div className="chart-empty-mark"><Glyph name="activity" size={20}/></div><strong>Equity curve will appear here</strong><span>Snapshots are captured as paper or live activity runs.</span></div></div>;
  const width = 700;
  const height = 210;
  const values = data.map((point) => point.equity);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = Math.max(high - low, high * 0.001, 1);
  const points = values.map((value, index) => `${(index / (values.length - 1)) * width},${height - ((value - low) / range) * (height - 18) - 8}`);
  const path = `M ${points.join(' L ')}`;
  const area = `${path} L ${width},${height} L 0,${height} Z`;
  return <svg className="equity-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Equity curve">
    <defs>
      <linearGradient id="equity-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#52d8b1" stopOpacity=".34"/><stop offset="55%" stopColor="#6ea9ff" stopOpacity=".12"/><stop offset="100%" stopColor="#b799ff" stopOpacity="0"/></linearGradient>
      <linearGradient id="equity-stroke" gradientUnits="userSpaceOnUse" x1="0" x2={width} y1="0" y2="0"><stop offset="0%" stopColor="#52d8b1"/><stop offset="50%" stopColor="#6ea9ff"/><stop offset="100%" stopColor="#b799ff"/></linearGradient>
    </defs>
    {[0, 1, 2, 3].map((line) => <line key={line} x1="0" x2={width} y1={line * (height / 3)} y2={line * (height / 3)} stroke="#2a3644" strokeDasharray="3 6"/>)}
    <path className="equity-area" d={area} fill="url(#equity-fill)"/>
    <path className="equity-line" d={path} fill="none" stroke="url(#equity-stroke)" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
  </svg>;
}

function MetricCard({ label, value, sub, icon, tone = 'teal', trend }: { label: string; value: string; sub: string; icon: string; tone?: string; trend?: string }) {
  return <article className={`metric-card ${tone}`}>
    <div className={`metric-icon ${tone}`}><Glyph name={icon} size={18}/></div>
    <div className="metric-label">{label}</div>
    <div className="metric-value-row"><strong key={value} className="value-tick">{value}</strong>{trend && <span className="metric-trend">{trend}</span>}</div>
    <div className="metric-sub">{sub}</div>
  </article>;
}

function NavButton({ name, label, active, onClick }: { name: string; label: string; active: boolean; onClick: () => void }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}><Glyph name={name} size={17}/><span>{label}</span>{active && <span className="nav-active"/>}</button>;
}

function LoginScreen({ onToken }: { onToken: (value: string) => void }) {
  const [value, setValue] = useState('');
  return <main className="login-screen"><div className="login-card">
    <div className="brand-mark large"><Glyph name="crown" size={24}/></div>
    <div className="eyebrow">ROYAL USD · OPERATOR ACCESS</div>
    <h1>Secure trading console</h1>
    <p>Enter the dashboard token configured on the backend. It is held in this browser session only.</p>
    <form onSubmit={(event) => { event.preventDefault(); onToken(value); }}>
      <label htmlFor="token">Dashboard token</label>
      <input id="token" autoFocus type="password" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Paste operator token"/>
      <button className="button primary wide" type="submit">Unlock console <Glyph name="arrow" size={16}/></button>
    </form>
    <div className="login-safe"><Glyph name="lock" size={14}/> The token is never saved to local storage.</div>
  </div></main>;
}

function PositionTable({ data }: { data: DashboardData }) {
  if (!data.positions.length) return <Empty title="No open positions" description="When a validated signal passes the portfolio risk manager, its protected position appears here."/>;
  return <div className="table-wrap"><table>
    <thead><tr><th>Contract</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>Stop / target</th><th>Unrealized</th></tr></thead>
    <tbody>{data.positions.map((position) => <tr key={position.id}>
      <td><span className="symbol-cell"><span className="coin-avatar">{position.symbol.slice(0, 1)}</span><strong>{position.symbol.replace('_USDT', '')}</strong><small>USDT perp</small></span></td>
      <td><span className={`side-badge ${position.direction.toLowerCase()}`}>{position.direction}</span></td>
      <td>{money(position.quantity, 4)} <small>contracts</small></td>
      <td>${money(position.entryPrice, 4)}</td>
      <td>${money(position.currentPrice, 4)}</td>
      <td><span className="protect-cell"><span className="stop">${money(position.stopPrice, 4)}</span><i/><span className="target">${money(position.takeProfitPrice, 4)}</span></span></td>
      <td className={position.unrealizedPnl >= 0 ? 'positive' : 'negative'}>{signedMoney(position.unrealizedPnl)}<small>{pct(position.pnlPct)}</small></td>
    </tr>)}</tbody>
  </table></div>;
}

function MarketTable({ markets }: { markets: DashboardMarket[] }) {
  return <div className="table-wrap market-table-wrap"><table className="market-table">
    <thead><tr><th>Contract</th><th>Last price</th><th>Spread</th><th>24h range</th><th>K / D / J</th><th>EMA 9 / 21</th><th>ATR 14</th><th>Feed</th></tr></thead>
    <tbody>{markets.map((market) => {
      const point = market.indicators;
      return <tr key={market.symbol}>
        <td><span className="symbol-cell"><span className="coin-avatar">{market.symbol.slice(0, 1)}</span><strong>{market.symbol.replace('_USDT', '')}</strong><small>USDT perp</small></span></td>
        <td className="price-cell">{market.price > 0 ? `$${money(market.price, market.price > 100 ? 2 : 4)}` : '—'}</td>
        <td>{market.spreadRate > 0 ? pct(market.spreadRate * 100, 3) : '—'}</td>
        <td>{market.volatilityPct !== undefined ? pct(market.volatilityPct, 2) : '—'}</td>
        <td>{point ? <div className="indicator-stack"><span>K <b>{point.k.toFixed(1)}</b></span><span>D <b>{point.d.toFixed(1)}</b></span><span>J <b>{point.j.toFixed(1)}</b></span></div> : <span className="muted">Warming up</span>}</td>
        <td>{point ? <span className="mono-small">{money(point.emaFast, 2)} <i>/</i> {money(point.emaSlow, 2)}</span> : '—'}</td>
        <td>{point?.atr ? money(point.atr, 4) : '—'}</td>
        <td><span className={`feed-tag ${market.stale ? 'stale' : 'fresh'}`}><i/>{market.stale ? 'STALE' : market.contractEnabled === false ? 'DISABLED' : 'LIVE'}</span></td>
      </tr>;
    })}</tbody>
  </table></div>;
}

function ActivityTable({ data }: { data: DashboardData }) {
  if (!data.tradeHistory.length) return <Empty title="No completed trades yet" description="Paper and live executions will be recorded with gross PnL, fees, funding, and net PnL."/>;
  return <div className="table-wrap"><table>
    <thead><tr><th>Closed</th><th>Contract</th><th>Side</th><th>Entry → Exit</th><th>Gross PnL</th><th>Fees</th><th>Funding</th><th>Net PnL</th></tr></thead>
    <tbody>{data.tradeHistory.slice(0, 12).map((trade) => <tr key={`${trade.id}-${trade.exitTime}`}>
      <td>{shortTime(trade.exitTime)}<small>{new Date(trade.exitTime).toLocaleDateString()}</small></td>
      <td><strong>{trade.symbol.replace('_USDT', '')}</strong></td>
      <td><span className={`side-badge ${trade.direction.toLowerCase()}`}>{trade.direction}</span></td>
      <td className="mono-small">${money(trade.entryPrice, 3)} <i>→</i> ${money(trade.exitPrice, 3)}</td>
      <td className={trade.grossPnl >= 0 ? 'positive' : 'negative'}>{signedMoney(trade.grossPnl)}</td>
      <td className="negative">−${money(trade.fees)}</td>
      <td className={trade.fundingCashFlow >= 0 ? 'positive' : 'negative'}>{signedMoney(trade.fundingCashFlow)}</td>
      <td className={trade.netPnl >= 0 ? 'positive' : 'negative'}><strong>{signedMoney(trade.netPnl)}</strong></td>
    </tr>)}</tbody>
  </table></div>;
}

function SignalFeed({ signals }: { signals: DashboardData['signals'] }) {
  if (!signals.length) return <Empty title="Scanner is standing by" description="Fresh completed candles and qualifying crossovers will be logged here."/>;
  return <div className="signal-list">{signals.slice(0, 8).map((signal) => <div className="signal-row" key={signal.id}>
    <span className={`signal-icon ${signal.accepted ? signal.direction?.toLowerCase() : 'rejected'}`}>
      {signal.accepted ? <Glyph name="arrow" size={14}/> : <Glyph name="close" size={14}/>}
    </span>
    <div className="signal-copy"><strong>{signal.symbol.replace('_USDT', '')} {signal.direction ?? 'signal'}</strong><span>{signal.accepted ? 'Risk approved' : pretty(signal.reason)}{signal.details ? ` · ${signal.details}` : ''}</span></div>
    <time>{shortTime(signal.createdAt)}</time>
  </div>)}</div>;
}

function StatusBanner({ data }: { data: DashboardData }) {
  if (data.account.dailyLocked) return <div className="banner danger"><Glyph name="lock"/><div><strong>Daily risk lock is active</strong><span>New entries are disabled. Existing positions continue to be monitored and protected. Drawdown: ${money(data.account.dailyDrawdown)}.</span></div></div>;
  if (data.status === 'LOCKED') return <div className="banner danger"><Glyph name="alert"/><div><strong>Trading is locked</strong><span>{data.liveBlockReason ?? 'An unresolved safety condition requires operator attention.'}</span></div></div>;
  if (data.started && !data.marketDataFresh) return <div className="banner warning"><Glyph name="alert"/><div><strong>Market feed is not fresh</strong><span>New signals are rejected while data is stale. Exchange-side protective orders remain independent in live mode.</span></div></div>;
  if (!data.started) return <div className="banner info"><Glyph name="clock"/><div><strong>Bot is stopped · paper mode is armed</strong><span>Start paper trading to connect to MEXC public market data. No real orders can be sent in paper mode.</span></div></div>;
  if (data.mode === 'LIVE') return <div className="banner warning"><Glyph name="alert"/><div><strong>Live futures trading is active</strong><span>Exchange execution is enabled. Review current margin, stops, and account risk continuously.</span></div></div>;
  return <div className="banner success"><Glyph name="check"/><div><strong>Paper engine is monitoring</strong><span>Market data is streamed from MEXC. Simulated fills only — the exchange receives no orders.</span></div></div>;
}

const CHART_PERIODS = { ALL: Infinity, '1D': 86_400_000, '1W': 604_800_000, '1M': 2_592_000_000 } as const;
type ChartPeriod = keyof typeof CHART_PERIODS;

function Overview({ data, action, loading }: { data: DashboardData; action: (path: string, body?: unknown) => Promise<void>; loading: string | null }) {
  const [period, setPeriod] = useState<ChartPeriod>('ALL');
  const curve = data.equityCurve.filter((point) => point.timestamp >= Date.now() - CHART_PERIODS[period]);
  const drawdownPct = data.account.dailyStartingEquity > 0 ? data.account.dailyDrawdown / data.account.dailyStartingEquity * 100 : 0;
  const riskPct = data.account.equity > 0 ? data.account.aggregateRisk / data.account.equity * 100 : 0;
  const connected = data.marketStream.connected;
  const openCount = data.positions.length;
  const dailyRemaining = Math.max(0, data.account.dailyStartingEquity * data.config.risk.dailyMaxLoss - data.account.dailyDrawdown);
  const requestLiveEnable = async () => {
    const prompt = data.mode === 'LIVE'
      ? 'Exchange state will be reconciled before resuming live entries. Type exactly: ENABLE LIVE TRADING'
      : 'Live mode uses real MEXC futures orders. Type exactly: ENABLE LIVE TRADING';
    const confirmation = window.prompt(prompt);
    if (confirmation) await action('/api/control/live/enable', { confirmation });
  };
  return <>
    <StatusBanner data={data}/>
    <div className="metric-grid">
      <MetricCard label="Account equity" value={data.account.source === 'UNSYNCED' ? 'Not synced' : `$${money(data.account.equity)}`} sub={data.account.source === 'PAPER' ? 'Virtual paper account' : data.account.source === 'MEXC' ? 'Reconciled MEXC USDT equity' : 'Waiting for account reconciliation'} icon="overview" tone="teal"/>
      <MetricCard label="Daily PnL" value={signedMoney(data.account.equity - data.account.dailyStartingEquity)} sub={`Drawdown ${pct(drawdownPct)} · loss room $${money(dailyRemaining)}`} icon="activity" tone={data.account.dailyDrawdown > 0 ? 'orange' : 'blue'} trend={data.account.dailyLocked ? 'LOCKED' : undefined}/>
      <MetricCard label="Available margin" value={data.account.source === 'UNSYNCED' ? '—' : `$${money(data.account.availableMargin)}`} sub={`${pct(data.account.marginUtilization * 100)} utilized · isolated`} icon="shield" tone="violet"/>
      <MetricCard label="Aggregate stop risk" value={data.account.equity > 0 ? `$${money(data.account.aggregateRisk)}` : '—'} sub={`${pct(riskPct)} of equity · cap ${pct(data.config.risk.aggregatePortfolioRiskLimit * 100)}`} icon="lock" tone="red"/>
    </div>

    <div className="content-grid top-grid">
      <section className="panel chart-panel">
        <div className="panel-head"><div><div className="panel-title">Equity overview</div><div className="panel-subtitle">Account value · fees and funding reflected</div></div><div className="chart-period" role="group" aria-label="Equity chart period">{(Object.keys(CHART_PERIODS) as ChartPeriod[]).map((key) => <button key={key} type="button" className={period === key ? 'selected' : ''} aria-pressed={period === key} onClick={() => setPeriod(key)}>{key}</button>)}</div></div>
        <div className="chart-summary"><strong>{data.account.source === 'UNSYNCED' ? '—' : `$${money(data.account.equity)}`}</strong><span className={data.performance.netPnl >= 0 ? 'positive' : 'negative'}>{signedMoney(data.performance.netPnl)} <small>realized net</small></span></div>
        <div className="chart-frame"><EquityChart data={curve}/></div>
        <div className="chart-axis"><span>{curve.length ? new Date(curve[0]!.timestamp).toLocaleDateString() : 'No snapshots'}</span><span>{curve.length ? shortTime(curve.at(-1)?.timestamp) : 'Awaiting first minute'}</span></div>
      </section>
      <section className="panel portfolio-panel">
        <div className="panel-head"><div><div className="panel-title">Portfolio exposure</div><div className="panel-subtitle">Hard limit · {data.config.maxSimultaneousPositions} positions</div></div><span className="count-pill">{openCount}<i>/</i>{data.config.maxSimultaneousPositions}</span></div>
        <div className="portfolio-ring-wrap">
          <div className="portfolio-ring" style={{ '--ring-value': `${Math.min(100, openCount / data.config.maxSimultaneousPositions * 100)}%` } as CSSProperties}><div><strong>{openCount}</strong><span>OPEN</span></div></div>
          <div className="portfolio-legend"><div><i className="dot-long"/><span>Long exposure</span><strong>{data.positions.filter((position) => position.direction === 'LONG').length}</strong></div><div><i className="dot-short"/><span>Short exposure</span><strong>{data.positions.filter((position) => position.direction === 'SHORT').length}</strong></div><div><i className="dot-pending"/><span>Pending entry</span><strong>{data.pendingOrders.length}</strong></div></div>
        </div>
        <div className="portfolio-risk"><div><span>Open stop risk</span><strong>${money(data.account.aggregateRisk)}</strong></div><div className="risk-bar"><i style={{ width: `${Math.min(100, riskPct / Math.max(data.config.risk.aggregatePortfolioRiskLimit * 100, 1) * 100)}%` }}/></div><small>{pct(riskPct)} of equity · portfolio cap {pct(data.config.risk.aggregatePortfolioRiskLimit * 100)}</small></div>
      </section>
    </div>

    <section className="panel control-panel">
      <div className="panel-head control-head"><div><div className="panel-title">Trading controls</div><div className="panel-subtitle">All entries pass the backend risk manager</div></div><div className="control-status"><StatusDot status={data.status}/><span>{pretty(data.status)}</span></div></div>
      <div className="control-layout">
        <div className="primary-controls">
          {!data.started ? data.mode === 'LIVE'
            ? <button className="button primary" disabled={loading === 'live' || data.liveBlockers.length > 0} title={data.liveBlockers.join('\n')} onClick={() => void requestLiveEnable()}><Glyph name="refresh" size={16}/>{loading === 'live' ? 'Reconciling…' : 'Reconcile & resume live'}</button>
            : <button className="button primary" disabled={loading === 'start'} onClick={() => void action('/api/paper/start')}><Glyph name="play" size={16}/>{loading === 'start' ? 'Connecting…' : 'Start paper trading'}</button> : <>
            {data.paused ? <button className="button primary" disabled={loading === 'resume' || data.account.dailyLocked} onClick={() => void action('/api/control/resume')}><Glyph name="play" size={15}/>{loading === 'resume' ? 'Resuming…' : 'Resume entries'}</button> : <button className="button secondary" disabled={loading === 'pause'} onClick={() => void action('/api/control/pause')}><Glyph name="pause" size={15}/>{loading === 'pause' ? 'Pausing…' : 'Pause new entries'}</button>}
            <button className="button subtle" disabled={loading === 'stop'} onClick={() => void action('/api/control/stop')}><Glyph name="close" size={15}/>Stop monitoring</button>
          </>}
          <button className="button live-button" disabled={data.mode === 'LIVE' || data.liveBlockers.length > 0 || loading === 'live'} title={data.liveBlockers.join('\n') || 'Live mode requires explicit confirmation'} onClick={() => void requestLiveEnable()}><span className="live-dot"/>{data.mode === 'LIVE' ? 'LIVE MODE' : 'Enable live trading'}{data.liveBlockers.length > 0 && <Glyph name="lock" size={14}/>}</button>
        </div>
        <div className="secondary-controls">
          <button className="control-chip" disabled={!data.pendingOrders.length || loading === 'cancel'} onClick={() => void action('/api/control/cancel-pending')}><Glyph name="close" size={15}/><span>Cancel entries</span></button>
          <button className="control-chip danger-chip" disabled={!data.positions.length || loading === 'emergency'} onClick={async () => {
            const phrase = data.mode === 'LIVE' ? 'CLOSE ALL LIVE POSITIONS' : 'CLOSE ALL PAPER POSITIONS';
            if (window.confirm(`This will close ${data.positions.length} ${data.mode.toLowerCase()} position(s). Continue?`)) await action('/api/control/emergency-close', { confirmation: phrase });
          }}><Glyph name="alert" size={15}/><span>Emergency close</span></button>
          <button className="control-chip" disabled={!data.account.dailyLocked || loading === 'risk'} onClick={async () => {
            const confirmation = window.prompt('Type exactly: RESET DAILY RISK LOCK');
            if (confirmation) await action('/api/control/risk/reset', { confirmation });
          }}><Glyph name="refresh" size={15}/><span>Reset risk lock</span></button>
          <label className="compound-toggle"><span>Compounding</span><input type="checkbox" checked={data.config.compoundingEnabled} disabled={loading === 'compound'} onChange={(event) => void action('/api/control/compounding', { enabled: event.target.checked })}/><i/></label>
        </div>
      </div>
      {data.mode !== 'LIVE' && data.liveBlockers.length > 0 && <div className="live-blocked-note"><Glyph name="lock" size={14}/><span>Live mode locked by default. {data.liveBlockers.length} mandatory readiness checks remain.</span><button onClick={() => window.dispatchEvent(new CustomEvent('royalusd-navigate', { detail: 'risk' }))}>Review checklist <Glyph name="arrow" size={12}/></button></div>}
    </section>

    <div className="content-grid split-grid">
      <section className="panel positions-panel">
        <div className="panel-head"><div><div className="panel-title">Open positions</div><div className="panel-subtitle">Exchange-confirmed · protective orders monitored</div></div><span className="live-count">{openCount} / {data.config.maxSimultaneousPositions}</span></div>
        <PositionTable data={data}/>
      </section>
      <section className="panel signal-panel">
        <div className="panel-head"><div><div className="panel-title">Signal audit</div><div className="panel-subtitle">Recent triggers and rejections</div></div><button className="icon-button" aria-label="View activity" onClick={() => window.dispatchEvent(new CustomEvent('royalusd-navigate', { detail: 'activity' }))}><Glyph name="arrow" size={15}/></button></div>
        <SignalFeed signals={data.signals}/>
      </section>
    </div>

    <section className="panel market-panel">
      <div className="panel-head"><div><div className="panel-title">High-volatility market scanner</div><div className="panel-subtitle">{data.config.universe.autoDiscoverHighVolatility
        ? `${data.config.universe.selectedHighVolatilityAssets} selected · 24h range ≥ ${pct(data.config.universe.minDailyRangePct, 1)} · maximum ${data.config.universe.maxAssets} assets`
        : `Manual watchlist · ${data.config.symbols.length} assets`} · completed 1m candles · KDJ 9 · EMA 9/21 · ATR 14</div></div><div className="market-head-right"><span className={`feed-status ${connected ? 'connected' : 'offline'}`}><i/>{connected ? 'WebSocket connected' : data.marketStream.connecting ? 'Connecting' : 'Feed offline'}</span><span className="refresh-time">Updated {shortTime(data.marketStream.lastMessageAt)}</span></div></div>
      <MarketTable markets={data.markets}/>
      <div className="market-footnote"><span><i/>{data.config.universe.autoDiscoverHighVolatility
        ? 'Universe is ranked by 24h high-low range; this screening proxy is not a return forecast.'
        : 'Manual watchlist mode bypasses the automatic high-volatility universe filter.'}</span><span>Entry gates: spread ≤ {pct(data.config.strategy.maxSpreadRate * 100, 3)} · depth ≥ ${compactNumber(data.config.strategy.minDepthLiquidityUsd)}</span></div>
    </section>

    <section className="panel trade-panel">
      <div className="panel-head"><div><div className="panel-title">Trade history</div><div className="panel-subtitle">Gross results separated from trading costs</div></div><div className="performance-inline"><span>{data.performance.totalTrades} trades</span><i /><span>Win rate {pct(data.performance.winRatePct, 1)}</span><i/><span>Profit factor {money(data.performance.profitFactor, 2)}</span></div></div>
      <ActivityTable data={data}/>
    </section>
    <div className="disclaimer"><Glyph name="alert" size={15}/><span>Futures trading involves substantial risk. This strategy is not guaranteed to be profitable. Paper fills and historical simulations cannot reproduce all exchange execution behavior.</span></div>
  </>;
}

function RiskScreen({ data, action, loading }: { data: DashboardData; action: (path: string, body?: unknown) => Promise<void>; loading: string | null }) {
  const readiness = [
    ['Server-side live switch', data.liveBlockers.some((item) => item.includes('ALLOW_LIVE')) ? 'Not enabled' : 'Enabled'],
    ['API key & secret', data.liveBlockers.some((item) => item.includes('API key') || item.includes('API secret')) ? 'Missing' : 'Configured'],
    ['Futures order permissions', data.liveBlockers.some((item) => item.includes('permissions')) ? 'Not verified' : 'Verified'],
    ['Account fee schedule', data.liveBlockers.some((item) => item.includes('fee schedule')) ? 'Not verified' : 'Verified'],
    ['Protective order testing', data.liveBlockers.some((item) => item.includes('protective-order')) ? 'Not tested' : 'Tested'],
    ['Backtest acceptance', data.liveBlockers.some((item) => item.includes('backtest')) ? 'Not recorded' : 'Recorded'],
    ['Paper acceptance', data.liveBlockers.some((item) => item.includes('paper-trading')) ? 'Not recorded' : 'Recorded'],
    ['Restart recovery tests', data.liveBlockers.some((item) => item.includes('recovery')) ? 'Not recorded' : 'Recorded'],
    ['Dashboard authentication', data.liveBlockers.some((item) => item.includes('authentication')) ? 'Not configured' : 'Configured'],
    ['Current exchange reconciliation', data.liveReady ? 'Healthy' : 'Required'],
  ];
  const openRiskPct = data.account.equity > 0 ? data.account.aggregateRisk / data.account.equity * 100 : 0;
  return <div className="risk-screen">
    <div className="page-intro"><div className="eyebrow">CAPITAL PROTECTION</div><h1>Risk & safety</h1><p>Risk limits are enforced server-side. User values are upper bounds; aggregate portfolio exposure can reject a trade before the 10-position hard cap.</p></div>
    <div className="risk-hero-grid">
      <section className="panel risk-summary-panel"><div className="panel-head"><div><div className="panel-title">Portfolio risk state</div><div className="panel-subtitle">Current mode · {data.mode}</div></div><span className={`pill-status ${data.status.toLowerCase()}`}><StatusDot status={data.status}/>{pretty(data.status)}</span></div>
        <div className="risk-big-number">${money(data.account.aggregateRisk)}<small> open stop risk</small></div>
        <div className="risk-bar large"><i style={{ width: `${Math.min(100, openRiskPct / Math.max(data.config.risk.aggregatePortfolioRiskLimit * 100, 1) * 100)}%` }}/></div>
        <div className="risk-meta-row"><span>{pct(openRiskPct)} of equity</span><span>Configured cap {pct(data.config.risk.aggregatePortfolioRiskLimit * 100)}</span></div>
        <div className="risk-divider"/>
        <div className="risk-tile-row"><div><span>Individual risk upper bound</span><strong>{pct(data.config.risk.riskPerTrade * 100)}</strong></div><div><span>Daily loss upper bound</span><strong>{pct(data.config.risk.dailyMaxLoss * 100)}</strong></div><div><span>Leverage hard cap</span><strong>{data.config.risk.maxLeverage}×</strong></div></div>
      </section>
      <section className="panel risk-state-panel"><div className="panel-head"><div><div className="panel-title">Daily risk lock</div><div className="panel-subtitle">Timezone: {data.config.risk.timezone}</div></div><Glyph name={data.account.dailyLocked ? 'lock' : 'shield'} size={20}/></div>
        <div className={`lock-state ${data.account.dailyLocked ? 'locked' : 'clear'}`}><i/><strong>{data.account.dailyLocked ? 'Entries locked' : 'Within limit'}</strong></div>
        <div className="risk-meta-row"><span>Current drawdown</span><strong>${money(data.account.dailyDrawdown)} ({pct(data.account.dailyStartingEquity > 0 ? data.account.dailyDrawdown / data.account.dailyStartingEquity * 100 : 0)})</strong></div>
        <div className="risk-meta-row"><span>Daily loss threshold</span><strong>${money(data.account.dailyStartingEquity * data.config.risk.dailyMaxLoss)}</strong></div>
        <div className="risk-meta-row"><span>Consecutive losses</span><strong>{data.account.consecutiveLosses} / {data.account.maxConsecutiveLosses}</strong></div>
        <button className="button secondary wide" disabled={!data.account.dailyLocked || loading === 'risk'} onClick={async () => {
          const confirmation = window.prompt('Type exactly: RESET DAILY RISK LOCK');
          if (confirmation) await action('/api/control/risk/reset', { confirmation });
        }}><Glyph name="refresh" size={15}/>Reset lock with authorization</button>
      </section>
    </div>
    <section className="panel safety-panel"><div className="panel-head"><div><div className="panel-title">Live mode readiness</div><div className="panel-subtitle">Live remains disabled until every server-side check passes</div></div><span className={`readiness-pill ${data.liveBlockers.length ? 'blocked' : 'ready'}`}><Glyph name={data.liveBlockers.length ? 'lock' : 'check'} size={13}/>{data.liveBlockers.length ? `${data.liveBlockers.length} blockers` : 'Checks complete'}</span></div>
      <div className="readiness-list">{readiness.map(([label, value]) => <div className="readiness-row" key={label}><span className={`readiness-icon ${value === 'Verified' || value === 'Tested' || value === 'Recorded' || value === 'Healthy' || value === 'Configured' || value === 'Enabled' ? 'ok' : 'todo'}`}><Glyph name={value === 'Verified' || value === 'Tested' || value === 'Recorded' || value === 'Healthy' || value === 'Configured' || value === 'Enabled' ? 'check' : 'clock'} size={13}/></span><span>{label}</span><strong>{value}</strong></div>)}</div>
      {data.liveBlockers.length > 0 && <div className="blocker-list"><strong>Readiness blockers</strong>{data.liveBlockers.map((blocker) => <div key={blocker}><Glyph name="alert" size={14}/>{blocker}</div>)}</div>}
    </section>
    <section className="panel params-panel"><div className="panel-head"><div><div className="panel-title">Active strategy & limits</div><div className="panel-subtitle">Versioned configuration · fixed baseline</div></div><span className="paper-tag">PAPER DEFAULT</span></div>
      <div className="params-grid">
        <div><span>Exchange</span><strong>MEXC USDT perpetuals</strong></div><div><span>Signal timeframe</span><strong>1 minute · completed candles</strong></div><div><span>KDJ</span><strong>{data.config.indicators.kdjLength} · {data.config.indicators.kSmoothing} · {data.config.indicators.dSmoothing}</strong></div><div><span>Trend filter</span><strong>EMA {data.config.indicators.emaFast} / {data.config.indicators.emaSlow}</strong></div><div><span>Volatility</span><strong>ATR {data.config.indicators.atrLength}</strong></div><div><span>Stop / target</span><strong>{data.config.strategy.stopAtrMultiple} × ATR / {data.config.strategy.takeProfitR}R</strong></div><div><span>Universe screen</span><strong>{data.config.universe.autoDiscoverHighVolatility ? `24h range ≥ ${pct(data.config.universe.minDailyRangePct, 1)}` : 'Manual symbols'}</strong></div><div><span>Scanner assets</span><strong>{data.config.universe.selectedHighVolatilityAssets} / {data.config.universe.maxAssets} max</strong></div><div><span>Margin mode</span><strong>Isolated</strong></div><div><span>Maximum positions</span><strong>{data.config.risk.maxOpenPositions}</strong></div><div><span>Compounding</span><strong>{data.config.compoundingEnabled ? 'Enabled' : 'Disabled'}</strong></div><div><span>Martingale / averaging</span><strong>Disabled / Disabled</strong></div><div><span>Default fees</span><strong>Maker 0.06% · taker 0.08%</strong></div><div><span>Account timezone</span><strong>{data.config.risk.timezone}</strong></div>
      </div>
      <div className="caution-note"><Glyph name="alert" size={15}/><span>The requested 8% per-trade risk and 50% daily loss are aggressive upper bounds—not targets or loss guarantees. The 20% aggregate stop-risk cap is independent, and correlated contracts are counted at full risk.</span></div>
    </section>
  </div>;
}

function parseCsvFile(textValue: string): Record<string, Candle[]> {
  const rows = textValue.split(/\r?\n/).filter((line) => line.trim());
  if (rows.length < 2) throw new Error('The CSV needs a header and at least one candle.');
  const header = rows[0]!.split(',').map((field) => field.trim().toLowerCase());
  const required = ['symbol', 'opentime', 'open', 'high', 'low', 'close', 'volume'];
  for (const field of required) if (!header.includes(field)) throw new Error(`CSV missing “${field}”.`);
  const column = (name: string) => header.indexOf(name);
  const result: Record<string, Candle[]> = {};
  let count = 0;
  for (const line of rows.slice(1)) {
    const fields = line.split(',').map((field) => field.trim());
    const symbol = fields[column('symbol')]?.toUpperCase();
    if (!symbol || !/^[A-Z0-9]{2,24}_USDT$/.test(symbol)) throw new Error('Only MEXC USDT perpetual symbols are accepted.');
    const rawTime = fields[column('opentime')] ?? '';
    const numericTime = Number(rawTime);
    const openTime = Number.isFinite(numericTime) ? numericTime < 10_000_000_000 ? numericTime * 1000 : numericTime : Date.parse(rawTime);
    const candle: Candle = {
      symbol,
      openTime,
      open: Number(fields[column('open')]),
      high: Number(fields[column('high')]),
      low: Number(fields[column('low')]),
      close: Number(fields[column('close')]),
      volume: Number(fields[column('volume')]),
      complete: column('complete') < 0 || ['1', 'true', 'yes'].includes((fields[column('complete')] ?? '').toLowerCase()),
    };
    if (column('fundingrate') >= 0 && fields[column('fundingrate')] !== '') candle.fundingRate = Number(fields[column('fundingrate')]);
    if (![candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) throw new Error('CSV contains a non-finite candle value.');
    (result[symbol] ??= []).push(candle);
    count += 1;
    if (count > 50_000) throw new Error('Browser backtests are limited to 50,000 candle rows. Use the CLI for larger files.');
  }
  for (const bars of Object.values(result)) bars.sort((a, b) => a.openTime - b.openTime);
  return result;
}

function BacktestScreen() {
  const [fileName, setFileName] = useState('');
  const [barsBySymbol, setBarsBySymbol] = useState<Record<string, Candle[]> | null>(null);
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [equity, setEquity] = useState('10000');
  const [spreadBps, setSpreadBps] = useState('4');

  async function readFile(file?: File) {
    setReport(null);
    setError('');
    if (!file) return;
    try {
      const parsed = parseCsvFile(await file.text());
      setBarsBySymbol(parsed);
      setFileName(file.name);
    } catch (cause) {
      setBarsBySymbol(null);
      setFileName('');
      setError(cause instanceof Error ? cause.message : 'Unable to read CSV.');
    }
  }

  async function run() {
    if (!barsBySymbol) return;
    setRunning(true);
    setError('');
    try {
      const response = await apiRequest<BacktestReport>('/api/backtest', {
        method: 'POST',
        body: JSON.stringify({ barsBySymbol, initialEquity: Number(equity), assumedSpreadRate: Number(spreadBps) / 10_000 }),
      });
      setReport(response);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Backtest failed.';
      if (message === 'AUTH_REQUIRED') window.dispatchEvent(new CustomEvent('royalusd-auth-required'));
      else setError(message);
    } finally { setRunning(false); }
  }

  const oos = report?.splits.outOfSample;
  const downloadReport = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'royal-usd-backtest-report.json'; link.click(); URL.revokeObjectURL(url);
  };

  return <div className="backtest-screen">
    <div className="page-intro"><div className="eyebrow">RESEARCH WORKSPACE</div><h1>Historical backtesting</h1><p>Chronological 60 / 20 / 20 development, validation, and untouched out-of-sample splits. Same indicator and risk modules as paper mode.</p></div>
    <div className="backtest-grid">
      <section className="panel upload-panel"><div className="panel-head"><div><div className="panel-title">Historical MEXC 1-minute candles</div><div className="panel-subtitle">Upload local CSV or download data with the CLI</div></div><span className="csv-tag">OHLCV CSV</span></div>
        <label className={`file-drop ${barsBySymbol ? 'loaded' : ''}`} htmlFor="backtest-file"><span className="file-drop-icon"><Glyph name={barsBySymbol ? 'check' : 'upload'} size={20}/></span><strong>{fileName || 'Choose a candle CSV'}</strong><span>{barsBySymbol ? `${Object.keys(barsBySymbol).length} symbols · ${Object.values(barsBySymbol).reduce((sum, bars) => sum + bars.length, 0).toLocaleString()} rows` : 'symbol, openTime, open, high, low, close, volume, complete, fundingRate'}</span><input id="backtest-file" type="file" accept=".csv,text/csv" onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ''; }}/></label>
        <div className="form-row"><label>Initial equity (USDT)<input type="number" min="1" value={equity} onChange={(event) => setEquity(event.target.value)}/></label><label>Assumed full spread (bps)<input type="number" min="0" step="0.5" value={spreadBps} onChange={(event) => setSpreadBps(event.target.value)}/></label></div>
        <div className="data-note"><Glyph name="alert" size={14}/><span>For an auditable exchange backtest, include MEXC contract metadata and funding fields. Missing contract metadata uses a labeled 1.0 synthetic multiplier. Historical order-book spread, queue priority, mark-price liquidation, and actual fees are not in OHLCV.</span></div>
        {error && <div className="inline-error"><Glyph name="alert" size={14}/>{error}</div>}
        <button className="button primary wide" disabled={!barsBySymbol || running} onClick={() => void run()}><Glyph name={running ? 'clock' : 'play'} size={16}/>{running ? 'Running deterministic simulation…' : 'Run backtest & stress tests'}</button>
      </section>
      <section className="panel methodology-panel"><div className="panel-head"><div><div className="panel-title">Simulation model</div><div className="panel-subtitle">No look-ahead execution</div></div><Glyph name="shield" size={20}/></div>
        <ul className="method-list"><li><Glyph name="check" size={14}/>Completed candles only; next-bar execution assumption</li><li><Glyph name="check" size={14}/>KDJ 9/3/3 · EMA 9/21 · Wilder ATR 14</li><li><Glyph name="check" size={14}/>Stops, targets, breakeven, opposite signal, 15-candle time exit</li><li><Glyph name="check" size={14}/>Compounding, 10-position cap, aggregate risk & daily lock</li><li><Glyph name="check" size={14}/>Fees, spread, slippage & signed funding cash flow</li><li><Glyph name="check" size={14}/>Conservative stop-first intrabar ambiguity rule</li></ul>
        <div className="stress-list"><strong>Included stress scenarios</strong><span>2× fees · 2× spread · 3× slippage · 0.5% gap shock · delayed execution · half fills · API outage simulation</span></div>
        <div className="method-warning"><Glyph name="alert" size={14}/>Historical performance is not a guarantee and is not sufficient by itself to authorize live trading.</div>
      </section>
    </div>
    {report && oos && <>
      <div className="report-head"><div><div className="eyebrow">REPRODUCIBLE REPORT</div><h2>Backtest results</h2><p>{report.symbols.join(', ')} · {report.candleCount.toLocaleString()} completed candles · generated {fullTime(report.generatedAt)}</p></div><button className="button secondary" onClick={downloadReport}><Glyph name="download" size={15}/>Download JSON</button></div>
      <div className="split-cards">{(['development', 'validation', 'outOfSample'] as const).map((key) => {
        const part = report.splits[key];
        return <div className={`split-card ${key === 'outOfSample' ? 'highlight' : ''}`} key={key}><div><span>{key === 'outOfSample' ? 'Untouched out-of-sample' : pretty(key)}</span>{key === 'outOfSample' && <i>20%</i>}</div><strong className={part.netReturnPct >= 0 ? 'positive' : 'negative'}>{part.netReturnPct >= 0 ? '+' : ''}{part.netReturnPct.toFixed(2)}%</strong><small>${money(part.initialEquity)} → ${money(part.finalEquity)} · max DD {pct(part.maxDrawdownPct)}</small><div className="split-mini"><span>{part.trades.length} trades</span><span>Win {pct(part.winRatePct, 1)}</span><span>PF {money(part.profitFactor, 2)}</span></div></div>;
      })}</div>
      <div className="metric-grid report-metrics">
        <MetricCard label="Net expectancy / trade" value={signedMoney(oos.expectancy)} sub="Out-of-sample · after modeled costs" icon="activity" tone="teal"/>
        <MetricCard label="Profit factor" value={money(oos.profitFactor, 2)} sub="Gross winning / losing net trades" icon="overview" tone="blue"/>
        <MetricCard label="Trading fees" value={`$${money(oos.totalFees)}`} sub={`Slippage $${money(oos.totalSlippage)}`} icon="shield" tone="orange"/>
        <MetricCard label="Funding cash flow" value={signedMoney(oos.fundingCashFlow)} sub="Positive received · negative paid" icon="activity" tone="violet"/>
      </div>
      <section className="panel report-panel"><div className="panel-head"><div><div className="panel-title">Out-of-sample diagnostics</div><div className="panel-subtitle">Chronological evaluation · unchanged configuration</div></div></div>
        <div className="diagnostic-grid"><div><span>Long trades / net</span><strong>{oos.longTrades} · {signedMoney(oos.longNetPnl)}</strong></div><div><span>Short trades / net</span><strong>{oos.shortTrades} · {signedMoney(oos.shortNetPnl)}</strong></div><div><span>Average winner</span><strong>{signedMoney(oos.averageWinner)}</strong></div><div><span>Average loser</span><strong>{signedMoney(oos.averageLoser)}</strong></div><div><span>Max concurrent positions</span><strong>{oos.maxSimultaneousPositions} / 10</strong></div><div><span>Peak aggregate risk</span><strong>{pct(oos.maxAggregateRiskPct)}</strong></div><div><span>Consecutive loss peak</span><strong>{oos.maxConsecutiveLosses}</strong></div><div><span>Daily locks / margin rejects</span><strong>{oos.dailyLossLockEvents} / {oos.marginLimitEvents}</strong></div><div><span>Liquidation-safety rejects</span><strong>{oos.liquidationRiskEvents}</strong></div></div>
        {report.warnings.map((warning, index) => <div className="report-warning" key={index}><Glyph name="alert" size={14}/>{warning}</div>)}
      </section>
      <section className="panel report-panel"><div className="panel-head"><div><div className="panel-title">Stress results</div><div className="panel-subtitle">No guarantee all real execution failures are captured</div></div></div>
        <div className="table-wrap"><table><thead><tr><th>Scenario</th><th>Net return</th><th>Max drawdown</th><th>Fees</th><th>Max positions</th><th>Risk locks</th></tr></thead><tbody>{Object.entries(report.stressScenarios).map(([scenario, values]) => <tr key={scenario}><td>{pretty(scenario)}</td><td className={values.netReturnPct >= 0 ? 'positive' : 'negative'}>{pct(values.netReturnPct)}</td><td>{pct(values.maxDrawdownPct)}</td><td>${money(values.totalFees)}</td><td>{values.maxSimultaneousPositions}</td><td>{values.dailyLossLockEvents} / {values.marginLimitEvents} margin</td></tr>)}</tbody></table></div>
      </section>
    </>}
  </div>;
}

function ActivityScreen({ data }: { data: DashboardData }) {
  return <div className="activity-screen"><div className="page-intro"><div className="eyebrow">AUDIT TRAIL</div><h1>Trading activity</h1><p>Signal decisions and completed trades are recorded with cost breakdowns and risk context.</p></div>
    <section className="panel"><div className="panel-head"><div><div className="panel-title">Signals & rejections</div><div className="panel-subtitle">Rejected candidates include reasons</div></div><span className="count-pill">{data.signals.length} recent</span></div><SignalFeed signals={data.signals}/></section>
    <section className="panel"><div className="panel-head"><div><div className="panel-title">Completed trades</div><div className="panel-subtitle">Gross, fees, funding and net PnL</div></div></div><ActivityTable data={data}/></section>
  </div>;
}

function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [section, setSection] = useState<Section>('overview');
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [authNonce, setAuthNonce] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const dashboard = await apiRequest<DashboardData>('/api/dashboard');
      setData(dashboard);
      setAuthRequired(false);
      setLastUpdated(Date.now());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to load dashboard.';
      if (message === 'AUTH_REQUIRED') setAuthRequired(true);
      else setError(message);
    }
  }, [authNonce]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const listener = (event: Event) => {
      const target = (event as CustomEvent<Section>).detail;
      if (['overview', 'backtest', 'risk', 'activity'].includes(target)) setSection(target);
    };
    const authListener = () => setAuthRequired(true);
    window.addEventListener('royalusd-navigate', listener);
    window.addEventListener('royalusd-auth-required', authListener);
    return () => { window.removeEventListener('royalusd-navigate', listener); window.removeEventListener('royalusd-auth-required', authListener); };
  }, []);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(''), 6500);
    return () => window.clearTimeout(timer);
  }, [error]);

  const action = useCallback(async (path: string, body?: unknown) => {
    const actionKey = path.includes('start') ? 'start' : path.includes('pause') ? 'pause' : path.includes('resume') ? 'resume'
      : path.includes('live') ? 'live' : path.includes('emergency') ? 'emergency' : path.includes('cancel') ? 'cancel'
        : path.includes('compounding') ? 'compound' : path.includes('risk/reset') ? 'risk' : path.includes('stop') ? 'stop' : 'control';
    setLoading(actionKey);
    setError('');
    try {
      const response = await apiRequest<DashboardData>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
      if (response?.account) { setData(response); setLastUpdated(Date.now()); }
      else await refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Operator action failed.';
      if (message === 'AUTH_REQUIRED') setAuthRequired(true);
      else setError(message);
    } finally { setLoading(null); }
  }, [refresh]);

  const signIn = (value: string) => {
    sessionStorage.setItem('royalusd-operator-token', value);
    setAuthNonce((previous) => previous + 1);
  };
  const signOut = () => {
    sessionStorage.removeItem('royalusd-operator-token');
    setData(null);
    setAuthRequired(true);
  };

  const title = section === 'overview' ? 'Control center' : section === 'backtest' ? 'Backtesting' : section === 'risk' ? 'Risk & safety' : 'Trading activity';
  const initials = data?.mode === 'LIVE' ? 'LIVE' : 'PAPER';
  const select = (next: Section) => setSection(next);

  if (authRequired) return <LoginScreen onToken={signIn}/>;
  if (!data) return <div className="loading-screen"><div className="brand-mark"><Glyph name="crown" size={22}/></div><div className="loading-spinner"/><strong>Connecting to Royal USD</strong><span>{error || 'Loading operator console…'}</span>{error && <button className="button secondary" onClick={() => { setError(''); void refresh(); }}>Retry</button>}</div>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-lockup"><div className="brand-mark"><Glyph name="crown" size={20}/></div><div><strong>Royal USD</strong><small>FUTURES ENGINE</small></div></div>
      <div className="sidebar-section-label">WORKSPACE</div>
      <nav className="nav-list">
        <NavButton name="overview" label="Overview" active={section === 'overview'} onClick={() => select('overview')}/>
        <NavButton name="backtest" label="Backtesting" active={section === 'backtest'} onClick={() => select('backtest')}/>
        <NavButton name="shield" label="Risk & safety" active={section === 'risk'} onClick={() => select('risk')}/>
        <NavButton name="activity" label="Activity log" active={section === 'activity'} onClick={() => select('activity')}/>
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-live-card"><div className="live-card-head"><span className="live-dot"/>TRADING MODE</div><strong>{initials}</strong><span>{data.mode === 'PAPER' ? 'Simulated execution only' : 'Real exchange orders'}</span></div>
        <div className="sidebar-operator"><div className="operator-avatar">R</div><div><strong>Operator</strong><span>{data.mode === 'LIVE' ? 'Live account' : 'Paper environment'}</span></div><button className="icon-button" aria-label="Sign out" onClick={signOut}><Glyph name="settings" size={15}/></button></div>
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumbs"><span>Royal USD</span><i>/</i><strong>{title}</strong></div><div className="topbar-right">
        <div className={`connection-pill ${data.marketStream.connected ? 'on' : data.marketStream.connecting ? 'pending' : 'off'}`}><StatusDot status={data.status}/><span>{data.marketStream.connected ? 'MEXC connected' : data.marketStream.connecting ? 'Connecting to MEXC' : 'MEXC offline'}</span></div>
        <div className="mode-pill"><span className={data.mode === 'LIVE' ? 'live-dot' : 'paper-dot'}/>{data.mode}</div>
        <button className="icon-button top-refresh" onClick={() => void refresh()} aria-label="Refresh dashboard"><Glyph name="refresh" size={16}/></button>
        <span className="last-refresh">{lastUpdated ? shortTime(lastUpdated) : '—'}</span>
      </div></header>
      <div className="page-content" key={section}>
        {section === 'overview' && <>
          <div className="page-heading"><div><div className="eyebrow">MEXC FUTURES · 1-MINUTE SCANNER</div><h1>Control center</h1><p>Risk-first execution overview for your configured USDT perpetual contracts.</p></div><div className="heading-actions"><span className={`environment-badge ${data.mode.toLowerCase()}`}><i/>{data.mode === 'PAPER' ? 'PAPER ENVIRONMENT' : 'LIVE EXECUTION'}</span><span className="updated-label">Updated {shortTime(data.updatedAt)}</span></div></div>
          <Overview data={data} action={action} loading={loading}/>
        </>}
        {section === 'backtest' && <BacktestScreen/>}
        {section === 'risk' && <RiskScreen data={data} action={action} loading={loading}/>}
        {section === 'activity' && <ActivityScreen data={data}/>}
      </div>
      <footer className="app-footer"><span>Royal USD <i>·</i> MEXC Futures</span><span>Indicators run on completed 1-minute candles <i>·</i> No profit guarantee</span></footer>
    </main>
    {error && <div className="toast-error"><Glyph name="alert" size={17}/><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><Glyph name="close" size={15}/></button></div>}
  </div>;
}

export default App;
