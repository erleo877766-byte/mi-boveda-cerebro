import crypto from 'node:crypto';
import { db, getSetting, setSetting, nowIso } from '../db/index.js';

// ============================================================
// CEREBRO AUTÓNOMO — Motor de protección automática.
// Vigila saldos, precios, actividad sospechosa y blocklist.
// Corre como servicio en background tras el arranque del servidor.
// ============================================================

// Valores por defecto de protección.
export const DEFAULTS = {
  protectionEnabled: '0',           // maestro on/off
  lowBalanceEnabled: '1',
  lowBalanceThresholdBTC: '0.01',
  lowBalanceThresholdETH: '0.1',
  lowBalanceThresholdSOL: '1',
  lowBalanceThresholdXMR: '0.5',
  volatilityEnabled: '1',
  volatilityThresholdPct: '5',      // % cambio en ventana
  volatilityWindowSec: '60',        // ventana en segundos
  suspiciousRateLimit: '5',         // máx órdenes/minuto por key
  blocklistEnabled: '1',
  autoPauseOnReserveLow: '1',
  autoPauseOnVolatility: '1',
  autoPauseOnSuspiciousActivity: '0',
};

// Historial de precios en memoria (circular buffer por moneda).
// Almacena {ts, price} de los últimos N minutos.
const priceHistory = new Map(); // symbol -> [{ts, price}]
const MAX_HISTORY = 300; // 5 min a 1 tick/seg

// Estado de pausas automáticas.
const autoPauses = new Map(); // symbol -> { reason, pausedAt, expiresAt }

// ============================================================
// Settings de protección
// ============================================================
export async function getProtectionSetting(key) {
  const val = await getSetting('prot_' + key);
  return val || DEFAULTS[key] || '';
}

export async function setProtectionSetting(key, value) {
  await setSetting('prot_' + key, String(value));
}

export async function getAllProtectionSettings() {
  const result = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    result[key] = await getProtectionSetting(key) || def;
  }
  return result;
}

// ============================================================
// Alertas
// ============================================================
export async function createAlert(type, severity, message, details = '') {
  const id = await db.prepare(
    'INSERT INTO protection_alerts (type, severity, message, details, resolved, createdAt) VALUES (?, ?, ?, ?, 0, ?)'
  ).run(type, severity, message, details, nowIso());
  return id;
}

export async function getUnresolvedAlerts() {
  return db.prepare('SELECT * FROM protection_alerts WHERE resolved = 0 ORDER BY createdAt DESC').all();
}

export async function resolveAlert(id) {
  await db.prepare('UPDATE protection_alerts SET resolved = 1 WHERE id = ?').run(id);
}

export async function resolveAllAlerts() {
  await db.prepare('UPDATE protection_alerts SET resolved = 1 WHERE resolved = 0').run();
}

export async function getAlertHistory(limit = 50) {
  return db.prepare('SELECT * FROM protection_alerts ORDER BY createdAt DESC LIMIT ?').all(limit);
}

// ============================================================
// Blocklist de direcciones
// ============================================================
export async function isAddressBlocked(address) {
  const row = await db.prepare('SELECT address, reason FROM address_blocklist WHERE address = ?').get(address);
  return row || null;
}

export async function addToBlocklist(address, reason = '', source = 'manual') {
  await db.prepare(
    'INSERT OR REPLACE INTO address_blocklist (address, reason, source, addedAt) VALUES (?, ?, ?, ?)'
  ).run(address.trim(), reason, source, nowIso());
}

export async function removeFromBlocklist(address) {
  await db.prepare('DELETE FROM address_blocklist WHERE address = ?').run(address.trim());
}

export async function listBlocklist() {
  return db.prepare('SELECT * FROM address_blocklist ORDER BY addedAt DESC').all();
}

// ============================================================
// Detección de volatilidad
// ============================================================
export function recordPrice(symbol, price) {
  if (!symbol || price == null) return;
  const list = priceHistory.get(symbol) || [];
  const now = Date.now();
  list.push({ ts: now, price });
  // Mantener solo los últimos 5 minutos.
  while (list.length > MAX_HISTORY) list.shift();
  priceHistory.set(symbol, list);
}

export async function checkVolatility(symbol) {
  const settings = await getAllProtectionSettings();
  if (settings.volatilityEnabled !== '1') return null;

  const history = priceHistory.get(symbol);
  if (!history || history.length < 2) return null;

  const windowSec = Number(settings.volatilityWindowSec) || 60;
  const threshold = Number(settings.volatilityThresholdPct) || 5;
  const cutoff = Date.now() - windowSec * 1000;
  const recent = history.filter((h) => h.ts >= cutoff);
  if (recent.length < 2) return null;

  const oldest = recent[0].price;
  const newest = recent[recent.length - 1].price;
  if (oldest === 0) return null;

  const changePct = Math.abs((newest - oldest) / oldest) * 100;
  if (changePct >= threshold) {
    return {
      symbol,
      changePct: changePct.toFixed(2),
      from: oldest,
      to: newest,
      windowSec,
    };
  }
  return null;
}

// ============================================================
// Verificación de baja reserva
// ============================================================
export async function checkLowBalances() {
  const settings = await getAllProtectionSettings();
  if (settings.lowBalanceEnabled !== '1') return [];

  const alerts = [];
  const thresholds = {
    BTC: Number(settings.lowBalanceThresholdBTC) || 0.01,
    ETH: Number(settings.lowBalanceThresholdETH) || 0.1,
    SOL: Number(settings.lowBalanceThresholdSOL) || 1,
    XMR: Number(settings.lowBalanceThresholdXMR) || 0.5,
  };

  const rows = await db.prepare('SELECT symbol, network, balance FROM coin_addresses WHERE enabled = 1').all();
  for (const row of rows) {
    const threshold = thresholds[row.symbol];
    if (threshold == null) continue;
    if (row.balance < threshold) {
      alerts.push({
        symbol: row.symbol,
        network: row.network,
        balance: row.balance,
        threshold,
      });
    }
  }
  return alerts;
}

// ============================================================
// Auto-pausa por moneda
// ============================================================
export function isSymbolPaused(symbol) {
  const pause = autoPauses.get(symbol);
  if (!pause) return false;
  if (pause.expiresAt && Date.now() > pause.expiresAt) {
    autoPauses.delete(symbol);
    return false;
  }
  return true;
}

export function pauseSymbol(symbol, reason, durationMs = 30 * 60 * 1000) {
  autoPauses.set(symbol, {
    reason,
    pausedAt: Date.now(),
    expiresAt: durationMs > 0 ? Date.now() + durationMs : null,
  });
}

export function resumeSymbol(symbol) {
  autoPauses.delete(symbol);
}

export function getPausedSymbols() {
  const result = [];
  for (const [symbol, data] of autoPauses) {
    if (!isSymbolPaused(symbol)) continue;
    result.push({
      symbol,
      reason: data.reason,
      pausedAt: new Date(data.pausedAt).toISOString(),
      expiresAt: data.expiresAt ? new Date(data.expiresAt).toISOString() : 'manual',
    });
  }
  return result;
}

// ============================================================
// Check de actividad sospechosa (rate limit por key)
// ============================================================
const keyActivity = new Map(); // apiKey -> [{ts}]

export function recordKeyActivity(apiKey) {
  const key = apiKey || 'unknown';
  const list = keyActivity.get(key) || [];
  const now = Date.now();
  list.push({ ts: now });
  // Mantener últimos 5 minutos.
  while (list.length && now - list[0].ts > 5 * 60 * 1000) list.shift();
  keyActivity.set(key, list);
}

export async function checkSuspiciousActivity(apiKey) {
  const settings = await getAllProtectionSettings();
  const limit = Number(settings.suspiciousRateLimit) || 5;
  const list = keyActivity.get(apiKey) || [];
  // Contar en el último minuto.
  const oneMinAgo = Date.now() - 60 * 1000;
  const recentCount = list.filter((a) => a.ts >= oneMinAgo).length;
  if (recentCount > limit) {
    return {
      apiKey: apiKey.slice(0, 12) + '...',
      recentCount,
      limit,
    };
  }
  return null;
}

// ============================================================
// Ciclo de monitoreo principal.
// Se ejecuta cada 60 segundos y:
//   1. Revisa saldos de reserva contra umbrales.
//   2. Revisa volatilidad de precios activos.
//   3. Genera alertas y auto-pausa si está configurado.
// ============================================================
let monitorInterval = null;

export function startProtectionMonitor() {
  if (monitorInterval) return;
  console.log('[Cerebro] Protection monitor iniciado');
  monitorInterval = setInterval(runProtectionCycle, 60 * 1000);
  // Ejecutar una vez al arrancar.
  runProtectionCycle().catch(() => {});
}

export function stopProtectionMonitor() {
  if (monitorInterval) clearInterval(monitorInterval);
  monitorInterval = null;
}

async function runProtectionCycle() {
  try {
    const settings = await getAllProtectionSettings();
    if (settings.protectionEnabled !== '1') return;

    // 1) Low balance check.
    if (settings.lowBalanceEnabled === '1') {
      const lows = await checkLowBalances();
      for (const low of lows) {
        const msg = `Reserva baja: ${low.symbol} = ${low.balance} (umbral: ${low.threshold})`;
        await createAlert('low_balance', 'warning', msg, JSON.stringify(low));
        if (settings.autoPauseOnReserveLow === '1') {
          pauseSymbol(low.symbol, 'Reserva por debajo del umbral', 60 * 60 * 1000);
        }
      }
    }

    // 2) Volatility check for all tracked symbols.
    if (settings.volatilityEnabled === '1') {
      for (const [symbol] of priceHistory) {
        const vol = await checkVolatility(symbol);
        if (vol) {
          const msg = `Volatilidad extrema: ${symbol} cambió ${vol.changePct}% en ${vol.windowSec}s`;
          await createAlert('volatility', 'critical', msg, JSON.stringify(vol));
          if (settings.autoPauseOnVolatility === '1') {
            pauseSymbol(symbol, 'Volatilidad extrema detectada', 15 * 60 * 1000);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Cerebro] Protection cycle error:', err.message);
  }
}

// ============================================================
// Buscar direcciones en blocklist de fuentes públicas.
// Devuelve true si la dirección está en alguna lista conocida.
// ============================================================
const KNOWN_SCAM_LISTS = [
  // Agregar URLs de listas públicas aquí cuando se implemente la integración.
];

export async function checkAddressReputation(address) {
  // 1) Check local blocklist.
  const blocked = await isAddressBlocked(address);
  if (blocked) return { safe: false, reason: blocked.reason, source: blocked.source };

  // 2) Check against public lists (placeholder — integrar con ChainAbuse API, etc.)
  // Por ahora, devolvemos safe=true si no está bloqueada localmente.
  return { safe: true };
}
