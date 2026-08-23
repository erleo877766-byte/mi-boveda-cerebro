import { db, nowIso, getSetting } from '../db/index.js';
import { priceUsd, usdToCrypto, cryptoToUsd } from './prices.js';

// Regla normal por velocidad (USD fijos), igual que la app.
// Se mantiene como FALLBACK cuando no hay porcentaje configurado.
export const NORMAL_COMMISSION = { slow: 0.10, medium: 0.25, fast: 0.75 };

// Comision en USD configurable por velocidad, persistida en settings.
// Default: Lento $0.10, Normal $0.25, Rapido $0.75.
const USD_KEYS = { slow: 'commissionUsdSlow', medium: 'commissionUsdMedium', fast: 'commissionUsdFast' };

export async function commissionUsdForSpeed(speed) {
  const def = NORMAL_COMMISSION[speed] ?? NORMAL_COMMISSION.medium;
  const raw = await getSetting(USD_KEYS[speed], '');
  if (raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return def;
  return v;
}

export async function commissionUsdAll() {
  const [slow, medium, fast] = await Promise.all([
    commissionUsdForSpeed('slow'),
    commissionUsdForSpeed('medium'),
    commissionUsdForSpeed('fast'),
  ]);
  return { slow, medium, fast };
}

export async function setCommissionUsdAll({ slow, medium, fast } = {}) {
  const clean = {};
  for (const [key, value] of Object.entries({ slow, medium, fast })) {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return { error: `valor invalido para ${key}` };
    clean[key] = v;
  }
  for (const [key, value] of Object.entries(clean)) {
    await db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(USD_KEYS[key], String(value));
  }
  return { slow: clean.slow, medium: clean.medium, fast: clean.fast };
}

// Porcentaje de comision que el admin configura en el Cerebro (ej. 1 = 1%).
// Se descuenta del monto del intercambio.
export const DEFAULT_COMMISSION_PERCENT = 1;

export async function commissionPercent() {
  const raw = await getSetting('erleoCommissionPercent', '');
  if (raw === '') return DEFAULT_COMMISSION_PERCENT;
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct < 0) return DEFAULT_COMMISSION_PERCENT;
  return pct;
}

export async function setCommissionPercent(pct) {
  const clean = Number(pct);
  if (!Number.isFinite(clean) || clean < 0) return { error: 'porcentaje invalido' };
  const value = clean > 100 ? 100 : clean;
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES ('erleoCommissionPercent', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(value));
  return { percent: value };
}

// Comision en % POR MONEDA (tabla coin_commissions): una fila por cripto.
// Si la moneda tiene % configurado (>0) se usa ese; si no, el % global.
export async function coinCommissionPercent(symbol) {
  const row = await db
    .prepare('SELECT percent FROM coin_commissions WHERE symbol = ?')
    .get(String(symbol || '').toUpperCase());
  if (row && Number(row.percent) > 0) return Number(row.percent);
  return commissionPercent();
}

export async function coinCommissionsAll() {
  const rows = await db.prepare('SELECT symbol, percent FROM coin_commissions').all();
  const map = {};
  for (const r of rows) map[r.symbol] = Number(r.percent) || 0;
  return map;
}

export async function setCoinCommission(symbol, percent) {
  const sym = String(symbol || '').toUpperCase();
  const clean = Number(percent);
  if (!sym) return { error: 'symbol requerido' };
  if (!Number.isFinite(clean) || clean < 0) return { error: 'porcentaje invalido' };
  const value = clean > 100 ? 100 : clean;
  await db.prepare(`
    INSERT INTO coin_commissions (symbol, percent) VALUES (?, ?)
    ON CONFLICT(symbol) DO UPDATE SET percent = excluded.percent
  `).run(sym, value);
  return { symbol: sym, percent: value };
}

// Regla especial opcional por moneda destino (ordenes pequeñas).
export async function specialCommissionFor(symbol) {
  const row = await db
    .prepare('SELECT specialUsd FROM small_order_commission WHERE symbol = ?')
    .get(symbol.toUpperCase());
  if (!row) return null;
  return row.specialUsd > 0 ? row.specialUsd : null;
}

// USD de la comision para una orden segun velocidad + regla especial.
export async function commissionUsdFor(speed, toSymbol) {
  const special = await specialCommissionFor(toSymbol);
  if (special != null) return special;
  return commissionUsdForSpeed(speed);
}

// ============================================================
// Aritmetica decimal exacta (escalada a enteros) para evitar errores
// de redondeo de float/double acumulados en el calculo de comisiones.
// ============================================================
// Escala fija: 12 decimales (1e12). Los montos se representan como enteros
// (BigInt) durante el calculo y solo se convierten a float al devolver.
const SCALE = 10n ** 12n;

// Multiplica por una fraccion en punto fijo:
//   value * num / den, donde value es entero escalado (SCALE).
// num/den puede contener floats (p.ej. percent 0.5); se convierten a enteros
// escalando ambos por 1e9 para mantener la fraccion exacta. Si ya son BigInt
// se usan tal cual (caso de tasas ya escaladas).
function mulDivScaled(value, num, den) {
  const toBig = (x) => (typeof x === 'bigint' ? x : BigInt(Math.round(x * 1e9)));
  const numBig = toBig(num);
  const denBig = toBig(den);
  // Redondeo al entero mas cercano (mitad hacia arriba) en vez de truncar.
  const product = value * numBig * SCALE;
  const divisor = denBig * SCALE;
  const q = product / divisor;
  const r = product % divisor;
  return q + (r * 2n >= divisor ? 1n : 0n);
}

// Convierte un monto en moneda (float) a entero escalado con redondeo exacto.
function toScaled(amount) {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  const str = amount.toString(); // representacion decimal sin binario
  const parts = str.split('e');
  const mantissa = parts[0];
  let exp = parts.length > 1 ? Number(parts[1]) : 0;
  let intPart = mantissa;
  if (mantissa.includes('.')) {
    const [i, f] = mantissa.split('.');
    exp -= f.length;
    intPart = i + f;
  }
  let digits = intPart.replace('-', '').replace(/^0+/, '') || '0';
  // Ajustar por exponente: desplazar la coma hasta 12 decimales.
  const targetExp = 12;
  const shift = targetExp + exp;
  if (shift > 0) digits += '0'.repeat(shift);
  else if (shift < 0) {
    const cut = -shift;
    if (cut >= digits.length) return 0n;
    const keep = digits.slice(0, digits.length - cut);
    const rest = digits.slice(digits.length - cut);
    digits = keep;
    // Redondeo mitad hacia arriba sobre el resto descartado.
    if (rest[0] >= '5') digits = (BigInt(digits) + 1n).toString();
  }
  return BigInt(digits);
}

function fromScaled(v) {
  if (!v) return 0;
  return Number(v) / Number(SCALE);
}

// Descuenta la comision de la moneda ORIGEN antes de convertir a destino.
// Devuelve { commissionUsd, commissionAmount (en fromSymbol), netToAmount (en toSymbol),
//           percent }.
// - Si el admin configuró un % (erleoCommissionPercent), la comision es ese % del monto bruto.
// - Si el % es 0 o no hay precios para convertir, se usa el fallback USD fijo por velocidad.
// estRate = tasa estimada to/from que envio la app (toAmount / fromAmount).
export async function computeNetAmount(order) {
  // % de la moneda DESTINO (la que el Cerebro entrega desde su reserva);
  // si no esta configurada, cae al % global; si tampoco, a USD fijo.
  const percent = await coinCommissionPercent(order.toSymbol);

  let commissionAmount = 0;
  let commissionUsd = 0;

  if (percent > 0) {
    // Comision como % del monto bruto en la moneda origen, con aritmetica
    // decimal exacta: commissionAmount = fromAmount * percent / 100.
    const gross = toScaled(order.fromAmount);
    const commissionScaled = mulDivScaled(gross, percent, 100);
    commissionAmount = fromScaled(commissionScaled);
    const fromPrice = await priceUsd(order.fromSymbol);
    if (fromPrice != null && fromPrice > 0) {
      commissionUsd = fromScaled(mulDivScaled(commissionScaled, fromPrice, 1));
    } else {
      // Sin precio no se puede calcular el USD; se descarta el %.
      commissionAmount = 0;
    }
  }

  if (commissionAmount <= 0) {
    // Fallback: USD fijo por velocidad (regla anterior).
    commissionUsd = await commissionUsdFor(order.speed, order.toSymbol);
    commissionAmount = await usdToCrypto(commissionUsd, order.fromSymbol);
    if (commissionAmount == null) return null;
  }

  const grossFrom = order.fromAmount;
  const netFrom = grossFrom - commissionAmount;
  if (netFrom <= 0) {
    return { commissionUsd, commissionAmount, netToAmount: 0, insufficient: true, percent };
  }

  // Convertir a la moneda destino. Preferir la tasa de la app; si no, usar precios de mercado.
  let netToAmount = 0;
  const appRate = order.appRate; // toAmount / fromAmount
  if (appRate && appRate > 0) {
    // netToAmount = netFrom * appRate, con aritmetica escalada exacta:
    // netToScaled = netFromScaled * rateScaled / SCALE.
    const netFromScaled = toScaled(netFrom);
    const rateScaled = toScaled(appRate);
    netToAmount = fromScaled(mulDivScaled(netFromScaled, rateScaled, SCALE));
  } else {
    const fromUsd = await cryptoToUsd(netFrom, order.fromSymbol);
    const toPrice = await priceUsd(order.toSymbol);
    if (fromUsd != null && toPrice != null && toPrice > 0) {
      netToAmount = fromUsd / toPrice;
    }
  }

  return { commissionUsd, commissionAmount, netToAmount, insufficient: false, percent };
}

// Registra la comision en la contabilidad SEPARADA (categoria Intercambios Erleo).
export async function recordCommissionEvent(order, commissionUsd, commissionAmount, netToAmount, providerFeeSavedUsd = 0) {
  await db.prepare(`
    INSERT INTO commission_events
      (orderId, fromSymbol, toSymbol, speed, commissionUsd, commissionSymbol,
       commissionAmount, grossFromAmount, netToAmount, providerFeeSavedUsd, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    order.id, order.fromSymbol, order.toSymbol, order.speed, commissionUsd,
    order.fromSymbol, commissionAmount, order.fromAmount, netToAmount,
    providerFeeSavedUsd, nowIso()
  );
}
