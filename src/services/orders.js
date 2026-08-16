import { randomBytes } from 'node:crypto';
import { db, nowIso, getSetting } from '../db/index.js';
import { computeNetAmount, recordCommissionEvent, commissionUsdFor, commissionPercent } from './commission.js';
import { cryptoToUsd } from './prices.js';
import { validateAddress } from './address_validation.js';
import { availableBalance } from './balance.js';
import { isCustomSymbol } from './customCoins.js';

// Limite maximo en USD por orden Erleo (configurable via settings).
// 0 = sin limite. Protege contra ordenes enormes disfrazadas de "por debajo del minimo".
export const DEFAULT_MAX_ORDER_USD = 1000;

export async function maxOrderUsd() {
  const raw = await getSetting('erleoMaxOrderUsd', '');
  if (raw === '') return DEFAULT_MAX_ORDER_USD;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return DEFAULT_MAX_ORDER_USD;
  return v;
}

export async function setMaxOrderUsd(value) {
  const clean = Number(value);
  if (!Number.isFinite(clean) || clean < 0) return { error: 'limite invalido' };
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES ('erleoMaxOrderUsd', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(clean));
  return { maxOrderUsd: clean };
}

// Expira las ordenes pending mas antiguas que el plazo configurado.
// Devuelve el numero de ordenes expiradas. Auto-rechazo para no dejar
// ordenes "pending" para siempre sin respuesta del admin.
export const DEFAULT_EXPIRY_HOURS = 48;

export async function orderExpiryHours() {
  const raw = await getSetting('erleoOrderExpiryHours', '');
  if (raw === '') return DEFAULT_EXPIRY_HOURS;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_EXPIRY_HOURS;
  return v;
}

export async function expirePendingOrders() {
  const hours = await orderExpiryHours();
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const pending = await db.prepare(
    "SELECT id FROM orders WHERE status='pending' AND createdAt < ?"
  ).all(cutoff);
  for (const row of pending) {
    await rejectOrder(row.id, `Expirada automaticamente tras ${hours}h sin respuesta del admin`);
  }
  return pending.length;
}

// Lista de simbolos soportados = TODAS las criptomonedas de la billetera
// (CryptoCurrency.all de cw_core). La billetera envía el title en mayúsculas
// como fromSymbol/toSymbol. tBTC (testnet) se excluye de intercambios reales.
export const SUPPORTED_SYMBOLS = new Set([
  'AAVE', 'ADA', 'APE', 'ARB', 'AVAX', 'BAN', 'BAT', 'BCH', 'BNB', 'BTC',
  'BTT', 'BTTC', 'CAKE', 'COMP', 'CRO', 'DAI', 'DASH', 'DCR', 'DEPS', 'DEURO',
  'DGB', 'DOGE', 'DYDX', 'ENS', 'EOS', 'ETH', 'FIRO', 'FLIP', 'FRAX', 'FTM',
  'GRT', 'GTC', 'GUSD', 'HBAR', 'KAS', 'KMD', 'LDO', 'LTC', 'MANA', 'MATIC',
  'MKR', 'NDEPS', 'NEAR', 'NEXO', 'OXT', 'PAXG', 'PEPE', 'PIVX', 'POL', 'RUNE',
  'RVN', 'SC', 'SCRT', 'SHIB', 'SOL', 'STETH', 'STORJ', 'STX', 'TON', 'TRX',
  'TUSD', 'UNI', 'USDC', 'USDC.E', 'USDE', 'USDT', 'WBTC', 'WETH', 'WOW', 'XHV',
  'XLM', 'XMR', 'XNO', 'XRP', 'XVG', 'ZANO', 'ZEC', 'ZEN', 'ZRX',
]);

// Redes/variantes conocidas por moneda (de la billetera, CryptoCurrency.all).
// El Cerebro usa la dirección de la red exacta de la orden; si la app manda
// red vacía, cae a la principal (network '').
export const COIN_NETWORKS = {
  BTC: ['', 'lightning'],
  USDT: ['', 'erc20', 'trc20', 'bsc', 'polygon', 'solana', 'arbitrum'],
  USDC: ['', 'erc20', 'trc20', 'polygon', 'solana', 'arbitrum'],
  ETH: ['', 'base', 'arbitrum'],
};

export const SPEEDS = new Set(['slow', 'medium', 'fast']);

// Valida que el simbolo sea soportado de fabrica O una moneda personalizada
// activa agregada por el admin en el Cerebro (se propaga a la app sola).
async function validateSymbolAsync(symbol) {
  if (typeof symbol !== 'string') return false;
  const sym = symbol.toUpperCase();
  if (SUPPORTED_SYMBOLS.has(sym)) return true;
  return isCustomSymbol(sym);
}

export async function createOrder(payload) {
  const errors = [];
  const from = String(payload.fromSymbol ?? '').toUpperCase();
  const to = String(payload.toSymbol ?? '').toUpperCase();
  if (!(await validateSymbolAsync(from))) errors.push('fromSymbol no soportado');
  if (!(await validateSymbolAsync(to))) errors.push('toSymbol no soportado');
  const fromAmount = Number(payload.fromAmount);
  if (!Number.isFinite(fromAmount) || fromAmount <= 0) errors.push('fromAmount invalido');
  if (typeof payload.toAddress !== 'string' || payload.toAddress.trim().length < 4)
    errors.push('toAddress invalida');
  // Validar el FORMATO de la direccion destino segun la moneda: es donde el
  // admin enviara los fondos. Un typo = fondos perdidos.
  if (!errors.includes('toAddress invalida')) {
    const addrErr = validateAddress(to, payload.toAddress);
    if (addrErr) errors.push(`toAddress: ${addrErr}`);
  }
  const speed = String(payload.speed ?? 'medium').toLowerCase();
  if (!SPEEDS.has(speed)) errors.push('speed debe ser slow|medium|fast');
  if (from === to) errors.push('fromSymbol no puede ser igual a toSymbol');
  if (errors.length) return { error: errors.join(', ') };

  // Limite maximo por orden en USD: rechazo temprano si el monto bruto
  // supera el limite configurado (los precios son los de mercado en vivo).
  const maxUsd = await maxOrderUsd();
  if (maxUsd > 0) {
    const grossUsd = await cryptoToUsd(fromAmount, from);
    if (grossUsd != null && grossUsd > maxUsd) {
      return { error: `monto supera el limite maximo de ${maxUsd} USD por orden` };
    }
  }

  const id = payload.id && typeof payload.id === 'string'
    ? payload.id
    : randomBytes(16).toString('hex');
  const ts = nowIso();
  const estReceive = Number(payload.estReceive) || 0;
  const appRate = estReceive > 0 ? estReceive / fromAmount : 0;

  const order = {
    id, status: 'pending',
    fromSymbol: from, fromNetwork: String(payload.fromNetwork ?? ''),
    fromAmount, toSymbol: to, toNetwork: String(payload.toNetwork ?? ''),
    toAddress: payload.toAddress.trim(), toExtraId: String(payload.toExtraId ?? ''),
    speed, estReceive, appRate,
    userLabel: String(payload.userLabel ?? ''),
    createdAt: ts, updatedAt: ts,
  };

  await db.prepare(`
    INSERT INTO orders
      (id, status, fromSymbol, fromNetwork, fromAmount, toSymbol, toNetwork,
       toAddress, toExtraId, speed, estReceive, appRate, userLabel, createdAt, updatedAt)
    VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    order.id, from, order.fromNetwork, fromAmount, to, order.toNetwork,
    order.toAddress, order.toExtraId, speed, estReceive, appRate, order.userLabel, ts, ts
  );

  await recordEvent(order.id, 'created', 'pending', 'Orden recibida de la app');
  const result = { order };
  try {
    // Neto estimado con la comision % del admin: lo ve el usuario ANTES de
    // que el admin apruebe (saber cuánto le van a entregar).
    const net = await computeNetAmount(order);
    if (net) {
      result.order.netToAmount = net.netToAmount;
      result.order.commissionUsd = net.commissionUsd;
      result.order.commissionPercent = net.percent;
      result.order.commissionAmount = net.commissionAmount;
    }
  } catch (_) {
    // Sin precios: el usuario ve el estimado normal, el admin fija al aprobar.
  }

  // APROBACION AUTOMATICA: el Cerebro verifica solo si hay direccion de
  // reserva + saldo suficiente para la moneda destino. Si todo OK, aprueba
  // solo (sin clic del admin). La orden pasa de pending a approved al instante.
  // Si NO hay saldo suficiente, se rechaza sola y pasa al historial con el
  // motivo "Saldo insuficiente" (no queda colgada en pendientes).
  try {
    const auto = await tryAutoApprove(order.id);
    if (auto.order) {
      result.order = auto.order;
      result.autoApproved = true;
    } else if (auto.insufficientBalance) {
      result.insufficientBalance = true;
      result.balanceError = auto.error;
      await rejectOrder(order.id, `Saldo insuficiente en ${order.toSymbol}: se requieren ${auto.required} y hay ${auto.available} (${auto.balanceSource})`);
      result.order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      result.order._rejectedAuto = true;
    } else if (auto.error) {
      await recordEvent(order.id, 'pending', 'pending', `Sin aprobacion automatica: ${auto.error}`);
    }
  } catch (_) {
    // La orden queda pending; el admin puede aprobarla manualmente.
  }
  return result;
}

// Aprobar: calcula comision + monto neto, VERIFICA SALDO en la direccion de
// reserva de la moneda destino, y si hay suficiente marca approved.
// La verificacion de saldo es automatica via nodos (con fallback manual).
export async function approveOrder(orderId, { checkBalance = true } = {}) {
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { error: 'orden no encontrada' };
  if (order.status !== 'pending')
    return { error: `estado invalido (${order.status}), solo se aprueba desde pending` };

  // Doble validacion de monedas antes de mover nada.
  const validFrom = await validateSymbolAsync(order.fromSymbol);
  const validTo = await validateSymbolAsync(order.toSymbol);
  if (!validFrom || !validTo)
    return { error: 'moneda no soportada, operacion bloqueada' };

  // Direcciones de reserva por moneda Y red. network '' = principal.
  const reserveFrom = await db.prepare(
    'SELECT * FROM coin_addresses WHERE symbol = ? AND network = ?'
  ).get(order.fromSymbol, String(order.fromNetwork || ''));
  const reserveTo = await db.prepare(
    'SELECT * FROM coin_addresses WHERE symbol = ? AND network = ?'
  ).get(order.toSymbol, String(order.toNetwork || ''));
  if (!reserveFrom || !reserveFrom.address || String(reserveFrom.address).trim().length < 4)
    return { error: `falta direccion de reserva para ${order.fromSymbol}` };
  if (!reserveTo || !reserveTo.address || String(reserveTo.address).trim().length < 4)
    return { error: `falta direccion de reserva para ${order.toSymbol}` };
  if (reserveFrom.enabled !== 1)
    return { error: `la moneda ${order.fromSymbol} esta desactivada, operacion bloqueada` };
  if (reserveTo.enabled !== 1)
    return { error: `la moneda ${order.toSymbol} esta desactivada, operacion bloqueada` };

  const net = await computeNetAmount(order);
  if (!net) return { error: 'no hay precio de mercado para calcular la comision' };
  if (net.insufficient)
    return { error: 'la comision es mayor que el monto, orden invalida' };

  // Limite maximo por orden (evita que una orden enorme se apruebe por error).
  const maxUsd = await maxOrderUsd();
  if (maxUsd > 0 && net.commissionUsd >= 0) {
    const grossUsd = await cryptoToUsd(order.fromAmount, order.fromSymbol);
    if (grossUsd != null && grossUsd > maxUsd) {
      return { error: `monto supera el limite maximo de ${maxUsd} USD por orden` };
    }
  }

  // VERIFICACION AUTOMATICA DE SALDO: el admin recibe la moneda origen y
  // entrega la moneda destino DESDE su reserva. Hay que tener saldo en la
  // reserva de la moneda DESTINO para pagar al usuario.
  if (checkBalance) {
    const reservePayoutAddr = (reserveTo.payoutAddress || reserveTo.address || '').trim();
    const manualBalance = reserveTo.balance != null ? Number(reserveTo.balance) : 0;
    const { available, source } = await availableBalance(order.toSymbol, reservePayoutAddr, manualBalance);
    const required = net.netToAmount || 0;
    if (available < required) {
      return {
        error: 'Intercambio no se pudo finalizar: saldo insuficiente en la dirección de reserva para completar esta operación',
        insufficientBalance: true,
        available,
        required,
        balanceSource: source,
      };
    }
  }

  const ts = nowIso();
  // UPDATE condicional atomico: solo afecta si sigue en pending. Si otra
  // peticion (p.ej. otra pestana del panel) ya la aprobo, rowsAffected = 0
  // y se bloquea la doble aprobacion / doble gasto.
  const upd = await db.prepare(`
    UPDATE orders SET status='approved', commissionUsd=?, netToAmount=?, commissionPercent=?,
      approvedAt=?, updatedAt=? WHERE id=? AND status='pending'
  `).run(net.commissionUsd, net.netToAmount, net.percent || 0, ts, ts, orderId);
  if (upd.rowsAffected === 0)
    return { error: 'la orden ya fue procesada (doble aprobacion bloqueada)' };

  await recordEvent(orderId, order.status, 'approved', `Aprobado por el Cerebro. Comision ${net.percent > 0 ? net.percent + '%' : net.commissionUsd + ' USD'}`);
  return { order: await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) };
}

// Auto-aprobacion: intenta aprobar una orden pending; devuelve el resultado.
export async function tryAutoApprove(orderId) {
  return approveOrder(orderId, { checkBalance: true });
}

// Limpiar el historial: borra solo las ordenes ya terminadas (completed,
// rejected, cancelled) y sus eventos. Nunca toca pending ni approved.
export async function clearOrderHistory() {
  const rows = await db.prepare(
    "SELECT id FROM orders WHERE status IN ('completed', 'rejected', 'cancelled')"
  ).all();
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { deleted: 0 };

  let deleted = 0;
  const placeholders = ids.map(() => '?').join(',');
  await db.prepare(`DELETE FROM order_events WHERE orderId IN (${placeholders})`).run(...ids);
  await db.prepare(`DELETE FROM commission_events WHERE orderId IN (${placeholders})`).run(...ids);
  const res = await db.prepare(`DELETE FROM orders WHERE id IN (${placeholders})`).run(...ids);
  deleted = res.rowsAffected || ids.length;
  return { deleted };
}

// Rechazar: la app mostrara el mensaje oficial del minimo.
export async function rejectOrder(orderId, reason = '') {
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { error: 'orden no encontrada' };
  if (order.status !== 'pending')
    return { error: `estado invalido (${order.status})` };
  const ts = nowIso();
  // UPDATE condicional atomico: solo si sigue pending.
  const upd = await db.prepare(`
    UPDATE orders SET status='rejected', rejectedAt=?, updatedAt=?, cancelledReason=? WHERE id=? AND status='pending'
  `).run(ts, ts, String(reason || 'Rechazada por el admin'), orderId);
  if (upd.rowsAffected === 0)
    return { error: 'la orden ya fue procesada' };
  await recordEvent(orderId, order.status, 'rejected', String(reason || 'Rechazada por el admin'));
  return { order: await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) };
}

// Completar: el admin confirmo que ya envio y recibio manualmente. Registra comision.
export async function completeOrder(orderId, { txHashPayout = '', txHashRefund = '', adminNote = '', networkFeeUsd = 0 } = {}) {
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { error: 'orden no encontrada' };
  if (order.status !== 'approved')
    return { error: `estado invalido (${order.status}), debe estar approved` };

  const commissionUsd = order.commissionUsd || await commissionUsdFor(order.speed, order.toSymbol);
  const ts = nowIso();
  // UPDATE condicional atomico: solo si sigue approved. Impide que dos
  // peticiones (dos pestanas del panel) completen/registren la misma orden.
  const upd = await db.prepare(`
    UPDATE orders SET status='completed', completedAt=?, updatedAt=?,
      txHashPayout=?, txHashRefund=?, adminNote=? WHERE id=? AND status='approved'
  `).run(ts, ts, String(txHashPayout), String(txHashRefund), String(adminNote), orderId);
  if (upd.rowsAffected === 0)
    return { error: 'la orden ya fue completada (doble completado bloqueado)' };

  const commissionAmount = order.commissionUsd > 0
    ? order.commissionUsd // approximation: real amount already in commissionAmount if stored
    : 0;
  // Recomputamos el monto real en la moneda origen para la contabilidad.
  const net = await computeNetAmount(order);
  const commissionAmountReal = net ? net.commissionAmount : commissionAmount;
  const providerFeeSavedUsd = 0; // cuando el admin lo procesa, se ahorra el fee del proveedor
  await recordCommissionEvent(
    { ...order, status: 'completed' },
    commissionUsd, commissionAmountReal, order.netToAmount, providerFeeSavedUsd
  );
  await recordEvent(orderId, order.status, 'completed', 'Completada por el admin');
  return { order: await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) };
}

async function recordEvent(orderId, fromStatus, toStatus, note) {
  await db.prepare(`
    INSERT INTO order_events (orderId, fromStatus, toStatus, note, createdAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(orderId, fromStatus, toStatus, note, nowIso());
}

export async function listOrders({ status, limit = 100 } = {}) {
  await expirePendingOrders();
  let sql = 'SELECT * FROM orders';
  const params = [];
  if (status) {
    sql += ' WHERE status = ?';
    params.push(status);
  }
  sql += ' ORDER BY createdAt DESC LIMIT ?';
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  return db.prepare(sql).all(...params);
}

export async function getOrder(orderId) {
  await expirePendingOrders();
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  const events = await db.prepare('SELECT * FROM order_events WHERE orderId = ? ORDER BY id').all(orderId);
  return { ...order, events };
}