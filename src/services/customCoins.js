// Criptomonedas personalizadas: las agrega el admin desde el panel y se
// propagan solas a la app (feeAddress, tokens EVM/TRC20) via /config.

import { db, nowIso } from '../db/index.js';

export const NETWORKS = {
  nano: 'Nano',
  bitcoin: 'Bitcoin',
  ethereum: 'Ethereum (ERC20)',
  erc20: 'ERC20 (red al elegir)',
  bep20: 'BSC (BEP20)',
  base: 'Base (ERC20)',
  arbitrum: 'Arbitrum (ERC20)',
  polygon: 'Polygon (ERC20)',
  tron: 'Tron',
  trc20: 'TRC20',
  solana: 'Solana',
  custom: 'Otra / personalizada',
};

// Red EVM a la que pertenece cada network (para precio por contrato).
export const NETWORK_COINGECKO_CHAIN = {
  ethereum: 'ethereum',
  erc20: 'ethereum',
  bep20: 'bnb-smart-chain',
  base: 'base',
  arbitrum: 'arbitrum-one',
  polygon: 'polygon-pos',
  tron: 'tron',
  trc20: 'tron',
};

const RE_NANO = /^(nano|xrb)_[1-9a-z]{60}$/i;
const RE_BTC = /^(1|3)[1-9A-HJ-NP-Za-km-z]{25,33}$|^bc1[a-z0-9]{39,59}$/i;
const RE_EVM = /^0x[a-fA-F0-9]{40}$/;
const RE_TRON = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const RE_SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const RE_SYMBOL = /^[A-Z0-9]{2,12}$/;

export function isEvmNetwork(network) {
  return ['ethereum', 'erc20', 'bep20', 'base', 'arbitrum', 'polygon'].includes(network);
}

export function validateAddress(network, address) {
  if (!address || !String(address).trim()) return null;
  const addr = String(address).trim();
  switch (network) {
    case 'nano':
      return RE_NANO.test(addr) ? null : 'Dirección Nano inválida (debe ser nano_ o xrb_ + 60 caracteres)';
    case 'bitcoin':
      return RE_BTC.test(addr) ? null : 'Dirección Bitcoin inválida';
    case 'ethereum':
    case 'erc20':
    case 'bep20':
    case 'base':
    case 'arbitrum':
    case 'polygon':
      return RE_EVM.test(addr) ? null : 'Dirección EVM inválida (0x + 40 hex)';
    case 'tron':
    case 'trc20':
      return RE_TRON.test(addr) ? null : 'Dirección Tron inválida (T + 33)';
    case 'solana':
      return RE_SOLANA.test(addr) ? null : 'Dirección Solana inválida';
    default:
      return null;
  }
}

function validate(data) {
  const symbol = String(data.symbol || '').trim().toUpperCase();
  if (!RE_SYMBOL.test(symbol)) {
    return { error: 'Símbolo inválido: solo letras y números, entre 2 y 12 caracteres (ej. ERLEO, XNO).' };
  }
  const name = String(data.name || '').trim();
  if (!name) return { error: 'El nombre de la moneda es obligatorio.' };
  const network = String(data.network || '').trim().toLowerCase();
  if (!NETWORKS[network]) return { error: `Red inválida. Usa una de: ${Object.keys(NETWORKS).join(', ')}.` };

  let contractAddress = String(data.contractAddress || '').trim();
  if (isEvmNetwork(network) || network === 'trc20') {
    if (!contractAddress) return { error: 'Los tokens necesitan la dirección del contrato.' };
    const err = network === 'trc20'
      ? validateAddress('tron', contractAddress)
      : validateAddress('ethereum', contractAddress);
    if (err) return { error: `Contrato inválido: ${err}` };
  } else {
    contractAddress = '';
  }

  const feeAddress = String(data.feeAddress || '').trim();
  const reserveAddress = String(data.reserveAddress || '').trim();
  const feeErr = validateAddress(network, feeAddress);
  if (feeErr) return { error: `Cobro de comisiones: ${feeErr}` };
  const reserveErr = validateAddress(network, reserveAddress);
  if (reserveErr) return { error: `Reserva: ${reserveErr}` };

  const logo = String(data.logo || '').trim();
  if (logo && logo.length > 400_000) return { error: 'El logo es demasiado grande (máx ~400 KB).' };

  // Nodos opcionales: lista de URIs (http/https) que se agregan solos a la
  // pestaña Nodos al guardar la moneda. Acepta "https://..." o solo el host;
  // cualquier esquema que no sea http/https se rechaza.
  let nodes = [];
  const rawNodes = Array.isArray(data.nodes) ? data.nodes : [];
  for (const raw of rawNodes) {
    const uri = String(raw || '').trim();
    if (!uri) continue;
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(uri) ? uri : 'https://' + uri;
    let parsed;
    try {
      parsed = new URL(withScheme);
    } catch {
      return { error: `Nodo inválido: ${uri}. Usa una URL completa (ej. https://nodo.ejemplo.com)` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: `Nodo inválido: ${uri}. Solo se admiten URLs http/https.` };
    }
    nodes.push(parsed.toString());
  }

  return {
    value: {
      symbol, name, network, contractAddress, logo,
      feeAddress, reserveAddress, nodes,
      enabled: data.enabled === false ? 0 : 1,
    },
  };
}

export async function listCustomCoins() {
  const rows = await db.prepare('SELECT * FROM custom_coins ORDER BY symbol').all();
  const result = [];
  for (const r of rows) {
    result.push({
      id: r.id,
      symbol: r.symbol,
      name: r.name,
      network: r.network,
      contractAddress: r.contractAddress || '',
      logo: r.logo || '',
      feeAddress: r.feeAddress || '',
      reserveAddress: r.reserveAddress || '',
      enabled: r.enabled === 1,
      createdAt: r.createdAt,
      nodes: await nodesForSymbol(r.symbol),
    });
  }
  return result;
}

export async function getCustomCoin(symbol) {
  const row = await db.prepare('SELECT * FROM custom_coins WHERE UPPER(symbol) = UPPER(?)').get(String(symbol || ''));
  if (!row) return undefined;
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    network: row.network,
    contractAddress: row.contractAddress || '',
    logo: row.logo || '',
    feeAddress: row.feeAddress || '',
    reserveAddress: row.reserveAddress || '',
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    nodes: await nodesForSymbol(row.symbol),
  };
}

// True si el simbolo es una moneda personalizada ACTIVA (para aceptarla en
// ordenes de intercambio, comisiones y config como si fuera una de fabrica).
export async function isCustomSymbol(symbol) {
  const row = await db
    .prepare('SELECT id FROM custom_coins WHERE UPPER(symbol) = UPPER(?) AND enabled = 1')
    .get(String(symbol || ''));
  return !!row;
}

// Nodos registrados para un simbolo (para mostrarlos en el formulario).
export async function nodesForSymbol(symbol) {
  const rows = await db
    .prepare('SELECT uri, name FROM nodes WHERE symbol = ? ORDER BY id')
    .all(String(symbol || '').toUpperCase());
  return rows.map((r) => ({ uri: r.uri, name: r.name }));
}

// Agrega nodos a un simbolo SOLO si no existen (nunca borra los que el admin
// agregó aparte). Devuelve cuántos se agregaron.
export async function seedNodesForSymbol(symbol, uris = []) {
  let added = 0;
  for (const raw of uris) {
    const uri = String(raw || '').trim();
    if (!uri) continue;
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(uri) ? uri : 'https://' + uri;
    let parsed;
    try {
      parsed = new URL(withScheme);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    const finalUri = parsed.toString();
    const exists = await db
      .prepare('SELECT id FROM nodes WHERE symbol = ? AND uri = ?')
      .get(symbol, finalUri);
    if (exists) continue;
    await db.prepare(`
      INSERT INTO nodes (symbol, name, uri, useSsl, trusted, isOfficial, isDefault, autoSwitch, enabled, createdAt)
      VALUES (?, ?, ?, 1, 0, 0, 0, 1, 1, ?)
    `).run(symbol, parsed.hostname, finalUri, nowIso());
    added++;
  }
  return added;
}

export async function createCustomCoin(data) {
  const v = validate(data);
  if (v.error) return { error: v.error };
  const { value } = v;

  const exists = await db.prepare('SELECT symbol FROM custom_coins WHERE UPPER(symbol) = UPPER(?)').get(value.symbol);
  if (exists) return { error: `La moneda ${value.symbol} ya existe.` };

  // Sincronizar la direccion de cobro con coin_addresses para que el flujo de
  // comisiones y reservas la use igual que el resto.
  const existing = await db.prepare('SELECT symbol FROM coin_addresses WHERE UPPER(symbol) = UPPER(?) AND network = ?').get(value.symbol, '');
  if (existing) {
    await db.prepare(
      'UPDATE coin_addresses SET address = ?, payoutAddress = ?, enabled = ? WHERE UPPER(symbol) = UPPER(?) AND network = ?'
    ).run(value.feeAddress, value.reserveAddress, value.enabled, value.symbol, '');
  } else {
    await db.prepare(
      'INSERT OR IGNORE INTO coin_addresses (symbol, network, address, receiveAddress, payoutAddress, balance, enabled) VALUES (?, ?, ?, ?, ?, 0, ?)'
    ).run(value.symbol, '', value.feeAddress, '', value.reserveAddress, value.enabled);
  }

  await db.prepare(
    `INSERT INTO custom_coins (symbol, name, network, contractAddress, logo, feeAddress, reserveAddress, enabled, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(value.symbol, value.name, value.network, value.contractAddress, value.logo,
        value.feeAddress, value.reserveAddress, value.enabled, nowIso());

  // Propagar a comisiones: la moneda aparece en la pestaña Comisiones Erleo
  // con su % (0 = usa la regla global o el valor fijo por velocidad).
  await db.prepare(
    'INSERT OR IGNORE INTO coin_commissions (symbol, percent) VALUES (?, 0)'
  ).run(value.symbol);

  // Propagar a nodos: si el admin escribió nodos, se agregan solos; si no,
  // la moneda queda vacía y la auto-selección funciona apenas se agreguen.
  await seedNodesForSymbol(value.symbol, value.nodes);

  return { coin: await getCustomCoin(value.symbol) };
}

export async function updateCustomCoin(id, data) {
  const row = await db.prepare('SELECT * FROM custom_coins WHERE id = ?').get(Number(id));
  if (!row) return { error: 'Moneda no encontrada.' };

  const v = validate({ ...data, symbol: data.symbol ? data.symbol : row.symbol });
  if (v.error) return { error: v.error };
  const { value } = v;

  if (value.symbol !== row.symbol) {
    const exists = await db.prepare('SELECT symbol FROM custom_coins WHERE UPPER(symbol) = UPPER(?) AND id != ?').get(value.symbol, Number(id));
    if (exists) return { error: `La moneda ${value.symbol} ya existe.` };
  }

  await db.prepare(
    `UPDATE custom_coins
       SET symbol = ?, name = ?, network = ?, contractAddress = ?, logo = ?, feeAddress = ?, reserveAddress = ?, enabled = ?
     WHERE id = ?`
  ).run(value.symbol, value.name, value.network, value.contractAddress, value.logo,
        value.feeAddress, value.reserveAddress, value.enabled, Number(id));

  const ca = await db.prepare('SELECT symbol FROM coin_addresses WHERE UPPER(symbol) = UPPER(?) AND network = ?').get(row.symbol, '');
  if (ca) {
    await db.prepare(
      'UPDATE coin_addresses SET symbol = ?, address = ?, payoutAddress = ?, enabled = ? WHERE UPPER(symbol) = UPPER(?) AND network = ?'
    ).run(value.symbol, value.feeAddress, value.reserveAddress, value.enabled, row.symbol, '');
  }

  // Mantener la fila de comisión (por si el símbolo cambió) y propagar nodos:
  // solo se agregan los que no existan; nunca se borran nodos agregados aparte.
  await db.prepare(
    'INSERT OR IGNORE INTO coin_commissions (symbol, percent) VALUES (?, 0)'
  ).run(value.symbol);
  if (Array.isArray(data.nodes)) {
    await seedNodesForSymbol(value.symbol, data.nodes);
  }

  return { coin: await getCustomCoin(value.symbol) };
}

export async function setCustomCoinEnabled(id, enabled) {
  await db.prepare('UPDATE custom_coins SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, Number(id));
  const coin = await db.prepare('SELECT * FROM custom_coins WHERE id = ?').get(Number(id));
  if (coin) {
    await db.prepare(
      'UPDATE coin_addresses SET enabled = ? WHERE UPPER(symbol) = UPPER(?) AND network = ?'
    ).run(enabled ? 1 : 0, coin.symbol, '');
  }
  return { ok: true };
}

export async function removeCustomCoin(id) {
  const row = await db.prepare('SELECT * FROM custom_coins WHERE id = ?').get(Number(id));
  if (!row) return { error: 'Moneda no encontrada.' };
  await db.prepare('DELETE FROM custom_coins WHERE id = ?').run(Number(id));
  // Limpiar referencias: direcciones, comisiones y nodos de esa moneda.
  await db.prepare('DELETE FROM coin_addresses WHERE UPPER(symbol) = UPPER(?)').run(row.symbol);
  await db.prepare('DELETE FROM coin_commissions WHERE UPPER(symbol) = UPPER(?)').run(row.symbol);
  await db.prepare('DELETE FROM nodes WHERE UPPER(symbol) = UPPER(?)').run(row.symbol);
  return { ok: true, symbol: row.symbol };
}

// Simbolos de monedas personalizadas ACTIVAS (para el mercado, el config y el
// panel). Las desactivadas dejan de aparecer, pero no se borran.
export async function customSymbols() {
  const rows = await db.prepare('SELECT symbol, network, contractAddress FROM custom_coins WHERE enabled = 1').all();
  return rows.map((r) => ({
    symbol: r.symbol,
    network: r.network,
    contractAddress: r.contractAddress || '',
  }));
}
