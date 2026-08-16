import { db, nowIso } from '../db/index.js';
import { mapLimit } from '../utils.js';

// ============================================================
// Nodos por criptomoneda.
// El Cerebro es el UNICO que conoce y administra los nodos.
// La app le pregunta SIEMPRE al Cerebro cual nodo usar.
// El Cerebro vigila TODOS los nodos TODO el tiempo (cobertura y
// latencia en vivo) y elige automaticamente el mejor para cada moneda.
// ============================================================

const PROBE_TIMEOUT_MS = 5000;

// Probamos la latencia del nodo con una peticion HTTP HEAD/GET minima.
// Como muchos nodos no responden HEAD, usamos un GET con abort por timeout
// y medimos el tiempo de respuesta hasta que llegan las cabeceras.
export async function probeLatency(uri, timeoutMs = PROBE_TIMEOUT_MS) {
  const url = String(uri || '').trim();
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url.startsWith('http') ? url : 'https://' + url);
  } catch {
    return null;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(parsed.toString(), { signal: ctrl.signal });
    const ms = Date.now() - start;
    return { ms, ok: res.ok || res.status < 500 };
  } catch {
    return { ms: Date.now() - start, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// Calcula una "cobertura" estimada 0-100: los nodos que responden en menos
// de 400ms se consideran sanos (cobertura alta); los lentos o que fallan, baja.
function coverageFrom(ok, ms) {
  if (!ok) return 0;
  if (ms <= 200) return 100;
  if (ms <= 400) return 80;
  if (ms <= 1000) return 50;
  return 20;
}

function toRow(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    uri: row.uri,
    useSsl: row.useSsl === 1,
    trusted: row.trusted === 1,
    isOfficial: row.isOfficial === 1,
    isDefault: row.isDefault === 1,
    autoSwitch: row.autoSwitch === 1,
    enabled: row.enabled === 1,
    latencyMs: Number(row.latencyMs) || 0,
    coverage: Number(row.coverage) || 0,
    lastCheck: row.lastCheck || '',
    createdAt: row.createdAt,
  };
}

export async function listNodes({ symbol, enabledOnly = false } = {}) {
  let sql = 'SELECT * FROM nodes';
  const params = [];
  const clauses = [];
  if (symbol) {
    clauses.push('symbol = ?');
    params.push(String(symbol).toUpperCase());
  }
  if (enabledOnly) clauses.push('enabled = 1');
  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
  sql += ' ORDER BY symbol, isDefault DESC, latencyMs ASC, id ASC';
  const rows = await db.prepare(sql).all(...params);
  return rows.map(toRow);
}

export async function getNode(id) {
  const row = await db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(id));
  return row ? toRow(row) : null;
}

export async function createNode(payload) {
  const symbol = String(payload.symbol || '').toUpperCase().trim();
  const uri = String(payload.uri || '').trim();
  if (!symbol) return { error: 'symbol requerido' };
  if (!uri) return { error: 'uri requerido' };
  let parsed;
  try {
    parsed = new URL(uri.startsWith('http') ? uri : 'https://' + uri);
  } catch {
    return { error: 'uri invalida' };
  }
  const name = String(payload.name || '').trim() || parsed.hostname;
  const ts = nowIso();
  const r = await db.prepare(`
    INSERT INTO nodes (symbol, name, uri, useSsl, trusted, isOfficial, isDefault, autoSwitch, enabled, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    symbol, name, parsed.toString(),
    payload.useSsl === false ? 0 : 1,
    payload.trusted ? 1 : 0,
    payload.isOfficial ? 1 : 0,
    payload.isDefault ? 1 : 0,
    payload.autoSwitch === false ? 0 : 1,
    payload.enabled === false ? 0 : 1,
    ts
  );
  return { node: await getNode(r.lastInsertRowid) };
}

export async function updateNode(id, payload) {
  const existing = await getNode(id);
  if (!existing) return { error: 'nodo no encontrado' };
  let uri = payload.uri !== undefined ? String(payload.uri).trim() : existing.uri;
  if (uri) {
    try {
      uri = new URL(uri.startsWith('http') ? uri : 'https://' + uri).toString();
    } catch {
      return { error: 'uri invalida' };
    }
  }
  await db.prepare(`
    UPDATE nodes SET
      symbol=?, name=?, uri=?, useSsl=?, trusted=?, isOfficial=?,
      isDefault=?, autoSwitch=?, enabled=?
    WHERE id=?
  `).run(
    payload.symbol !== undefined ? String(payload.symbol).toUpperCase().trim() : existing.symbol,
    payload.name !== undefined ? String(payload.name).trim() : existing.name,
    uri,
    payload.useSsl !== undefined ? (payload.useSsl ? 1 : 0) : existing.useSsl ? 1 : 0,
    payload.trusted !== undefined ? (payload.trusted ? 1 : 0) : existing.trusted ? 1 : 0,
    payload.isOfficial !== undefined ? (payload.isOfficial ? 1 : 0) : existing.isOfficial ? 1 : 0,
    payload.isDefault !== undefined ? (payload.isDefault ? 1 : 0) : existing.isDefault ? 1 : 0,
    payload.autoSwitch !== undefined ? (payload.autoSwitch ? 1 : 0) : existing.autoSwitch ? 1 : 0,
    payload.enabled !== undefined ? (payload.enabled ? 1 : 0) : existing.enabled ? 1 : 0,
    Number(id)
  );
  return { node: await getNode(id) };
}

export async function deleteNode(id) {
  const existing = await getNode(id);
  if (!existing) return { error: 'nodo no encontrado' };
  if (existing.isOfficial) return { error: 'no se puede eliminar un nodo oficial' };
  await db.prepare('DELETE FROM nodes WHERE id = ?').run(Number(id));
  return { ok: true };
}

// Mide y guarda latencia + cobertura de un nodo. Devuelve el nodo actualizado.
export async function testNode(id) {
  const existing = await getNode(id);
  if (!existing) return { error: 'nodo no encontrado' };
  const result = await probeLatency(existing.uri);
  const ts = nowIso();
  if (result) {
    const coverage = coverageFrom(result.ok, result.ms);
    await db.prepare(`
      UPDATE nodes SET latencyMs=?, coverage=?, lastCheck=? WHERE id=?
    `).run(result.ms, coverage, ts, Number(id));
  } else {
    await db.prepare('UPDATE nodes SET lastCheck=? WHERE id=?').run(ts, Number(id));
  }
  return { node: await getNode(id) };
}

// Elige automaticamente el mejor nodo para un simbolo:
//  1) solo nodos habilitados de ese simbolo
// Auto-selección inteligente del nodo ideal para la app:
//  1) el marcado como default (si existe)
//  2) el de MAYOR cobertura medida
//  3) entre los demas, el de menor latencia medida
//  4) si ninguno fue medido, el primer habilitado
// La app SIEMPRE pregunta al Cerebro cuál usar.
// Devuelve null si no hay nodos para el simbolo.
export async function selectBestNode(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const nodes = await listNodes({ symbol: sym, enabledOnly: true });
  if (!nodes.length) return null;

  const defaultNode = nodes.find((n) => n.isDefault);
  if (defaultNode) return defaultNode;

  const withCoverage = nodes
    .filter((n) => (n.coverage || 0) > 0)
    .sort((a, b) => b.coverage - a.coverage || a.latencyMs - b.latencyMs);
  if (withCoverage.length) return withCoverage[0];

  const measured = nodes
    .filter((n) => n.latencyMs > 0)
    .sort((a, b) => a.latencyMs - b.latencyMs);
  if (measured.length) return measured[0];

  return nodes[0];
}

// ============================================================
// Monitor continuo: el Cerebro vigila TODOS los nodos habilitados
// todo el tiempo (cobertura + latencia en vivo) sin que el admin
// tenga que pulsar "Probar". El estado medido se persiste en la DB,
// asi que si el Cerebro se reinicia recupera el ultimo estado conocido
// y sigue actualizandolo.
// ============================================================
const MONITOR_INTERVAL_MS = 60_000;
const MONITOR_CONCURRENCY = 12;
const MONITOR_TIMEOUT_MS = 3000;

export async function monitorAllNodes() {
  const rows = await db.prepare('SELECT id, uri FROM nodes WHERE enabled = 1').all();
  if (!rows.length) return { checked: 0 };
  const results = await mapLimit(rows, MONITOR_CONCURRENCY, async (row) => {
    const probe = await probeLatency(row.uri, MONITOR_TIMEOUT_MS);
    return { id: row.id, probe };
  });
  const ts = nowIso();
  for (const r of results) {
    if (r.probe) {
      const coverage = coverageFrom(r.probe.ok, r.probe.ms);
      await db.prepare('UPDATE nodes SET latencyMs=?, coverage=?, lastCheck=? WHERE id=?')
        .run(r.probe.ms, coverage, ts, r.id);
    } else {
      await db.prepare('UPDATE nodes SET lastCheck=? WHERE id=?').run(ts, r.id);
    }
  }
  return { checked: results.length };
}

let monitorTimer = null;
let monitorRunning = false;

export function startNodeMonitor(intervalMs = MONITOR_INTERVAL_MS) {
  if (monitorTimer) return;
  const tick = async () => {
    if (monitorRunning) return;
    monitorRunning = true;
    try {
      await monitorAllNodes();
    } catch (_) {
      // Una pasada fallida no debe tumbar el monitor.
    } finally {
      monitorRunning = false;
    }
  };
  // Primera medicion justo despues de arrancar y luego en intervalos.
  setTimeout(tick, 1500);
  monitorTimer = setInterval(tick, intervalMs);
}

// Lista de nodos en el formato que espera la app (CerebroNode).
export function toAppNodes(nodes) {
  return nodes.map((n) => ({
    name: n.name,
    uri: n.uri,
    symbol: n.symbol,
    useSsl: n.useSsl,
    trusted: n.trusted,
    isOfficial: n.isOfficial,
    isDefault: n.isDefault,
    autoSwitch: n.autoSwitch,
  }));
}

// Nodos por defecto por moneda. Se insertan SOLO si la tabla esta vacia,
// para que el Cerebro nunca arranque sin nodos y la app sepa a donde
// conectarse. El admin puede editarlos/eliminarlos desde el panel.
const DEFAULT_NODES = [
  // XMR
  { symbol: 'XMR', name: 'nodo.minexmr.com', uri: 'https://nodo.minexmr.com', official: true },
  { symbol: 'XMR', name: 'xmr-node.cakewallet.com', uri: 'https://xmr-node.cakewallet.com', official: true },
  { symbol: 'XMR', name: 'node.moneroworld.com', uri: 'https://node.moneroworld.com', official: false },
  // XNO
  { symbol: 'XNO', name: 'app.nanocrawler.cc', uri: 'https://app.nanocrawler.cc', official: false },
  { symbol: 'XNO', name: 'nano.loshan.de', uri: 'https://nano.loshan.de', official: false },
  { symbol: 'XNO', name: 'brainblocks.io', uri: 'https://brainblocks.io', official: false },
  // BTC
  { symbol: 'BTC', name: 'blockstream.info', uri: 'https://blockstream.info', official: true },
  { symbol: 'BTC', name: 'mempool.space', uri: 'https://mempool.space', official: false },
  // LTC
  { symbol: 'LTC', name: 'litecoinspace.org', uri: 'https://litecoinspace.org', official: false },
  // DOGE
  { symbol: 'DOGE', name: 'dogechain.info', uri: 'https://dogechain.info', official: false },
  // ETH / EVM
  { symbol: 'ETH', name: 'cloudflare-eth.com', uri: 'https://cloudflare-eth.com', official: false },
  { symbol: 'ETH', name: 'eth.llamarpc.com', uri: 'https://eth.llamarpc.com', official: false },
  // BAN
  { symbol: 'BAN', name: 'banano.how', uri: 'https://banano.how', official: false },
  // SOL
  { symbol: 'SOL', name: 'api.mainnet-beta.solana.com', uri: 'https://api.mainnet-beta.solana.com', official: true },
  // TRX
  { symbol: 'TRX', name: 'api.trongrid.io', uri: 'https://api.trongrid.io', official: true },
  // POL
  { symbol: 'POL', name: 'polygon-rpc.com', uri: 'https://polygon-rpc.com', official: false },
  // BCH / DASH / DCR (exploradores publicos)
  { symbol: 'BCH', name: 'blockchair.com (BCH)', uri: 'https://api.blockchair.com/bitcoin-cash', official: false },
  { symbol: 'DASH', name: 'dash.org explorer', uri: 'https://insight.dash.org', official: false },
  { symbol: 'DCR', name: 'dcrdata.org', uri: 'https://dcrdata.org', official: false },
];

// Nodos de familia EVM: el mismo RPC de Ethereum sirve para consultar saldos
// de tokens ERC20 (USDT, USDC, DAI, WBTC, STETH, WETH, USDE...). Se siembran
// por simbolo para que la auto-verificacion de saldo los encuentre.
const EVM_NODES = [
  { uri: 'https://cloudflare-eth.com', official: false },
  { uri: 'https://eth.llamarpc.com', official: false },
];

export async function seedDefaultNodes() {
  const ts = nowIso();
  let seeded = 0;
  const insertIfMissing = async (n) => {
    const exists = await db.prepare(
      'SELECT id FROM nodes WHERE symbol = ? AND uri = ?'
    ).get(n.symbol, n.uri);
    if (exists) return;
    await db.prepare(`
      INSERT INTO nodes (symbol, name, uri, useSsl, trusted, isOfficial, isDefault, autoSwitch, enabled, createdAt)
      VALUES (?, ?, ?, 1, ?, ?, 1, 1, 1, ?)
    `).run(n.symbol, n.name, n.uri, n.official ? 1 : 0, n.official ? 1 : 0, ts);
    seeded++;
  };
  for (const n of DEFAULT_NODES) await insertIfMissing(n);
  // Simbolos de tokens/redes EVM soportados por la consulta de saldo.
  const evmSymbols = ['WETH', 'USDT', 'USDC', 'USDC.E', 'DAI', 'WBTC', 'STETH', 'USDE', 'MATIC', 'ARB', 'OP', 'BASE', 'BNB', 'BSC', 'FLIP'];
  for (const sym of evmSymbols) {
    for (const e of EVM_NODES) {
      await insertIfMissing({ symbol: sym, name: `RPC EVM (${sym})`, uri: e.uri, official: e.official });
    }
  }
  return { seeded };
}
