import { db, nowIso } from '../db/index.js';
import { mapLimit } from '../utils.js';
import { createConnection } from 'node:net';

// ============================================================
// Nodos por criptomoneda.
// El Cerebro es el UNICO que conoce y administra los nodos.
// La app le pregunta SIEMPRE al Cerebro cual nodo usar.
// El Cerebro vigila TODOS los nodos TODO el tiempo (cobertura y
// latencia en vivo) y elige automaticamente el mejor para cada moneda.
// ============================================================

const PROBE_TIMEOUT_MS = 5000;

// Umbral: si un nodo falla 3 veces consecutivas, se desactiva.
const MAX_CONSECUTIVE_FAILURES = 3;

// Los nodos desactivados se vuelven a probar cada 5 minutos.
const REACTIVATION_INTERVAL_MS = 5 * 60 * 1000;

// ============================================================
// 1) VALIDACION ESTRICTA DE URL
// ============================================================
export function validateNodeUrl(rawUri) {
  const uri = String(rawUri || '').trim();
  if (!uri) return { valid: false, error: 'URI vacia' };

  let parsed;
  try {
    parsed = new URL(uri.startsWith('http') ? uri : 'https://' + uri);
  } catch {
    return { valid: false, error: 'URL invalida: formato incorrecto' };
  }

  // Debe tener protocolo http/https
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, error: 'URL invalida: solo se permiten http o https' };
  }

  // Debe tener hostname no vacio
  if (!parsed.hostname || parsed.hostname.length < 2) {
    return { valid: false, error: 'URL invalida: falta el dominio' };
  }

  // El hostname no puede tener espacios ni caracteres raros
  if (/\s/.test(parsed.hostname)) {
    return { valid: false, error: 'URL invalida: el dominio tiene espacios' };
  }

  // Si tiene puerto, debe ser un numero valido
  if (parsed.port) {
    const portNum = Number(parsed.port);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return { valid: false, error: 'URL invalida: puerto incorrecto' };
    }
  }

  // Detectar URLs incompletas tipicas: "https:" o "https://"
  if (parsed.hostname === '' || parsed.hostname === 'localhost' && !parsed.port) {
    return { valid: false, error: 'URL incompleta: falta el dominio' };
  }

  // Devolver la URL normalizada (sin trailing slash)
  const normalized = parsed.toString().replace(/\/+$/, '');
  return { valid: true, normalized, hostname: parsed.hostname, port: parsed.port };
}

// ============================================================
// 2) PROBACION DE CONEXION
// ============================================================
function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setTimeout(() => { socket.destroy(); resolve({ ms: Date.now() - start, ok: false, status: 0, error: 'tcp_timeout' }); }, timeoutMs);
    const socket = createConnection({ host, port }, () => {
      const ms = Date.now() - start;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ms, ok: true, status: 0 });
    });
    socket.on('error', (e) => {
      const ms = Date.now() - start;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ms, ok: false, status: 0, error: e.message || 'tcp_error' });
    });
  });
}

const ELECTRUM_PORTS = new Set([50001, 50002, 50022, 20060, 20063, 9108]);

export async function probeLatency(uri, timeoutMs = PROBE_TIMEOUT_MS) {
  const url = String(uri || '').trim();
  if (!url) return null;

  if (url.includes('.onion')) return null;

  let host, port;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const p = new URL(url);
      host = p.hostname;
      port = Number(p.port) || (p.protocol === 'https:' ? 443 : 80);
    } catch { return null; }
  } else {
    const parts = url.split(':');
    host = parts[0];
    port = Number(parts[1]) || 50001;
  }

  if (ELECTRUM_PORTS.has(port) || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return probeTcp(host, port, timeoutMs);
  }

  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'Cerebro-MiBoveda/1.0' },
    });
    const ms = Date.now() - start;
    return { ms, ok: res.ok || res.status < 500, status: res.status };
  } catch (e) {
    return { ms: Date.now() - start, ok: false, status: 0, error: e.message || 'connection_failed' };
  }
}

// ============================================================
// 3) COBERTURA / SCORE
// ============================================================
function coverageFrom(ok, ms) {
  if (!ok) return 0;
  if (ms <= 200) return 100;
  if (ms <= 400) return 80;
  if (ms <= 1000) return 50;
  return 20;
}

// ============================================================
// CRUD basico
// ============================================================
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
    consecutiveFailures: Number(row.consecutiveFailures) || 0,
    deactivatedReason: row.deactivatedReason || '',
    lastError: row.lastError || '',
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
  sql += ' ORDER BY symbol, isDefault DESC, coverage DESC, latencyMs ASC, id ASC';
  const rows = await db.prepare(sql).all(...params);
  return rows.map(toRow);
}

export async function getNode(id) {
  const row = await db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(id));
  return row ? toRow(row) : null;
}

// ============================================================
// CREAR NODO: valida URL + prueba conexion + guarda
// ============================================================
export async function createNode(payload) {
  const symbol = String(payload.symbol || '').toUpperCase().trim();
  if (!symbol) return { error: 'symbol requerido' };

  // Validar URL estrictamente
  const validation = validateNodeUrl(payload.uri);
  if (!validation.valid) return { error: validation.error };

  const name = String(payload.name || '').trim() || validation.hostname;

  // Probar conexion si se pide (por defecto si)
  if (payload.testOnSave !== false) {
    const probe = await probeLatency(validation.normalized);
    if (!probe || !probe.ok) {
      const reason = probe ? (probe.error || `HTTP ${probe.status}`) : 'sin respuesta';
      return {
        error: `Nodo no responde (${reason}). No se guardo como activo.`,
        probeFailed: true,
        probeResult: probe,
      };
    }
  }

  const ts = nowIso();
  const probe = await probeLatency(validation.normalized);
  const coverage = probe ? coverageFrom(probe.ok, probe.ms) : 0;

  const r = await db.prepare(`
    INSERT INTO nodes (symbol, name, uri, useSsl, trusted, isOfficial, isDefault, autoSwitch, enabled, latencyMs, coverage, lastCheck, consecutiveFailures, deactivatedReason, lastError, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', ?)
  `).run(
    symbol, name, validation.normalized,
    payload.useSsl === false ? 0 : 1,
    payload.trusted ? 1 : 0,
    payload.isOfficial ? 1 : 0,
    payload.isDefault ? 1 : 0,
    payload.autoSwitch === false ? 0 : 1,
    payload.enabled === false ? 0 : 1,
    probe ? probe.ms : 0,
    coverage,
    probe ? nowIso() : ts,
    ts
  );
  return { node: await getNode(r.lastInsertRowid), probeResult: probe };
}

// ============================================================
// ACTUALIZAR NODO: valida URL + prueba conexion + actualiza
// ============================================================
export async function updateNode(id, payload) {
  const existing = await getNode(id);
  if (!existing) return { error: 'nodo no encontrado' };

  let uri = payload.uri !== undefined ? String(payload.uri).trim() : existing.uri;
  let finalName = payload.name !== undefined ? String(payload.name).trim() : existing.name;

  if (payload.uri !== undefined) {
    const validation = validateNodeUrl(payload.uri);
    if (!validation.valid) return { error: validation.error };
    uri = validation.normalized;
    if (!finalName) finalName = validation.hostname;
  }

  // Probar conexion si se pide (por defecto si)
  let probeResult = null;
  let coverage = existing.coverage;
  let latencyMs = existing.latencyMs;
  if (payload.testOnSave !== false) {
    probeResult = await probeLatency(uri);
    if (!probeResult || !probeResult.ok) {
      const reason = probeResult ? (probeResult.error || `HTTP ${probeResult.status}`) : 'sin respuesta';
      return {
        error: `Nodo no responde (${reason}). No se actualizo.`,
        probeFailed: true,
        probeResult,
      };
    }
    coverage = coverageFrom(probeResult.ok, probeResult.ms);
    latencyMs = probeResult.ms;
  }

  await db.prepare(`
    UPDATE nodes SET
      symbol=?, name=?, uri=?, useSsl=?, trusted=?, isOfficial=?,
      isDefault=?, autoSwitch=?, enabled=?, latencyMs=?, coverage=?,
      lastCheck=?, consecutiveFailures=0, deactivatedReason='', lastError=''
    WHERE id=?
  `).run(
    payload.symbol !== undefined ? String(payload.symbol).toUpperCase().trim() : existing.symbol,
    finalName,
    uri,
    payload.useSsl !== undefined ? (payload.useSsl ? 1 : 0) : existing.useSsl ? 1 : 0,
    payload.trusted !== undefined ? (payload.trusted ? 1 : 0) : existing.trusted ? 1 : 0,
    payload.isOfficial !== undefined ? (payload.isOfficial ? 1 : 0) : existing.isOfficial ? 1 : 0,
    payload.isDefault !== undefined ? (payload.isDefault ? 1 : 0) : existing.isDefault ? 1 : 0,
    payload.autoSwitch !== undefined ? (payload.autoSwitch ? 1 : 0) : existing.autoSwitch ? 1 : 0,
    payload.enabled !== undefined ? (payload.enabled ? 1 : 0) : existing.enabled ? 1 : 0,
    latencyMs,
    coverage,
    probeResult ? nowIso() : existing.lastCheck,
    Number(id)
  );
  return { node: await getNode(id), probeResult };
}

export async function deleteNode(id) {
  const existing = await getNode(id);
  if (!existing) return { error: 'nodo no encontrado' };
  if (existing.isOfficial) return { error: 'no se puede eliminar un nodo oficial' };
  await db.prepare('DELETE FROM nodes WHERE id = ?').run(Number(id));
  return { ok: true };
}

// ============================================================
// TEST MANUAL: probar un nodo sin guardarlo
// ============================================================
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
  return { node: await getNode(id), probeResult: result };
}

// ============================================================
// SELECT BEST NODE: elige el mejor nodo para una moneda.
// PRIORIZA COBERTURA Y LATENCIA, NO solo ser default.
// Si el default esta muerto (coverage=0), usa otro activo.
// ============================================================
export async function selectBestNode(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const allNodes = await listNodes({ symbol: sym, enabledOnly: true });
  if (!allNodes.length) return null;

  // 1) Nodos con buena cobertura (>0), ordenados: mayor coverage, menor latencia
  const healthy = allNodes
    .filter((n) => (n.coverage || 0) > 0)
    .sort((a, b) => {
      // Default con buena cobertura tiene prioridad
      if (a.isDefault && !b.isDefault) return -1;
      if (!a.isDefault && b.isDefault) return 1;
      return b.coverage - a.coverage || a.latencyMs - b.latencyMs;
    });
  if (healthy.length) return healthy[0];

  // 2) Nodos sin medicion previa (coverage=0 pero nunca probado): probar uno
  const unprobed = allNodes.filter((n) => n.latencyMs === 0 && !n.lastCheck);
  if (unprobed.length) {
    const probe = await probeLatency(unprobed[0].uri, 3000);
    if (probe) {
      const ts = nowIso();
      const cov = coverageFrom(probe.ok, probe.ms);
      await db.prepare('UPDATE nodes SET latencyMs=?, coverage=?, lastCheck=? WHERE id=?')
        .run(probe.ms, cov, ts, unprobed[0].id);
      if (probe.ok) return { ...unprobed[0], latencyMs: probe.ms, coverage: cov };
    }
  }

  // 3) Fallback: el primer nodo aunque este muerto (mejor que nada)
  return allNodes[0];
}

// ============================================================
// MONITOR CONTINUO: vigila TODOS los nodos, incluyendo
// los desactivados, para reactivarlos automaticamente.
// ============================================================
const MONITOR_INTERVAL_MS = 60_000;
const MONITOR_CONCURRENCY = 12;
const MONITOR_TIMEOUT_MS = 3000;

// Cada iteracion: probe de TODOS los nodos (habilitados y desactivados),
// actualiza cobertura/latencia, y desactiva/reactiva automaticamente.
export async function monitorAllNodes() {
  const rows = await db.prepare('SELECT id, uri, enabled, consecutiveFailures FROM nodes').all();
  if (!rows.length) return { checked: 0 };

  const results = await mapLimit(rows, MONITOR_CONCURRENCY, async (row) => {
    const probe = await probeLatency(row.uri, MONITOR_TIMEOUT_MS);
    return { id: row.id, enabled: row.enabled, consecutiveFailures: row.consecutiveFailures || 0, probe };
  });

  const ts = nowIso();
  let activated = 0;
  let deactivated = 0;

  for (const r of results) {
    if (r.probe) {
      const coverage = coverageFrom(r.probe.ok, r.probe.ms);
      if (r.probe.ok) {
        // Nodo responde: resetear contador, activar si estaba desactivado
        if (r.enabled === 0) {
          await db.prepare(`
            UPDATE nodes SET latencyMs=?, coverage=?, lastCheck=?, enabled=1,
              consecutiveFailures=0, deactivatedReason='', lastError=''
            WHERE id=?
          `).run(r.probe.ms, coverage, ts, r.id);
          activated++;
        } else {
          await db.prepare(`
            UPDATE nodes SET latencyMs=?, coverage=?, lastCheck=?,
              consecutiveFailures=0, lastError=''
            WHERE id=?
          `).run(r.probe.ms, coverage, ts, r.id);
        }
      } else {
        // Nodo no responde
        const newFailures = (r.enabled === 1) ? (r.consecutiveFailures || 0) + 1 : (r.consecutiveFailures || 0) + 1;
        const reason = r.probe.error ? ` conexion fallida: ${r.probe.error}` : ` HTTP ${r.probe.status || 'timeout'}`;

        if (newFailures >= MAX_CONSECUTIVE_FAILURES && r.enabled === 1) {
          // Desactivar: fallo demasiadas veces seguidas
          await db.prepare(`
            UPDATE nodes SET latencyMs=?, coverage=?, lastCheck=?, enabled=0,
              consecutiveFailures=?, deactivatedReason=?, lastError=?
            WHERE id=?
          `).run(r.probe.ms, coverage, ts, newFailures, reason.trim(), reason.trim(), r.id);
          deactivated++;
        } else {
          // Aun no se desactiva, pero registrar el fallo
          await db.prepare(`
            UPDATE nodes SET latencyMs=?, coverage=?, lastCheck=?,
              consecutiveFailures=?, lastError=?
            WHERE id=?
          `).run(r.probe.ms, coverage, ts, newFailures, reason.trim(), r.id);
        }
      }
    } else {
      // Probe returned null = URL invalida
      const newFailures = (r.consecutiveFailures || 0) + 1;
      if (newFailures >= MAX_CONSECUTIVE_FAILURES && r.enabled === 1) {
        await db.prepare(`
          UPDATE nodes SET enabled=0, consecutiveFailures=?, lastCheck=?,
            deactivatedReason='URL invalida o sin respuesta', lastError='probe failed'
          WHERE id=?
        `).run(newFailures, ts, r.id);
        deactivated++;
      } else {
        await db.prepare(`
          UPDATE nodes SET consecutiveFailures=?, lastCheck=?, lastError='probe failed'
          WHERE id=?
        `).run(newFailures, ts, r.id);
      }
    }
  }

  if (activated || deactivated) {
    console.log(`[Cerebro Node Monitor] activados: ${activated}, desactivados: ${deactivated}, total: ${results.length}`);
  }
  return { checked: results.length, activated, deactivated };
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
    coverage: n.coverage,
    lastCheck: n.lastCheck,
    deactivatedReason: n.deactivatedReason || '',
    lastError: n.lastError || '',
  }));
}

// Nodos por defecto por moneda. Se insertan SOLO si la tabla esta vacia,
// para que el Cerebro nunca arranque sin nodos y la app sepa a donde
// conectarse. El admin puede editarlos/eliminarlos desde el panel.
const DEFAULT_NODES = [
  // XMR
  { symbol: 'XMR', name: 'nodo.minexmr.com', uri: 'https://monero.ceo:18090', official: true },
  { symbol: 'XMR', name: 'xmr-node.cakewallet.com', uri: 'https://xmr2.doggett.tech:18089', official: true },
  { symbol: 'XMR', name: 'node.moneroworld.com', uri: 'https://xmr1.doggett.tech:18089', official: false },
  // XNO
  { symbol: 'XNO', name: 'app.nanocrawler.cc', uri: 'https://node.somenano.com', official: false },
  { symbol: 'XNO', name: 'nano.loshan.de', uri: 'https://node.somenano.com', official: false },
  { symbol: 'XNO', name: 'brainblocks.io', uri: 'https://node.somenano.com', official: false },
  // BTC
  { symbol: 'BTC', name: 'blockstream.info', uri: 'https://blockstream.info', official: true },
  { symbol: 'BTC', name: 'mempool.space', uri: 'https://mempool.space', official: false },
  // LTC
  { symbol: 'LTC', name: 'litecoinspace.org', uri: 'https://litecoinspace.org', official: false },
  // DOGE
  { symbol: 'DOGE', name: 'dogechain.info', uri: 'https://dogechain.info', official: false },
  // ETH / EVM
  { symbol: 'ETH', name: 'cloudflare-eth.com', uri: 'https://cloudflare-eth.com', official: false },
  { symbol: 'ETH', name: 'PublicNode (ETH)', uri: 'https://ethereum-rpc.publicnode.com', official: false },
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
  { uri: 'https://ethereum-rpc.publicnode.com', official: false },
];

export async function seedDefaultNodes() {
  const ts = nowIso();
  let seeded = 0;
  const insertIfMissing = async (n) => {
    const exists = await db.prepare(
      'SELECT id FROM nodes WHERE symbol = ? AND name = ?'
    ).get(n.symbol, n.name);
    if (exists) return;
    await db.prepare(`
      INSERT INTO nodes (symbol, name, uri, useSsl, trusted, isOfficial, isDefault, autoSwitch, enabled, createdAt, consecutiveFailures, deactivatedReason, lastError)
      VALUES (?, ?, ?, 1, ?, ?, 1, 1, 1, ?, 0, '', '')
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
