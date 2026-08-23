import { db } from '../db/index.js';
import * as balanceService from './balance.js';
import { priceUsd } from './prices.js';

// Reportes de contabilidad SEPARADA: categoria "Comisiones - Intercambios Erleo".
export async function commissionReport({ from, to, symbol, limit = 500 } = {}) {
  let sql = 'SELECT * FROM commission_events';
  const clauses = [];
  const params = [];
  if (from) { clauses.push('createdAt >= ?'); params.push(new Date(from).toISOString()); }
  if (to) { clauses.push('createdAt <= ?'); params.push(new Date(to).toISOString()); }
  if (symbol) { clauses.push('(fromSymbol = ? OR toSymbol = ?)'); params.push(symbol.toUpperCase(), symbol.toUpperCase()); }
  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
  sql += ' ORDER BY createdAt DESC LIMIT ?';
  params.push(Math.min(Math.max(Number(limit) || 500, 1), 5000));
  const rows = await db.prepare(sql).all(...params);

  const totals = rows.reduce(
    (acc, r) => {
      acc.totalCommissionUsd += r.commissionUsd || 0;
      acc.totalProviderFeeSavedUsd += r.providerFeeSavedUsd || 0;
      acc.count += 1;
      return acc;
    },
    { totalCommissionUsd: 0, totalProviderFeeSavedUsd: 0, count: 0 }
  );
  return { events: rows, totals };
}

// Resumen del dashboard: pendientes, totales por estado y saldos de reserva
// con su valor de mercado (Binance) para que el admin vea qué tiene disponible.
export async function dashboardSummary() {
  const byStatus = await db.prepare('SELECT status, COUNT(*) as c FROM orders GROUP BY status').all();
  const summary = { pending: 0, approved: 0, rejected: 0, completed: 0, cancelled: 0 };
  for (const row of byStatus) summary[row.status] = row.c;
  const pending = await db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY createdAt DESC').all('pending');
  const approved = await db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY updatedAt DESC').all('approved');
  const recent = await db.prepare('SELECT * FROM orders ORDER BY createdAt DESC LIMIT 20').all();

  const reserves = await db.prepare('SELECT * FROM coin_addresses WHERE network = ? ORDER BY symbol').all('');
  const balances = [];
  for (const r of reserves) {
    const usdPrice = await priceUsd(r.symbol);
    // Saldo disponible: on-chain si hay nodo, sino el balance manual configurado.
    let available = Number(r.balance) || 0;
    let source = 'manual';
    const addr = (r.payoutAddress || r.address || '').trim();
    if (addr) {
      try {
        const onchain = await balanceService.fetchBalance(r.symbol, addr);
        if (onchain != null) { available = onchain; source = 'node'; }
      } catch (_) {}
    }
    balances.push({
      symbol: r.symbol,
      balance: available,
      enabled: r.enabled === 1,
      address: r.address,
      priceUsd: usdPrice,
      balanceUsd: usdPrice != null ? available * usdPrice : null,
      balanceSource: source,
    });
  }

  return { summary, pending, approved, recent, balances };
}
