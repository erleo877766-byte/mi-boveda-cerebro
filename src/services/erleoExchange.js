import crypto from 'node:crypto';
import { db, nowIso, getSetting, setSetting } from '../db/index.js';

// ============================================================
// MODO INTERCAMBIO ERLEO AUTOMATIZADO
// Gestión de wallets del servidor, ejecución de transacciones
// y flujo completo de intercambio sin intervención manual.
// ============================================================

// Configuración del cifrado de claves privadas.
// En producción, la clave maestra viene de un HSM o vault externo.
// Para desarrollo, se usa una clave derivada del .env.
function getMasterKey() {
  const raw = process.env.ERLEO_MASTER_KEY || process.env.ADMIN_PASSWORD || 'default-dev-key';
  return crypto.scryptSync(raw, 'miboveda-erleo-salt', 32);
}

function encryptKey(plainKey) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plainKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decryptKey(encryptedKey) {
  const key = getMasterKey();
  const [ivHex, tagHex, data] = encryptedKey.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ============================================================
// Gestión de wallets del servidor
// ============================================================

export async function listWallets({ symbol, enabledOnly = false } = {}) {
  let sql = 'SELECT id, symbol, network, address, label, enabled, balance, lastBalanceCheck, createdAt FROM erleo_wallets';
  const params = [];
  const clauses = [];
  if (symbol) { clauses.push('symbol = ?'); params.push(String(symbol).toUpperCase()); }
  if (enabledOnly) clauses.push('enabled = 1');
  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
  sql += ' ORDER BY symbol, id ASC';
  return db.prepare(sql).all(...params);
}

export async function getWallet(id) {
  return db.prepare('SELECT id, symbol, network, address, label, enabled, balance, lastBalanceCheck, createdAt FROM erleo_wallets WHERE id = ?').get(Number(id));
}

export async function createWallet({ symbol, network = '', address, encryptedKey, label = '' }) {
  const sym = String(symbol || '').toUpperCase().trim();
  const addr = String(address || '').trim();
  if (!sym) return { error: 'symbol requerido' };
  if (!addr) return { error: 'address requerida' };
  const ts = nowIso();
  const r = await db.prepare(`
    INSERT INTO erleo_wallets (symbol, network, address, encryptedKey, label, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sym, network, addr, encryptedKey || '', label, ts);
  return { wallet: await getWallet(r.lastInsertRowid) };
}

export async function updateWallet(id, payload) {
  const existing = await db.prepare('SELECT * FROM erleo_wallets WHERE id = ?').get(Number(id));
  if (!existing) return { error: 'wallet no encontrada' };
  await db.prepare(`
    UPDATE erleo_wallets SET
      symbol = ?, network = ?, address = ?, label = ?, enabled = ?
    WHERE id = ?
  `).run(
    payload.symbol !== undefined ? String(payload.symbol).toUpperCase() : existing.symbol,
    payload.network !== undefined ? payload.network : existing.network,
    payload.address !== undefined ? payload.address : existing.address,
    payload.label !== undefined ? payload.label : existing.label,
    payload.enabled !== undefined ? (payload.enabled ? 1 : 0) : existing.enabled,
    Number(id)
  );
  return { wallet: await getWallet(id) };
}

export async function deleteWallet(id) {
  const existing = await db.prepare('SELECT * FROM erleo_wallets WHERE id = ?').get(Number(id));
  if (!existing) return { error: 'wallet no encontrada' };
  await db.prepare('DELETE FROM erleo_wallets WHERE id = ?').run(Number(id));
  return { ok: true };
}

// ============================================================
// Ejecución de transacciones Erleo
// ============================================================

// Selecciona la mejor wallet de origen para una transacción.
// Prioridad: 1) saldo suficiente, 2) enabled, 3) menor comisión previa.
export async function selectWallet(symbol, network, requiredAmount) {
  const sym = String(symbol || '').toUpperCase();
  const net = String(network || '');
  const wallets = await db.prepare(
    'SELECT * FROM erleo_wallets WHERE symbol = ? AND network = ? AND enabled = 1 ORDER BY balance DESC'
  ).all(sym, net);
  // Primero intentar con saldo suficiente.
  const funded = wallets.find((w) => Number(w.balance) >= requiredAmount);
  if (funded) return funded;
  // Si ninguna tiene saldo suficiente, devolver la de mayor saldo para reporte.
  return wallets[0] || null;
}

// Registra una transacción Erleo (pre-execución).
export async function createTransaction({ orderId, type, symbol, network, fromAddress, toAddress, amount, note = '' }) {
  const ts = nowIso();
  const r = await db.prepare(`
    INSERT INTO erleo_transactions (orderId, type, symbol, network, fromAddress, toAddress, amount, status, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(orderId || null, type, symbol, network || '', fromAddress, toAddress, amount, ts);
  const id = typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid;
  return { id, status: 'pending', createdAt: ts };
}

// Marca una transacción como en proceso de broadcast.
export async function markBroadcasting(id, txHash) {
  await db.prepare(`
    UPDATE erleo_transactions SET status = 'broadcasting', txHash = ? WHERE id = ? AND status = 'pending'
  `).run(txHash, Number(id));
}

// Marca una transacción como confirmada.
export async function markConfirmed(id, confirmations = 1, fee = 0) {
  const ts = nowIso();
  await db.prepare(`
    UPDATE erleo_transactions SET status = 'confirmed', confirmations = ?, fee = ?, completedAt = ? WHERE id = ?
  `).run(confirmations, fee, ts, Number(id));
}

// Marca una transacción como fallida.
export async function markFailed(id, note = '') {
  await db.prepare(`
    UPDATE erleo_transactions SET status = 'failed', note = ? WHERE id = ?
  `).run(note, Number(id));
}

// ============================================================
// Flujo completo de intercambio automatizado
// ============================================================

// Evalúa si un intercambio puede ejecutarse automáticamente.
// Requiere: wallet de origen con saldo, wallet de destino configurada, etc.
export async function canExecuteAutoSwap(fromSymbol, fromNetwork, toSymbol, toNetwork, fromAmount) {
  const sourceWallet = await selectWallet(fromSymbol, fromNetwork, fromAmount);
  if (!sourceWallet) return { ok: false, error: `No hay wallet de ${fromSymbol} con saldo suficiente` };
  if (Number(sourceWallet.balance) < fromAmount) {
    return { ok: false, error: `Saldo insuficiente: ${sourceWallet.balance} ${fromSymbol} < ${fromAmount} requerido` };
  }
  // Verificar que existe una dirección de destino para la moneda requerida.
  const destAddr = await db.prepare(
    'SELECT * FROM coin_addresses WHERE symbol = ? AND network = ? AND enabled = 1'
  ).get(toSymbol, toNetwork || '');
  if (!destAddr) return { ok: false, error: `No hay dirección de reserva para ${toSymbol}` };
  return { ok: true, sourceWallet, destAddress: destAddr };
}

// Calcula el monto neto después de comisiones y fees de red.
export async function calculateSwapResult(fromSymbol, fromAmount, toSymbol, speed, appRate) {
  const { computeNetAmount } = await import('./commission.js');
  const order = { fromSymbol, toSymbol, fromAmount, speed, appRate };
  const net = await computeNetAmount(order);
  if (!net) return { ok: false, error: 'No se pudo calcular la comision (sin precios)' };
  if (net.insufficient) return { ok: false, error: 'El monto es menor que la comision' };
  return {
    ok: true,
    commissionUsd: net.commissionUsd,
    commissionAmount: net.commissionAmount,
    netToAmount: net.netToAmount,
    percent: net.percent,
  };
}

// ============================================================
// Estado del sistema Erleo
// ============================================================

export async function getErleoStatus() {
  const enabled = await getSetting('erleoExchangeEnabled', '1');
  const autoMode = await getSetting('erleoAutoMode', '0');
  const wallets = await listWallets({ enabledOnly: true });
  const pendingTxs = await db.prepare(
    "SELECT COUNT(*) as c FROM erleo_transactions WHERE status IN ('pending', 'broadcasting')"
  ).get();
  const totalSwaps = await db.prepare(
    'SELECT COUNT(*) as c FROM orders WHERE status IN (\'completed\', \'approved\')'
  ).get();
  const totalCommissions = await db.prepare(
    'SELECT COALESCE(SUM(commissionUsd), 0) as total FROM commission_events'
  ).get();
  return {
    enabled: enabled === '1',
    autoMode: autoMode === '1',
    walletCount: wallets.length,
    activeWallets: wallets.filter((w) => w.enabled && Number(w.balance) > 0).length,
    pendingTransactions: pendingTxs?.c || 0,
    totalSwaps: totalSwaps?.c || 0,
    totalCommissionsUsd: totalCommissions?.total || 0,
  };
}

export async function toggleAutoMode(enabled) {
  await setSetting('erleoAutoMode', enabled ? '1' : '0');
  return { autoMode: enabled };
}
