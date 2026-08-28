// ============================================================
// GANANCIAS DEL ADMIN (cuenta separada de la liquidez/reserva)
// ============================================================
// Entrelaza dos realidades:
//   1. La RESERVA (liquidez): el saldo on-chain real de las direcciones de
//      pago del admin; es el "capital" que se mueve para atender intercambios.
//   2. La GANANCIA: lo que el admin ha COBRADO de comisiones y acumulado por
//      moneda, retirable SIN costo a su cuenta principal.
// El admin puede retirar sus ganancias sin tocar la liquidez que sigue en juego.
// ============================================================
import { db } from '../db/index.js';

// Suma de comisiones acumuladas por comision en moneda C (desde commission_events).
export async function gainedPerCoin() {
  const rows = await db
    .prepare(
      `SELECT commissionSymbol AS symbol,
              COALESCE(SUM(commissionAmount), 0) AS gain
         FROM commission_events
        GROUP BY commissionSymbol`
    )
    .all();
  const map = {};
  for (const r of rows) map[r.symbol] = r.gain;
  return map;
}

// Leer ganancia persistida (retirable) de una moneda.
export async function gainForSymbol(symbol) {
  const row = await db.prepare('SELECT gain FROM earnings WHERE symbol = ?').get(String(symbol || '').toUpperCase());
  return row ? Number(row.gain) : 0;
}

export async function allEarnings() {
  const rows = await db.prepare('SELECT * FROM earnings').all();
  const map = {};
  for (const r of rows) map[r.symbol] = Number(r.gain);
  return map;
}

// Depositamos ganancia acumulada de un evento de comision ya registrado.
export async function accrueGainFromEvent(commissionSymbol, commissionAmount) {
  const sym = String(commissionSymbol || '').toUpperCase();
  const amount = Number(commissionAmount) || 0;
  if (!sym || amount <= 0) return;
  await db
    .prepare(
      `INSERT INTO earnings (symbol, gain) VALUES (?, ?)
       ON CONFLICT(symbol) DO UPDATE SET gain = gain + excluded.gain`
    )
    .run(sym, amount);
}

// Retirar ganancia acumulada de una moneda a la direccion principal del admin.
// Devuelve { ok, symbol, amount, remaining, alreadyWithdrawn }.
export async function withdrawGain(symbol, { toAddress = '', note = '', txHash = '' } = {}) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return { error: 'moneda invalida' };
  const gain = await gainForSymbol(sym);
  if (gain <= 0) return { error: 'No hay ganancias retirables para ' + sym, alreadyWithdrawn: true };

  await db
    .prepare('DELETE FROM earnings WHERE symbol = ? AND gain <= 0')
    .run(sym);
  await db.prepare('UPDATE earnings SET gain = 0 WHERE symbol = ?').run(sym);

  await db
    .prepare(
      `INSERT INTO earnings_withdrawals (symbol, amount, toAddress, txHash, note, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(sym, gain, toAddress || '', txHash || '', note || '', new Date().toISOString());

  return { ok: true, symbol: sym, amount: gain, remaining: 0, toAddress: toAddress || '' };
}

// Historial de retiros (para el panel / app).
export async function withdrawalHistory({ limit = 200 } = {}) {
  return db
    .prepare('SELECT * FROM earnings_withdrawals ORDER BY id DESC LIMIT ?')
    .all(limit);
}

// Estado completo por moneda: { symbol, reserveOnChain, gain, available }.
// Aqui "reserva" es lo que el admin humano reporta manualmente (addrTool/balance)
// o lo que este sincronizado; si no hay dato, se conserva lo persistido.
export async function statusPerCoin(persistedReserves = {}) {
  const gained = await gainedPerCoin();
  const earnings = await allEarnings();
  const symbols = new Set([
    ...Object.keys(gained),
    ...Object.keys(earnings),
    ...Object.keys(persistedReserves || {}),
  ]);
  const out = {};
  for (const sym of symbols) {
    const gain = Math.max(Number(earnings[sym]) || 0, Number(gained[sym]) || 0);
    // La reserva se lee del objeto {reserve} si viene anidado, si es numero plano
    // se usa directo; siempre cae a 0 en vez de NaN/null.
    let reserve = persistedReserves[sym]?.reserve ?? persistedReserves[sym] ?? 0;
    if (!Number.isFinite(Number(reserve))) reserve = 0;
    out[sym] = {
      symbol: sym,
      reserve: Number(reserve) || 0,
      gain,
      available: gain, // la ganancia acumulada es retirable sin costo
    };
  }
  return out;
}
