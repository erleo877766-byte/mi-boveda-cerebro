let token = localStorage.getItem('cerebro_token') || '';
let currentTab = 'orders';
let editingNodeId = null;
let addressesBySymbolNetwork = new Map();

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['x-session-token'] = token;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && path !== '/api/v1/admin/login') {
    token = '';
    localStorage.removeItem('cerebro_token');
    showLogin();
    throw new Error('Sesión expirada');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
  return data;
}

function showLogin() {
  $('app-view').style.display = 'none';
  $('login-view').style.display = 'flex';
}
function showApp() {
  $('login-view').style.display = 'none';
  $('app-view').style.display = 'block';
  refreshAll();
  refreshGlobal();
  refreshErleoToggle();
}

// ============================================================
// Loading (overlay + barra superior)
// ============================================================
let busyCount = 0;
function setBusy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  const show = busyCount > 0;
  $('loading-overlay').style.display = show ? 'flex' : 'none';
  $('progress-bar').classList.toggle('active', show);
}
async function withBusy(fn) {
  setBusy(true);
  try { return await fn(); }
  finally { setBusy(false); }
}

// ============================================================
// Estado de conexión en vivo (punto parpadeante + latencia)
// ============================================================
let lastLatency = null;
async function refreshConnection() {
  const dot = $('conn-dot');
  const el = $('conn-status');
  try {
    const t0 = performance.now();
    const r = await fetch('/health', { headers: { 'x-session-token': token }, cache: 'no-store' });
    const ms = Math.round(performance.now() - t0);
    if (r.ok) {
      lastLatency = ms;
      el.textContent = ms > 2000 ? `Respondiendo lento · ${ms} ms` : `Conectado · ${ms} ms`;
      dot.className = 'dot ' + (ms > 2000 ? 'yellow' : 'green');
    } else {
      el.textContent = 'Sin conexión';
      dot.className = 'dot red';
    }
  } catch (e) {
    el.textContent = 'Sin conexión';
    dot.className = 'dot red';
  }
}

// ============================================================
// Estado global (pendientes, comisiones hoy, órdenes hoy)
// ============================================================
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }

async function refreshGlobal() {
  try {
    const [dash, orders] = await Promise.all([
      api('/api/v1/report/dashboard'),
      api('/api/v1/orders?limit=500'),
    ]);
    const today = startOfToday();
    $('pending-count').textContent = dash.summary.pending || 0;
    const badge = $('pending-count-badge');
    badge.textContent = dash.summary.pending ? dash.summary.pending + ' pendientes' : '';
    badge.style.display = dash.summary.pending ? '' : 'none';
    $('today-orders').textContent = (orders || []).filter((o) => new Date(o.createdAt) >= today).length;
    try {
      const rep = await api('/api/v1/report/commissions?from=' + encodeURIComponent(today.toISOString()));
      $('today-commissions').textContent = '$' + (rep.totals.totalCommissionUsd || 0).toFixed(2);
    } catch (_) {}
  } catch (e) { /* silencioso */ }
}

// ============================================================
// Toggle Erleo
// ============================================================
async function refreshErleoToggle() {
  try {
    const enabled = await api('/api/v1/settings/erleo-enabled');
    const btn = $('erleo-toggle');
    if (enabled) {
      btn.textContent = '🟢 Activar intercambios';
      btn.className = 'btn btn-erleo-on';
    } else {
      btn.textContent = '🔴 Detener intercambios';
      btn.className = 'btn btn-erleo-off';
    }
  } catch (e) { /* silencioso */ }
}

async function setErleoEnabled(enabled) {
  await api('/api/v1/settings/erleo-enabled', {
    method: 'POST', body: JSON.stringify({ enabled }),
  });
  toast(enabled ? 'Intercambios Erleo ACTIVADOS. La app vuelve a ofrecerlos.' : 'Intercambios Erleo DETENIDOS. La app usa solo ChangeNOW.');
  refreshErleoToggle();
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
function fmtAmount(n) {
  const num = Number(n);
  if (isNaN(num)) return '—';
  if (num === 0) return '0';
  return num.toPrecision(8).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
function speedPill(s) { return `<span class="speed-pill speed-${esc(s)}">${esc(s)}</span>`; }
function statusPill(s) { return `<span class="status-pill status-${esc(s)}">${esc(s)}</span>`; }
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('es', { dateStyle: 'short', timeStyle: 'medium' });
}
function fmtTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function shortAddr(a) {
  if (!a) return '—';
  return `<span class="addr-chip" title="${esc(a)}">${esc(a.slice(0, 16))}…${esc(a.slice(-8))}</span>`;
}

// ============================================================
// Gráficos SVG (barras por día, sin dependencias externas)
// ============================================================
let chartSeq = 0;

function lastNDays(n) {
  const out = [];
  const today = startOfToday();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    out.push(d);
  }
  return out;
}
function dayLabel(d) { return d.toLocaleDateString('es', { day: '2-digit', month: '2-digit' }); }
function dailySeries(items, valueOf, n = 14) {
  return lastNDays(n).map((d) => {
    const next = new Date(d); next.setDate(next.getDate() + 1);
    let sum = 0;
    for (const it of items) {
      const t = new Date(it.createdAt);
      if (t >= d && t < next) sum += valueOf(it);
    }
    return { label: dayLabel(d), value: Math.round(sum * 100) / 100 };
  });
}

function svgBarChart(items, opts = {}) {
  const {
    height = 150, barW = 30, gap = 16,
    colorA = '#00D4FF', colorB = '#7B2FFD',
    fmt = (v) => String(v),
  } = opts;
  const max = Math.max(1, ...items.map((i) => i.value));
  const n = items.length || 0;
  const width = n * (barW + gap) + gap;
  const gid = 'g' + (++chartSeq);
  const top = 20, bottom = 24;
  const hScale = height - top - bottom;
  let rects = '', labels = '', values = '', grid = '';
  for (let g = 1; g <= 4; g++) {
    const gy = top + (hScale / 4) * g;
    grid += `<line x1="0" y1="${gy}" x2="${width}" y2="${gy}" stroke="rgba(255,255,255,.045)" stroke-dasharray="3 5"/>`;
  }
  items.forEach((it, i) => {
    const x = gap + i * (barW + gap);
    const h = it.value > 0 ? Math.max(4, (it.value / max) * hScale) : 0;
    const y = top + hScale - h;
    const fill = it.value > 0 ? `url(#${gid})` : 'rgba(139,145,167,.16)';
    rects += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="${Math.min(7, barW / 2)}" fill="${fill}"><title>${it.label}: ${fmt(it.value)}</title></rect>`;
    labels += `<text x="${x + barW / 2}" y="${height - 7}" text-anchor="middle" font-size="9" fill="#6a7088">${it.label}</text>`;
    if (it.value > 0) values += `<text x="${x + barW / 2}" y="${y - 6}" text-anchor="middle" font-size="9.5" fill="${colorA}" font-weight="700">${fmt(it.value)}</text>`;
  });
  return `<div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMinYMin meet">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${colorA}" stop-opacity=".95"/><stop offset="1" stop-color="${colorB}" stop-opacity=".72"/></linearGradient></defs>
    ${grid}${rects}${values}${labels}
  </svg></div>`;
}

// ============================================================
// Órdenes (tabla con detalle expandible)
// ============================================================
function orderDetailHTML(o, reservesMap, isApproved) {
  let reserveAddr = '';
  if (isApproved) {
    const r = reservesMap[o.fromSymbol];
    reserveAddr = r ? r.address : '';
  }
  const cells = [];
  cells.push(`<div><span class="k">De</span><span class="v">${fmtAmount(o.fromAmount)} ${esc(o.fromSymbol)}${o.fromNetwork ? ' (' + esc(o.fromNetwork) + ')' : ''}</span></div>`);
  cells.push(`<div><span class="k">A</span><span class="v">${esc(o.toSymbol)}${o.toNetwork ? ' (' + esc(o.toNetwork) + ')' : ''}</span></div>`);
  cells.push(`<div><span class="k">Dirección destino del usuario</span><span class="v">${shortAddr(o.toAddress)}${o.toExtraId ? ' · ' + esc(o.toExtraId) : ''}</span></div>`);
  if (o.userLabel) cells.push(`<div><span class="k">Usuario</span><span class="v">${esc(o.userLabel)}</span></div>`);
  if (isApproved && reserveAddr) cells.push(`<div><span class="k">Envía desde (tu reserva ${esc(o.fromSymbol)})</span><span class="v">${shortAddr(reserveAddr)}</span></div>`);
  if (o.commissionUsd) cells.push(`<div><span class="k">Comisión</span><span class="v">$${Number(o.commissionUsd).toFixed(2)} USD${o.commissionAmount ? ' · ' + fmtAmount(o.commissionAmount) + ' ' + esc(o.fromSymbol) : ''}</span></div>`);
  if (o.netToAmount) cells.push(`<div><span class="k">Monto neto a entregar</span><span class="v">${fmtAmount(o.netToAmount)} ${esc(o.toSymbol)}</span></div>`);
  if (o.completedAt) cells.push(`<div><span class="k">Completada</span><span class="v">${fmtDate(o.completedAt)}</span></div>`);
  if (o.rejectedAt) cells.push(`<div><span class="k">Rechazada</span><span class="v">${fmtDate(o.rejectedAt)}</span></div>`);
  if (o.cancelledReason) cells.push(`<div><span class="k">Motivo</span><span class="v">${esc(o.cancelledReason)}</span></div>`);
  if (o.adminNote) cells.push(`<div><span class="k">Nota</span><span class="v">${esc(o.adminNote)}</span></div>`);

  let extra = '';
  if (isApproved) {
    extra = `
      <div class="tx-box">
        <input class="input" placeholder="Hash envío al usuario (opcional)" id="txp-${esc(o.id)}">
        <input class="input" placeholder="Hash recepción del usuario (opcional)" id="txr-${esc(o.id)}">
        <button class="btn btn-primary" data-action="complete" data-id="${esc(o.id)}">✔ Marcar completada</button>
      </div>`;
  }
  return `<div class="detail-grid">${cells.join('')}</div>${extra}`;
}

function orderTable(orders, reservesMap) {
  if (!orders.length) return '<div class="empty"><span class="big">✨</span>No hay nada por aquí todavía</div>';
  const rows = orders.map((o) => {
    const isPending = o.status === 'pending';
    const isApproved = o.status === 'approved';
    const actions = [
      `<button class="btn btn-ghost btn-sm" data-action="toggle-detail" data-id="${esc(o.id)}">Ver</button>`,
    ];
    if (isPending) {
      actions.push(`<button class="btn btn-primary btn-sm" data-action="approve" data-id="${esc(o.id)}">Aprobar</button>`);
      actions.push(`<button class="btn btn-danger btn-sm" data-action="reject" data-id="${esc(o.id)}">Rechazar</button>`);
    }
    return `
      <tr>
        <td style="white-space:nowrap">${fmtDate(o.createdAt)}</td>
        <td><b>${esc(o.fromSymbol)}</b> → <b>${esc(o.toSymbol)}</b></td>
        <td>${fmtAmount(o.fromAmount)} ${esc(o.fromSymbol)}</td>
        <td>${shortAddr(o.toAddress)}</td>
        <td>${speedPill(o.speed)}</td>
        <td>${statusPill(o.status)}</td>
        <td><div class="actions-cell">${actions.join('')}</div></td>
      </tr>
      <tr class="detail-row" id="detail-${esc(o.id)}" style="display:none">
        <td colspan="7">${orderDetailHTML(o, reservesMap, isApproved)}</td>
      </tr>`;
  }).join('');
  return `<div class="table-card"><div class="table-scroll"><table class="table">
    <thead><tr><th>Fecha</th><th>Operación</th><th>Monto</th><th>Destino</th><th>Velocidad</th><th>Estado</th><th>Acciones</th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>`;
}

async function refreshOrders() {
  const [dashboard, recent, addresses] = await Promise.all([
    api('/api/v1/report/dashboard'),
    api('/api/v1/orders?limit=500'),
    api('/api/v1/coin-addresses'),
  ]);
  const reservesMap = {};
  for (const r of addresses) if (!reservesMap[r.symbol]) reservesMap[r.symbol] = r;

  const pending = dashboard.pending || [];
  $('pending-count-badge').textContent = pending.length ? pending.length + ' pendientes' : '';
  $('pending-count-badge').style.display = pending.length ? '' : 'none';
  $('pending-list').innerHTML = orderTable(pending, reservesMap);

  // Historial: todo lo que NO está pending.
  const hist = (recent || []).filter((o) => o.status !== 'pending');
  const histSeries = dailySeries(hist, () => 1, 14);
  const histTotal = histSeries.reduce((a, b) => a + b.value, 0);
  $('history-chart').innerHTML = `
    <div class="chart-card">
      <div class="chart-title"><h3>Órdenes por día · últimos 14 días</h3><span>${histTotal} en total</span></div>
      ${svgBarChart(histSeries, { fmt: (v) => String(v), colorA: '#00D4FF', colorB: '#7B2FFD' })}
      <div class="chart-legend"><span><i style="background:linear-gradient(90deg,#00D4FF,#7B2FFD)"></i>Órdenes</span></div>
    </div>`;
  $('history-list').innerHTML = orderTable(hist, reservesMap);

  // Estado global (sin duplicar llamadas pesadas).
  const today = startOfToday();
  $('pending-count').textContent = dashboard.summary.pending || 0;
  $('today-orders').textContent = (recent || []).filter((o) => new Date(o.createdAt) >= today).length;
  try {
    const rep = await api('/api/v1/report/commissions?from=' + encodeURIComponent(today.toISOString()));
    $('today-commissions').textContent = '$' + (rep.totals.totalCommissionUsd || 0).toFixed(2);
  } catch (_) {}
}

// ============================================================
// Direcciones de cobro por moneda y red (coin_addresses)
// Rediseño: tarjeta por moneda con logo + redes con campos inline.
// ============================================================
const COIN_COLORS = {
  BTC: '#F7931A', XMR: '#FF6B3D', ETH: '#627EEA', USDT: '#26A17B',
  USDC: '#2775CA', XNO: '#4A90D9', BAN: '#1AAC54', LTC: '#345D9D',
  DOGE: '#C2A633', TRX: '#EF0027', SOL: '#9945FF', POL: '#8247E5',
  XRP: '#23292F', ADA: '#0033AD', DASH: '#1C75BC', ZEC: '#F4B728',
  BCH: '#8DC351', DCR: '#2ED6A1', XHV: '#F44336', ZANO: '#4C8BF5',
  WOW: '#FFD166', FIRO: '#FF9D00', SC: '#2DF7C5', XVG: '#00C5E0',
  RVN: '#384182', STX: '#5546FF', NEAR: '#00C08B', AAVE: '#2EBAC6',
  UNI: '#FF007A', SHIB: '#FFA409', PEPE: '#3FA96B', LINK: '#2A5ADA',
  ARB: '#28A0F0', OP: '#FF0420', BNB: '#F3BA2F', BASE: '#0052FF',
  MATIC: '#8247E5', RUNE: '#00C1E0', FTM: '#1969FF', KAS: '#5EC2E0',
  TON: '#0098EA', HBAR: '#0074FF', EOS: '#D1D1D1', XLM: '#8F9BB3',
  KMD: '#326464', PIVX: '#3D3D3D', ZEN: '#1B1B1B', CRO: '#002D74',
  COMP: '#00D395', ENS: '#5FB1F0', GRT: '#6747ED', BAT: '#FF5000',
  MANA: '#FF2D55', STORJ: '#2683FF', OXT: '#3C78C6', GTC: '#EB8D00',
  LDO: '#FFD75C', DYDX: '#6966FF', CAKE: '#D1884F', GUSD: '#00DCFA',
  FRAX: '#000000', TUSD: '#2F3438', USDE: '#0BDB6D', APE: '#024BC2',
  BTT: '#05DB75', BTTC: '#05DB75', DEPS: '#4A4A4A', NDEPS: '#333333',
  DEURO: '#00A7E1', DGB: '#0066CC', SCRT: '#202124', STETH: '#00A3FF',
  WETH: '#627EEA', WBTC: '#F7931A', DAI: '#F5AC37', PAXG: '#D9A23D',
  MKR: '#1AAB9B', APT: '#00C4A8', SUI: '#4DA2FF', SEI: '#7B3FE4',
};
const COIN_FALLBACK_PALETTE = ['#00D4FF', '#7B2FFD', '#00C853', '#FFAB00', '#FF5252', '#3AA0FF', '#FF6EC7', '#39E6A3', '#FF8A65', '#7C4DFF'];

function coinColor(symbol) {
  const s = String(symbol || 'X').toUpperCase();
  if (COIN_COLORS[s]) return COIN_COLORS[s];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return COIN_FALLBACK_PALETTE[h % COIN_FALLBACK_PALETTE.length];
}

function coinLogo(symbol) {
  const s = String(symbol || '?').toUpperCase();
  return `<span class="coin-logo" style="--coin:${coinColor(s)}">${esc(s.slice(0, 1))}</span>`;
}

function netPill(network) {
  return network
    ? `<span class="pill pill-cyan">${esc(network)}</span>`
    : '<span class="pill pill-purple">Principal</span>';
}

function networkRowHTML(symbol, network, r) {
  const isConfigured = !!r;
  const balanceText = isConfigured && r.onchainBalance != null
    ? fmtAmount(r.onchainBalance)
    : '';
  const val = (f) => esc(r ? (r[f] ?? '') : '');
  return `
    <div class="network-row" data-symbol="${esc(symbol)}" data-network="${esc(network)}">
      <div class="net-head">
        ${netPill(network)}
        <span class="net-balance">${balanceText}</span>
      </div>
      <div class="net-fields">
        <label class="field"><span>Cobro de comisión</span>
          <input class="input net-in" data-f="address" value="${val('address')}" placeholder="Donde llegan tus comisiones">
        </label>
        <label class="field"><span>Dirección de reserva — Envíos manuales</span>
          <input class="input net-in" data-f="payoutAddress" value="${val('payoutAddress')}" placeholder="Desde dónde envías al usuario">
        </label>
      </div>
      <div class="net-actions">
        <div class="actions-cell">
          <button class="btn btn-primary btn-sm" data-action="save-coin-net">Guardar</button>
        </div>
      </div>
    </div>`;
}

function coinCardHTML(symbol, configuredNetworks, knownNetworks) {
  const nets = [...new Set([...knownNetworks, ...configuredNetworks])];
  const rows = nets.map((net) => {
    const r = addressesBySymbolNetwork.get(symbol + '|' + net);
    return networkRowHTML(symbol, net, r);
  }).join('');
  const hasConfig = configuredNetworks.length > 0;
  const status = hasConfig
    ? '<span class="status-pill status-completed">Configurada</span>'
    : '<span class="status-pill status-rejected">Sin configurar</span>';
  return `
    <div class="coin-card">
      <div class="coin-card-head">
        ${coinLogo(symbol)}
        <div class="coin-title"><b>${esc(symbol)}</b></div>
        ${status}
      </div>
      <div class="coin-networks">${rows}</div>
    </div>`;
}

async function refreshReserves() {
  const [addresses, networks] = await Promise.all([
    api('/api/v1/coin-addresses'),
    api('/api/v1/settings/coin-networks'),
  ]);
  addressesBySymbolNetwork = new Map();
  for (const a of addresses) addressesBySymbolNetwork.set(a.symbol + '|' + (a.network || ''), a);

  const knownNetworks = networks.networks || {};
  const configured = {};
  for (const a of addresses) (configured[a.symbol] = configured[a.symbol] || []).push(a.network || '');

  let symbols = (networks.symbols || []).slice();
  for (const s of Object.keys(configured)) if (!symbols.includes(s)) symbols.push(s);
  symbols = symbols.sort();

  const q = ($('coin-search')?.value || '').trim().toUpperCase();
  const filtered = q ? symbols.filter((s) => s.includes(q)) : symbols;
  $('coin-count').textContent = filtered.length + ' de ' + symbols.length + ' monedas';

  if (!filtered.length) {
    $('reserve-list').innerHTML = '<div class="empty"><span class="big">🔍</span>No hay monedas que coincidan con la búsqueda.</div>';
    return;
  }
  $('reserve-list').innerHTML = filtered
    .map((s) => coinCardHTML(s, configured[s] || [], knownNetworks[s] || ['']))
    .join('');
}

// ============================================================
// Comisiones Erleo: resumen + gráfico + % por moneda
// ============================================================
let coinPercentCache = null;
let coinSymbolList = null;

async function refreshReports() {
  const [rep, evts] = await Promise.all([
    api('/api/v1/report/commissions'),
    api('/api/v1/report/commissions?limit=2000'),
  ]);
  $('report-totals').innerHTML = `
    <div class="total-card"><div class="k">Órdenes procesadas</div><div class="v">${rep.totals.count}</div></div>
    <div class="total-card"><div class="k">Total comisiones</div><div class="v">$${rep.totals.totalCommissionUsd.toFixed(2)}</div></div>
    <div class="total-card"><div class="k">Ahorro fees proveedor</div><div class="v">$${rep.totals.totalProviderFeeSavedUsd.toFixed(2)}</div></div>`;

  const series = dailySeries(evts.events || [], (e) => e.commissionUsd || 0, 14);
  const total = series.reduce((a, b) => a + b.value, 0);
  $('report-chart').innerHTML = `
    <div class="chart-card">
      <div class="chart-title"><h3>Comisiones por día · últimos 14 días</h3><span>$${total.toFixed(2)} en total</span></div>
      ${svgBarChart(series, { fmt: (v) => '$' + v.toFixed(2), colorA: '#00C853', colorB: '#7B2FFD' })}
      <div class="chart-legend"><span><i style="background:linear-gradient(90deg,#00C853,#7B2FFD)"></i>Comisiones USD</span></div>
    </div>`;
  await renderCoinCommissionTable();
}

async function ensureCoinMeta() {
  if (coinSymbolList) return;
  const nets = await api('/api/v1/settings/coin-networks');
  coinSymbolList = nets.symbols;
  coinPercentCache = await api('/api/v1/settings/coin-commissions');
}

async function renderCoinCommissionTable() {
  await ensureCoinMeta();
  const saved = coinPercentCache || {};
  const row = (s) => `
    <tr>
      <td><b>${esc(s)}</b></td>
      <td>
        <div style="display:flex;align-items:center;gap:8px;max-width:180px">
          <input type="number" step="any" min="0" max="100" class="input coin-pct" data-symbol="${esc(s)}"
            value="${(saved[s] || 0)}">
          <span style="color:var(--muted);font-weight:700">%</span>
        </div>
      </td>
    </tr>`;
  const tbody = coinSymbolList.map(row).join('');
  $('coin-commission-list').innerHTML = `
    <div class="section-head" style="margin-top:20px">
      <h3>Comisión % por moneda</h3>
      <button id="save-coin-commissions" class="btn btn-primary">Guardar todas</button>
    </div>
    <div class="table-card" style="margin-top:10px"><div class="table-scroll">
      <table class="table"><thead><tr><th>Moneda</th><th>% de comisión</th></tr></thead>
      <tbody>${tbody}</tbody></table>
    </div></div>`;
  $('save-coin-commissions').addEventListener('click', async () => {
    const inputs = document.querySelectorAll('.coin-pct');
    const toSave = [];
    for (const inp of inputs) {
      const val = parseFloat(inp.value);
      if (isNaN(val) || val < 0) continue;
      if (val !== (saved[inp.dataset.symbol] || 0)) {
        toSave.push({ symbol: inp.dataset.symbol, percent: val });
      }
    }
    if (!toSave.length) { toast('No hay cambios que guardar'); return; }
    let savedCount = 0;
    for (const item of toSave) {
      await api('/api/v1/settings/coin-commissions', { method: 'POST', body: JSON.stringify(item) });
      savedCount++;
    }
    coinPercentCache = await api('/api/v1/settings/coin-commissions');
    $('coin-commission-status').textContent = `${savedCount} comisiones guardadas en la nube.`;
    toast(`${savedCount} comisiones por moneda guardadas ✅`);
  });
}

// ============================================================
// Comisiones USD + porcentaje
// ============================================================
async function refreshCommissions() {
  try {
    const usd = await api('/api/v1/settings/commissions-usd');
    $('usd-slow').value = usd.slow;
    $('usd-medium').value = usd.medium;
    $('usd-fast').value = usd.fast;
    await updateConversion();
  } catch (e) { /* silencioso */ }
  try {
    const { percent } = await api('/api/v1/settings/commission-percent');
    $('commission-percent').value = percent;
    $('commission-status').textContent = percent > 0
      ? `Comisión actual: ${percent}% del intercambio. Se descuenta del monto que recibe el usuario.`
      : 'Comisión porcentual desactivada. Se usa la comisión fija por velocidad de arriba.';
  } catch (e) { /* silencioso */ }
}

let conversionSymbol = '';
async function currentSymbolForConversion() {
  const input = $('usd-convert-symbol');
  if (input && input.value.trim()) return input.value.trim().toUpperCase();
  if (conversionSymbol) return conversionSymbol;
  try {
    const addresses = await api('/api/v1/coin-addresses');
    if (addresses.length) {
      conversionSymbol = addresses[0].symbol;
      if (input) input.value = conversionSymbol;
      const dl = $('reserve-symbols');
      if (dl) dl.innerHTML = addresses.map((r) => `<option value="${esc(r.symbol)}">`).join('');
    }
  } catch (e) { /* silencioso */ }
  return conversionSymbol;
}

async function updateConversion() {
  const sym = (await currentSymbolForConversion() || '').toUpperCase();
  if (!sym) return;
  const usd = {
    slow: parseFloat($('usd-slow').value),
    medium: parseFloat($('usd-medium').value),
    fast: parseFloat($('usd-fast').value),
  };
  try {
    const rep = await api(`/api/v1/report/dashboard`);
    const coin = (rep.balances || []).find((b) => b.symbol === sym);
    if (!coin || coin.priceUsd == null) return;
    const p = coin.priceUsd;
    const box = $('commissions-conversion');
    box.style.display = 'block';
    box.innerHTML = `
      <b>Conversión a ${esc(sym)} (precio $${p.toFixed(8)}):</b>
      <div class="speed-config" style="margin-top:10px">
        <div class="speed-config-row"><span class="speed-icon">🐢</span><span class="speed-name" style="flex:1">Lento</span><span style="font-weight:700">${fmtAmount((usd.slow || 0) / p)} ${esc(sym)}</span><span class="speed-usd">$${(usd.slow || 0).toFixed(2)}</span></div>
        <div class="speed-config-row"><span class="speed-icon">🚶</span><span class="speed-name" style="flex:1">Normal</span><span style="font-weight:700">${fmtAmount((usd.medium || 0) / p)} ${esc(sym)}</span><span class="speed-usd">$${(usd.medium || 0).toFixed(2)}</span></div>
        <div class="speed-config-row"><span class="speed-icon">⚡</span><span class="speed-name" style="flex:1">Rápido</span><span style="font-weight:700">${fmtAmount((usd.fast || 0) / p)} ${esc(sym)}</span><span class="speed-usd">$${(usd.fast || 0).toFixed(2)}</span></div>
      </div>`;
  } catch (e) { /* silencioso */ }
}

// ============================================================
// Nodos
// ============================================================
function nodeStatus(n) {
  if (!n.enabled) return '<span class="node-status node-down">Desactivado</span>';
  if (n.latencyMs <= 0) return '<span class="node-status node-online">Sin medir</span>';
  if (!n.lastCheck || !n.coverage) return '<span class="node-status node-online">Nuevo</span>';
  if (n.latencyMs <= 400) return '<span class="node-status node-online">Rápido</span>';
  if (n.latencyMs <= 2000) return '<span class="node-status node-slow">Lento</span>';
  return '<span class="node-status node-down">Sin conexión</span>';
}

function coverageBar(n) {
  const pct = Math.max(0, Math.min(100, Math.round(n.coverage || 0)));
  const bars = Math.round(pct / 20); // 0..5 barritas de señal
  let html = '<span class="signal">';
  for (let i = 1; i <= 5; i++) {
    html += `<i class="${i <= bars ? 'on' : ''}"></i>`;
  }
  html += `</span>${pct}%`;
  return html;
}

function resetNodeForm() {
  $('node-form').reset();
  $('n-id').value = '';
  $('n-enabled').checked = true;
  $('n-autoswitch').checked = true;
  editingNodeId = null;
  $('node-form').querySelector('button[type=submit]').textContent = 'Agregar nodo';
  $('n-cancel-edit').style.display = 'none';
}

function fillNodeForm(n) {
  $('n-id').value = n.id;
  $('n-symbol').value = n.symbol;
  $('n-name').value = n.name || '';
  $('n-uri').value = n.uri;
  $('n-enabled').checked = n.enabled;
  $('n-trusted').checked = n.trusted;
  $('n-official').checked = n.isOfficial;
  $('n-default').checked = n.isDefault;
  $('n-autoswitch').checked = n.autoSwitch;
  editingNodeId = n.id;
  $('node-form').querySelector('button[type=submit]').textContent = 'Guardar cambios';
  $('n-cancel-edit').style.display = 'inline-block';
  $('tab-nodes').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function refreshNodes() {
  const nodes = await api('/api/v1/nodes');
  if (!nodes.length) {
    $('node-list').innerHTML = '<div class="empty"><span class="big">🌐</span>No hay nodos. Agrega uno con el formulario de arriba.</div>';
    return;
  }
  const bySymbol = {};
  for (const n of nodes) (bySymbol[n.symbol] = bySymbol[n.symbol] || []).push(n);

  let html = '';
  for (const symbol of Object.keys(bySymbol).sort()) {
    const list = bySymbol[symbol];
    const rows = list.map((n) => `
      <tr>
        <td><b>${esc(n.name)}</b>${n.isOfficial ? '<span class="pill pill-cyan" style="margin-left:6px">Oficial</span>' : ''}</td>
        <td class="mono" style="font-size:12px;color:var(--muted)">${esc(n.uri)}</td>
        <td>${nodeStatus(n)}</td>
        <td>${coverageBar(n)}</td>
        <td><div class="actions-cell">
          <button class="btn btn-ghost btn-sm" data-action="edit-node" data-id="${n.id}">Editar</button>
          ${n.isOfficial
            ? '<span class="btn btn-ghost btn-sm" style="opacity:.55;cursor:not-allowed" title="Los nodos oficiales no se pueden eliminar">🔒 No eliminar</span>'
            : `<button class="btn btn-danger btn-sm" data-action="del-node" data-id="${n.id}">Eliminar</button>`}
        </div></td>
      </tr>`).join('');
    html += `
      <h3>${esc(symbol)}</h3>
      <div class="table-card"><div class="table-scroll"><table class="table"><thead><tr>
        <th>Nombre</th><th>URL</th><th>Estado</th><th>Cobertura</th><th>Acciones</th>
      </tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }
  $('node-list').innerHTML = html;
}

async function syncCakeNodes() {
  const btn = $('sync-cake-btn');
  if (!btn) return;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Sincronizando…';
  try {
    const r = await api('/api/v1/nodes/sync-cake', { method: 'POST', body: '{}' });
    toast(`Nodos de Cake Wallet: ${r.files} listas, ${r.imported} nodos nuevos`);
    refreshNodes();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ============================================================
// Mercado: precios en vivo + conversor cripto <-> USD
// ============================================================
let marketPrices = [];   // [{ symbol, price }]
let marketSymbols = [];
let lastMarketTs = 0;
let marketPrev = {};     // symbol -> ultimo precio de la pasada anterior (para colores)

async function refreshMarket(force = false) {
  if (!force && Date.now() - lastMarketTs < 10_000) return marketPrices;
  try {
    const rep = await api('/api/v1/market/prices');
    marketPrev = {};
    marketPrices.forEach((p) => { marketPrev[p.symbol] = p.price; });
    marketPrices = rep.prices || [];
    marketSymbols = marketPrices.map((p) => p.symbol);
    lastMarketTs = Date.now();
    renderMarket();
    updateMarketConverter();
    return marketPrices;
  } catch (e) {
    if (marketPrices.length) {
      $('market-status').textContent = 'Último precio conocido (sin conexión)';
      $('market-status').className = 'pill pill-warn';
    }
    throw e;
  }
}

function renderMarket() {
  const body = $('market-tbody');
  if (!body) return;
  const withPrice = marketPrices.filter((p) => p.price != null);
  const noPrice = marketPrices.filter((p) => p.price == null);
  const fresh = withPrice.length;
  const status = $('market-status');
  status.textContent = `${fresh} de ${marketPrices.length} con precio · Actualizado: ${fmtTime(new Date(lastMarketTs))}`;
  status.className = fresh === 0
    ? 'pill pill-err'
    : noPrice.length
        ? 'pill pill-warn'
        : 'pill pill-cyan';
  const rows = withPrice.map((p) => {
    const prev = marketPrev[p.symbol];
    let cls = 'market-flat';
    let arrow = '·';
    if (prev != null && p.price != null) {
      if (p.price > prev) { cls = 'market-up'; arrow = '▲'; }
      else if (p.price < prev) { cls = 'market-down'; arrow = '▼'; }
    }
    return `
    <tr>
      <td><b>${esc(p.symbol)}</b></td>
      <td class="mono ${cls}">${arrow} $${formatPrice(p.price)}</td>
      <td><span class="status-pill status-completed">En vivo</span></td>
    </tr>`;
  }).join('');
  const noRows = noPrice.map((p) => `
    <tr>
      <td><b>${esc(p.symbol)}</b></td>
      <td class="mono" style="color:var(--muted)">· —</td>
      <td><span class="status-pill status-flat">Sin par</span></td>
    </tr>`).join('');
  body.innerHTML = rows + noRows;
}

function formatPrice(p) {
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}

function marketPriceFor(symbol) {
  const p = marketPrices.find((x) => x.symbol === symbol);
  return p && p.price != null ? p.price : null;
}

async function updateMarketConverter() {
  const sym = ($('mkt-symbol')?.value || '').trim().toUpperCase();
  const price = sym ? marketPriceFor(sym) : null;
  const cryptoEl = $('mkt-crypto');
  const usdEl = $('mkt-usd');
  const resultEl = $('mkt-result');
  if (!cryptoEl || !usdEl) return;
  if (!sym) { resultEl.textContent = ''; return; }
  if (!price) {
    resultEl.textContent = `No hay precio disponible para ${esc(sym)}.`;
    return;
  }
  const cryptoVal = parseFloat(cryptoEl.value);
  const usdVal = parseFloat(usdEl.value);
  const focus = document.activeElement;
  if (cryptoVal > 0 && (focus === cryptoEl || (!usdVal && focus === usdEl))) {
    usdEl.value = (cryptoVal * price).toFixed(2);
    resultEl.textContent = `${cryptoVal} ${esc(sym)} ≈ $${(cryptoVal * price).toFixed(2)} USD`;
  } else if (usdVal > 0) {
    cryptoEl.value = (usdVal / price).toPrecision(8);
    resultEl.textContent = `$${usdVal.toFixed(2)} USD ≈ ${(usdVal / price).toPrecision(8)} ${esc(sym)}`;
  } else {
    resultEl.textContent = `1 ${esc(sym)} = $${formatPrice(price)}`;
  }
}

// ============================================================
// Monedas personalizadas
// ============================================================
let ccLogoData = '';

const CC_NETWORK_LABELS = {
  nano: 'Nano', bitcoin: 'Bitcoin', ethereum: 'Ethereum (ERC20)', erc20: 'ERC20',
  bep20: 'BSC (BEP20)', base: 'Base', arbitrum: 'Arbitrum', polygon: 'Polygon',
  tron: 'Tron', trc20: 'TRC20', solana: 'Solana', custom: 'Otra',
};

function resetCoinForm() {
  $('coin-form').reset();
  $('cc-id').value = '';
  $('cc-contract').closest('.field').style.display = '';
  $('cc-submit').textContent = 'Guardar moneda';
  $('cc-cancel').style.display = 'none';
  ccLogoData = '';
}

function fillCoinForm(c) {
  $('cc-id').value = c.id;
  $('cc-name').value = c.name;
  $('cc-symbol').value = c.symbol;
  $('cc-network').value = c.network;
  $('cc-contract').value = c.contractAddress;
  $('cc-fee').value = c.feeAddress;
  $('cc-reserve').value = c.reserveAddress;
  $('cc-nodes').value = (c.nodes || []).map((n) => n.uri).join('\n');
  ccLogoData = c.logo || '';
  const isEvmOrTrc = ['ethereum', 'erc20', 'bep20', 'base', 'arbitrum', 'polygon', 'trc20'].includes(c.network);
  $('cc-contract').closest('.field').style.display = isEvmOrTrc ? '' : 'none';
  $('cc-submit').textContent = 'Guardar cambios';
  $('cc-cancel').style.display = 'inline-block';
  $('cc-symbol').focus();
}

async function refreshCustomCoins() {
  try {
    const { coins } = await api('/api/v1/admin/coins/custom');
    renderCustomCoins(coins);
  } catch (e) { /* silencioso */ }
}

function coinRowHtml(c) {
  const logo = c.logo
    ? `<img src="${esc(c.logo)}" alt="" style="width:28px;height:28px;border-radius:50%;object-fit:cover;margin-right:8px">`
    : `<span class="coin-avatar" style="margin-right:8px">${esc(c.symbol.slice(0, 1))}</span>`;
  const addr = (a) => a
    ? `<code class="mono" style="font-size:11px">${esc(a)}</code>`
    : '<span style="color:#8b93a7;font-size:11px">—</span>';
  return `
    <div class="coin-card">
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
        ${logo}
        <b style="font-size:15px">${esc(c.symbol)}</b>
        <span style="color:#8b93a7;font-size:13px">${esc(c.name)}</span>
        <span class="pill ${c.enabled ? 'pill-green' : 'pill-gray'}">${c.enabled ? 'Activa' : 'Desactivada'}</span>
        <span class="pill pill-cyan">${CC_NETWORK_LABELS[c.network] || c.network}</span>
      </div>
      <div class="card-sub" style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:4px 16px">
        <span>Cobro:</span><span>${addr(c.feeAddress)}</span>
        <span>Reserva:</span><span>${addr(c.reserveAddress)}</span>
        ${c.contractAddress ? `<span>Contrato:</span><span>${addr(c.contractAddress)}</span>` : ''}
      </div>
      <div style="display:flex;gap:6px;margin-top:10px">
        <button class="btn btn-ghost" data-action="toggle-coin" data-id="${c.id}" data-enabled="${c.enabled ? '1' : '0'}">${c.enabled ? 'Desactivar' : 'Activar'}</button>
        <button class="btn btn-ghost" data-action="edit-coin" data-id="${c.id}">Editar</button>
        <button class="btn btn-danger" data-action="del-coin" data-id="${c.id}">Eliminar</button>
      </div>
    </div>`;
}

function renderCustomCoins(coins) {
  const box = $('custom-coin-list');
  if (!coins || !coins.length) {
    box.innerHTML = '<div class="empty"><span class="big">🪙</span>Todavía no hay monedas personalizadas. Agrega la primera con el formulario de arriba.</div>';
    return;
  }
  box.innerHTML = `<div class="coin-grid">${coins.map(coinRowHtml).join('')}</div>`;
}

// ============================================================
// Notificaciones
// ============================================================
async function refreshNotifications() {  try {
    const { notifications } = await api('/api/v1/notifications?after=0');
    if (!notifications.length) {
      $('notif-list').innerHTML = '<div class="empty"><span class="big">🔔</span>Todavía no enviaste notificaciones.</div>';
      return;
    }
    const rows = notifications.slice(-20).reverse().map((n) => `
      <div class="notif-item">
        <span class="n-icon">🔔</span>
        <div style="flex:1">
          <div style="font-weight:700;font-size:14px">${esc(n.title)} <span class="pill pill-cyan" style="margin-left:8px">${fmtDate(n.createdAt)}</span></div>
          ${n.body ? `<div class="card-sub">${esc(n.body)}</div>` : ''}
        </div>
      </div>`).join('');
    $('notif-list').innerHTML = rows;
  } catch (e) { /* silencioso */ }
}

async function sendNotification() {
  const title = $('notif-title').value.trim();
  if (!title) { $('notif-status').textContent = 'Escribe un título para la notificación.'; return; }
  const body = $('notif-body').value.trim();
  const btn = $('notif-send');
  btn.disabled = true;
  $('notif-status').textContent = 'Enviando…';
  try {
    await withBusy(() => api('/api/v1/notifications', { method: 'POST', body: JSON.stringify({ title, body }) }));
    $('notif-title').value = '';
    $('notif-body').value = '';
    $('notif-status').textContent = 'Notificación enviada a todos los usuarios. Llegará en ~30s.';
    toast('Notificación enviada ✅');
    refreshNotifications();
  } catch (e) {
    $('notif-status').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

// ============================================================
// Clave API
// ============================================================
async function refreshApiKey() {
  const { apiKey, revealedOnce } = await api('/api/v1/settings/api-key');
  const box = $('apikey-content');
  if (!revealedOnce) {
    box.innerHTML = `
      <p class="hint" style="margin-bottom:4px">Tu clave API (se muestra una sola vez):</p>
      <div class="mono apikey-value">${esc(apiKey)}</div>
      <div class="actions">
        <button id="apikey-copy" class="btn btn-primary" data-akey="${esc(apiKey)}">📋 Copiar</button>
        <button id="apikey-done" class="btn btn-ghost">✅ Ya la guardé</button>
      </div>`;
    $('apikey-copy').addEventListener('click', () => copyText(apiKey));
    $('apikey-done').addEventListener('click', async () => {
      await api('/api/v1/settings/api-key/reveal', { method: 'POST', body: '{}' });
      toast('Clave marcada como vista. Ya no se volverá a mostrar completa.');
      refreshApiKey();
    });
  } else {
    box.innerHTML = `
      <p class="hint" style="margin-bottom:4px">La clave ya fue revelada y copiada. No se vuelve a mostrar por seguridad.</p>
      <p class="hint">Si perdiste la copia, puedes regenerarla (invalidará los builds anteriores).</p>
      <div class="actions">
        <button id="apikey-regenerate" class="btn btn-danger">🔄 Regenerar clave</button>
      </div>`;
    $('apikey-regenerate').addEventListener('click', async () => {
      if (!confirm('¿Regenerar la clave API? Las apps ya compiladas con la clave anterior dejarán de conectarse.')) return;
      try {
        const r = await api('/api/v1/settings/api-key/regenerate', { method: 'POST', body: '{}' });
        copyText(r.apiKey);
        toast('Nueva clave generada y copiada al portapapeles.');
        refreshApiKey();
      } catch (e) { toast(e.message, true); }
    });
  }
}

function copyText(text) {
  navigator.clipboard?.writeText(text).catch(() => {});
  toast('Copiada al portapapeles.');
}

function refreshTab(tab) {
  return withBusy(() => {
    if (tab === 'orders' || tab === 'history') return refreshOrders();
    if (tab === 'reports') return refreshReports();
    if (tab === 'reserves') return refreshReserves();
    if (tab === 'settings') return refreshCommissions();
    if (tab === 'nodes') return refreshNodes();
    if (tab === 'market') return refreshMarket(true);
    if (tab === 'coins') return refreshCustomCoins();
    if (tab === 'apikey') return refreshApiKey();
    if (tab === 'notifications') return refreshNotifications();
    return Promise.resolve();
  });
}

function refreshAll() {
  refreshOrders().catch((e) => toast(e.message, true));
  refreshReserves().catch((e) => toast(e.message, true));
  refreshReports().catch((e) => toast(e.message, true));
  refreshApiKey().catch((e) => toast(e.message, true));
  refreshCommissions().catch((e) => toast(e.message, true));
  refreshNotifications().catch((e) => toast(e.message, true));
  refreshNodes().catch((e) => toast(e.message, true));
  refreshCustomCoins().catch((e) => toast(e.message, true));
  refreshConnection();
}

document.addEventListener('DOMContentLoaded', () => {
  const loginBtn = $('login-btn');
  loginBtn.addEventListener('click', () => doLogin());
  $('login-pass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin();
  });

  async function doLogin() {
    const password = $('login-pass').value;
    loginBtn.disabled = true;
    $('login-msg').textContent = '';
    try {
      await withBusy(async () => {
        const res = await api('/api/v1/admin/login', {
          method: 'POST', body: JSON.stringify({ password }),
        });
        token = res.token;
        localStorage.setItem('cerebro_token', token);
      });
      showApp();
    } catch (e) {
      $('login-msg').textContent = e.message;
      $('login-msg').className = 'msg error';
    } finally {
      loginBtn.disabled = false;
    }
  }

  $('logout-btn').addEventListener('click', () => {
    token = '';
    localStorage.removeItem('cerebro_token');
    showLogin();
  });
  $('erleo-toggle').addEventListener('click', async () => {
    const enabled = await api('/api/v1/settings/erleo-enabled');
    if (!enabled && !confirm('¿ACTIVAR los intercambios Erleo? Las apps empezarán a enviar órdenes pequeñas de nuevo.')) return;
    if (enabled && !confirm('¿DETENER los intercambios Erleo? Las apps volverán a ChangeNOW para montos bajos.')) return;
    try {
      await setErleoEnabled(!enabled);
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('clear-history').addEventListener('click', async () => {
    if (!confirm('¿Borrar TODO el historial de órdenes terminadas? Esta acción no se puede deshacer.')) return;
    try {
      const r = await api('/api/v1/orders/clear-history', { method: 'POST', body: '{}' });
      toast(`Historial limpiado (${r.deleted} órdenes eliminadas).`);
      refreshOrders();
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      currentTab = t.dataset.tab;
      $('tab-' + currentTab).classList.add('active');
      refreshTab(currentTab).catch((e) => toast(e.message, true));
    });
  });

  // Acciones de botones (delegación de eventos)
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    const id = el.dataset.id;
    try {
      if (action === 'toggle-detail') {
        const row = $('detail-' + id);
        if (row) {
          const hidden = row.style.display === 'none' || !row.style.display;
          row.style.display = hidden ? 'table-row' : 'none';
          el.textContent = hidden ? 'Ocultar' : 'Ver';
        }
      } else if (action === 'approve') {
        const r = await api(`/api/v1/orders/${id}/approve`, { method: 'POST', body: '{}' });
        toast(`Orden aprobada. Entrega ${fmtAmount(r.netToAmount)} ${r.toSymbol} al usuario.`);
        refreshOrders();
        refreshGlobal();
      } else if (action === 'reject') {
        if (!confirm('¿Rechazar esta orden? El usuario verá el mensaje del mínimo oficial.')) return;
        await api(`/api/v1/orders/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason: 'Rechazada por el admin' }) });
        toast('Orden rechazada.');
        refreshOrders();
        refreshGlobal();
      } else if (action === 'complete') {
        const txp = $(`txp-${id}`)?.value || '';
        const txr = $(`txr-${id}`)?.value || '';
        const r = await api(`/api/v1/orders/${id}/complete`, {
          method: 'POST', body: JSON.stringify({ txHashPayout: txp, txHashRefund: txr }),
        });
        toast(`Orden completada. Comisión registrada en categoría separada.`);
        refreshOrders();
        refreshGlobal();
      } else if (action === 'save-coin-net') {
        const row = el.closest('.network-row');
        const sym = row.dataset.symbol;
        const net = row.dataset.network || '';
        const read = (f) => {
          const inp = row.querySelector('.net-in[data-f="' + f + '"]');
          return inp ? inp.value.trim() : '';
        };
        await api('/api/v1/coin-addresses', {
          method: 'POST',
          body: JSON.stringify({
            symbol: sym, network: net,
            address: read('address'),
            payoutAddress: read('payoutAddress'),
          }),
        });
        toast(`Dirección de ${sym}${net ? ' (' + net + ')' : ''} guardada`);
        refreshReserves();
      } else if (action === 'test-node') {
        const node = await api(`/api/v1/nodes/${id}/test`, { method: 'POST', body: '{}' });
        toast(node.latencyMs > 0
          ? `${node.name} (${node.symbol}): ${Math.round(node.latencyMs)} ms · cobertura ${Math.round(node.coverage)}%`
          : `${node.name}: no respondió`);
        refreshNodes();
      } else if (action === 'toggle-node') {
        await api(`/api/v1/nodes/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ enabled: el.dataset.enabled !== '1' }),
        });
        toast('Nodo ' + (el.dataset.enabled === '1' ? 'desactivado' : 'activado') + '.');
        refreshNodes();
      } else if (action === 'edit-node') {
        const nodes = await api('/api/v1/nodes');
        const n = nodes.find((x) => String(x.id) === String(id));
        if (n) fillNodeForm(n);
      } else if (action === 'del-node') {
        if (!confirm('¿Eliminar este nodo?')) return;
        await api(`/api/v1/nodes/${id}`, { method: 'DELETE' });
        toast('Nodo eliminado.');
        refreshNodes();
      } else if (action === 'toggle-coin') {
        await api(`/api/v1/admin/coins/custom/${id}/toggle`, {
          method: 'POST', body: JSON.stringify({ enabled: el.dataset.enabled !== '1' }),
        });
        toast('Moneda ' + (el.dataset.enabled === '1' ? 'desactivada' : 'activada') + '.');
        refreshCustomCoins();
        refreshReserves();
      } else if (action === 'edit-coin') {
        const { coins } = await api('/api/v1/admin/coins/custom');
        const c = coins.find((x) => String(x.id) === String(id));
        if (c) fillCoinForm(c);
      } else if (action === 'del-coin') {
        if (!confirm('¿Eliminar esta moneda? Se quitan sus direcciones, comisiones y nodos. Esta acción no se puede deshacer.')) return;
        await api(`/api/v1/admin/coins/custom/${id}`, { method: 'DELETE' });
        toast('Moneda eliminada.');
        resetCoinForm();
        refreshCustomCoins();
        refreshReserves();
        refreshMarket(true);
        refreshNodes();
        coinSymbolList = null;
        coinPercentCache = null;
      }
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('node-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const payload = {
        symbol: $('n-symbol').value.trim().toUpperCase(),
        name: $('n-name').value.trim(),
        uri: $('n-uri').value.trim(),
        enabled: $('n-enabled').checked,
        trusted: $('n-trusted').checked,
        isOfficial: $('n-official').checked,
        isDefault: $('n-default').checked,
        autoSwitch: $('n-autoswitch').checked,
      };
      if (editingNodeId) {
        await api(`/api/v1/nodes/${editingNodeId}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast('Nodo actualizado');
      } else {
        await api('/api/v1/nodes', { method: 'POST', body: JSON.stringify(payload) });
        toast('Nodo agregado');
      }
      resetNodeForm();
      refreshNodes();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('n-cancel-edit').addEventListener('click', resetNodeForm);

  $('cc-logo').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) { ccLogoData = ''; return; }
    const reader = new FileReader();
    reader.onload = () => { ccLogoData = String(reader.result); };
    reader.readAsDataURL(file);
  });

  $('cc-network').addEventListener('change', () => {
    const isEvmOrTrc = ['ethereum', 'erc20', 'bep20', 'base', 'arbitrum', 'polygon', 'trc20'].includes($('cc-network').value);
    $('cc-contract').closest('.field').style.display = isEvmOrTrc ? '' : 'none';
  });

  $('cc-cancel').addEventListener('click', resetCoinForm);

  $('coin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const payload = {
        symbol: $('cc-symbol').value.trim().toUpperCase(),
        name: $('cc-name').value.trim(),
        network: $('cc-network').value,
        contractAddress: $('cc-contract').value.trim(),
        feeAddress: $('cc-fee').value.trim(),
        reserveAddress: $('cc-reserve').value.trim(),
        logo: ccLogoData,
        nodes: $('cc-nodes').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      };
      const id = $('cc-id').value;
      if (id) {
        await api(`/api/v1/admin/coins/custom/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast('Moneda actualizada');
      } else {
        await api('/api/v1/admin/coins/custom', { method: 'POST', body: JSON.stringify(payload) });
        toast('Moneda creada');
      }
      resetCoinForm();
      refreshCustomCoins();
      refreshReserves();
      refreshMarket(true);
      refreshNodes();
      // La moneda nueva ya se propagó: la tabla "% por moneda" la recargará
      // en la próxima visita a Comisiones Erleo (el símbolo viene de coin-networks).
      coinSymbolList = null;
      coinPercentCache = null;
      toast('Propagada a Direcciones, Comisiones, Mercado y Nodos ✓');
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('sync-cake-btn').addEventListener('click', syncCakeNodes);

  ['mkt-symbol', 'mkt-crypto', 'mkt-usd'].forEach((id) => {
    $(id).addEventListener('input', updateMarketConverter);
  });
  $('mkt-symbol').addEventListener('input', () => {
    const dl = $('market-symbols');
    if (dl && marketSymbols.length) {
      dl.innerHTML = marketSymbols.map((s) => `<option value="${esc(s)}">`).join('');
    }
  });

  $('coin-search').addEventListener('input', refreshReserves);

  $('save-commissions-usd').addEventListener('click', async () => {
    try {
      const slow = parseFloat($('usd-slow').value);
      const medium = parseFloat($('usd-medium').value);
      const fast = parseFloat($('usd-fast').value);
      if ([slow, medium, fast].some((v) => isNaN(v) || v < 0)) { toast('Valores inválidos', true); return; }
      const r = await api('/api/v1/settings/commissions-usd', {
        method: 'POST', body: JSON.stringify({ slow, medium, fast }),
      });
      $('commissions-status').textContent = `Comisiones guardadas: 🐢 $${r.slow} · 🚶 $${r.medium} · ⚡ $${r.fast}`;
      toast(`Comisiones guardadas: 🐢 $${r.slow} · 🚶 $${r.medium} · ⚡ $${r.fast}`);
      await updateConversion();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('save-commission').addEventListener('click', async () => {
    try {
      const percent = parseFloat($('commission-percent').value);
      if (isNaN(percent) || percent < 0) { toast('Porcentaje inválido', true); return; }
      const r = await api('/api/v1/settings/commission-percent', {
        method: 'POST', body: JSON.stringify({ percent }),
      });
      $('commission-status').textContent = r.percent > 0
        ? `Comisión actual: ${r.percent}% del intercambio.`
        : 'Comisión porcentual desactivada. Se usa la comisión fija por velocidad.';
      toast(`Comisión guardada: ${r.percent}%`);
    } catch (err) {
      toast(err.message, true);
    }
  });

  ['usd-slow', 'usd-medium', 'usd-fast'].forEach((id) => {
    $(id).addEventListener('input', () => updateConversion().catch(() => {}));
  });

  $('notif-send').addEventListener('click', sendNotification);

  if (token) {
    showApp();
  } else {
    showLogin();
  }

  // Estado global + conexión en vivo cada 15s.
    setInterval(() => {
      if (token && $('app-view').style.display !== 'none') {
        refreshGlobal().catch(() => {});
        refreshConnection();
        if (currentTab === 'nodes') refreshNodes().catch(() => {});
        if (currentTab === 'market') refreshMarket().catch(() => {});
      }
    }, 10000);
});
