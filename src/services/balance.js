// ============================================================
// Consulta de saldo on-chain de las direcciones de reserva del admin.
// El Cerebro verifica SOLO (sin que el admin haga nada) si hay saldo
// suficiente en la direccion de reserva para completar una orden.
// Usa los nodos del Cerebro (tabla nodes) por familia de moneda.
// Si no hay nodo/protocolo para consultar, cae al balance manual.
// ============================================================
import { db } from '../db/index.js';

const TIMEOUT_MS = 6000;

async function rpcGet(uri, path = '', params = {}, headers = {}) {
  const url = uri.replace(/\/+$/, '') + path;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(params),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function jsonGet(uri, path = '', headers = {}) {
  const url = uri.replace(/\/+$/, '') + path;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// El nodo "mejor" de una moneda: activo, con mayor cobertura y menor latencia.
// Auto-selección inteligente: el Cerebro elige solo y la app SIEMPRE le pregunta.
async function bestNodeUri(symbol) {
  const rows = await db.prepare(
    'SELECT * FROM nodes WHERE symbol = ? AND enabled = 1 ORDER BY coverage DESC, latencyMs ASC, isDefault DESC, id ASC LIMIT 1'
  ).all(symbol);
  if (!rows.length) return null;
  return rows[0].uri;
}

// Saldo de una direccion. Devuelve Number (en unidades base de la moneda)
// o null si no se puede consultar (-> usar balance manual).
export async function fetchBalance(symbol, address) {
  if (!symbol || !address) return null;
  const sym = String(symbol).toUpperCase();
  const uri = await bestNodeUri(sym);
  if (!uri) return null;
  const addr = String(address).trim();

  try {
    // ---------- Nano / Banano (nano RPC: account_balance) ----------
    if (sym === 'XNO' || sym === 'BAN') {
      const r = await rpcGet(uri, '', { action: 'account_balance', account: addr });
      if (r && r.balance != null) return Number(r.balance) / 1e30;
      return null;
    }

    // ---------- EVM nativo (ETH y tokens ERC20) ----------
    if (sym === 'ETH' || sym === 'WETH' || sym === 'USDT' || sym === 'USDC' || sym === 'USDC.E' ||
        sym === 'DAI' || sym === 'WBTC' || sym === 'WETH' || sym === 'STETH' || sym === 'POL' ||
        sym === 'MATIC' || sym === 'ARB' || sym === 'OP' || sym === 'BASE' || sym === 'BNB' ||
        sym === 'BSC' || sym === 'USDE' || sym === 'USDT') {
      if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return null;
      // Tokens ERC20: balanceOf via eth_call.
      const tokenSymbols = new Set(['WETH', 'USDT', 'USDC', 'USDC.E', 'DAI', 'WBTC', 'STETH', 'POL', 'MATIC', 'USDE']);
      if (tokenSymbols.has(sym)) {
        const decimals = { USDT: 6, USDC: 6, 'USDC.E': 6, DAI: 18, WBTC: 8, WETH: 18, STETH: 18, POL: 18, MATIC: 18, USDE: 18 };
        const r = await rpcGet(uri, '', {
          jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{
            to: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT mainnet por defecto
            data: '0x70a08231000000000000000000000000' + addr.replace(/^0x/, '').toLowerCase(),
          }, 'latest'],
        });
        if (r && r.result && r.result.length > 34) {
          const val = BigInt('0x' + r.result.slice(2));
          return Number(val) / 10 ** (decimals[sym] ?? 18);
        }
        return null;
      }
      const r = await rpcGet(uri, '', { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [addr, 'latest'] });
      if (r && r.result) return Number(BigInt(r.result)) / 1e18;
      return null;
    }

    // ---------- SOL (JSON-RPC getBalance) ----------
    if (sym === 'SOL') {
      const r = await rpcGet(uri, '', { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [addr] });
      if (r && r.result && r.result.value != null) return r.result.value / 1e9;
      return null;
    }

    // ---------- TRX (TronGrid API) ----------
    if (sym === 'TRX') {
      const r = await jsonGet(uri, `/v1/accounts/${addr}`, { accept: 'application/json' });
      if (r && r.data && r.data.length) return Number(r.data[0].balance) / 1e6;
      return null;
    }

    // ---------- BTC / LTC / DOGE / BCH / DASH / DCR (block explorers) ----------
    if (['BTC', 'LTC', 'DOGE', 'BCH', 'DASH', 'DCR'].includes(sym)) {
      // BTC: blockstream / mempool.space. LTC: litecoinspace. DOGE: dogechain. BCH: blockchair fallback.
      const r = await jsonGet(uri, `/api/address/${addr}`);
      if (r) {
        if (r.chain_stats && r.mempool_stats != null) {
          return (r.chain_stats.funded_txo_sum - r.chain_stats.spent_txo_sum) / 1e8;
        }
        if (r.balance != null && typeof r.balance === 'number') {
          // dogechain devuelve balance en unidades base.
          return r.balance;
        }
      }
      return null;
    }

    // ---------- XMR / otros: no hay consulta directa sin view key ----------
    return null;
  } catch (_) {
    return null;
  }
}

// Combina consulta on-chain con balance manual de coin_addresses.
// Devuelve { available, source: 'node'|'manual'|'none', error }.
export async function availableBalance(symbol, address, manualBalance = 0) {
  const onchain = await fetchBalance(symbol, address);
  if (onchain != null) return { available: onchain, source: 'node' };
  if (manualBalance != null && Number(manualBalance) > 0) return { available: Number(manualBalance), source: 'manual' };
  return { available: 0, source: 'none' };
}
