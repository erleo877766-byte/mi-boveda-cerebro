// Precios de mercado con fallback Binance + CoinGecko.
// Cache en memoria de 15s + poller de fondo que refresca toda la lista para
// que el panel y la billetera vean precios lo mas vivos posible.

import { mapLimit } from '../utils.js';
import { recordPrice } from './autonomous.js';

const BINANCE = 'https://api.binance.com/api/v3/ticker/price?symbol=';
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price';
const COINGECKO_CONTRACT = 'https://api.coingecko.com/api/v3/coins';
const COINBASE = 'https://api.coinbase.com/v2/prices/';
const KRAKEN = 'https://api.kraken.com/0/public/Ticker?pair=';
const PAPRIKA = 'https://api.coinpaprika.com/v1/tickers';
// Pares de Kraken para monedas ausentes en Binance/Coinbase (bloqueos o listados).
const KRAKEN_PAIR = { XMR: 'XMRUSD', XNO: 'NANOUSD', BAN: 'BANUSD', WOW: 'WOWUSD' };
const CACHE_TTL_MS = 15_000;

// Red EVM -> cadena de CoinGecko (para tokens personalizados por contrato).
const NETWORK_CG_CHAIN = {
  ethereum: 'ethereum', erc20: 'ethereum', bep20: 'bnb-smart-chain',
  base: 'base', arbitrum: 'arbitrum-one', polygon: 'polygon-pos',
  tron: 'tron', trc20: 'tron',
};

// Mapeo ticker -> id de CoinGecko. Se usa como respaldo cuando Binance no
// responde (p.ej. bloqueo geografico de Binance en servidores de EE.UU.).
const TICKER_TO_COINGECKO = {
  XHV: 'haven', ZANO: 'zano', WOW: 'wownero', BAN: 'banano',
  WETH: 'weth', STETH: 'staked-ether', FLIP: 'chainflip',
  XMR: 'monero', XNO: 'nano', XRP: 'ripple',
  BTC: 'bitcoin', ETH: 'ethereum', LTC: 'litecoin', BCH: 'bitcoin-cash',
  DOGE: 'dogecoin', DASH: 'dash', SOL: 'solana', TRX: 'tron',
  BNB: 'binancecoin', ADA: 'cardano', MATIC: 'matic-network', POL: 'polygon-ecosystem-token',
  USDT: 'tether', USDC: 'usd-coin', DAI: 'dai', WBTC: 'wrapped-bitcoin',
  SHIB: 'shiba-inu', PEPE: 'pepe', UNI: 'uniswap', AAVE: 'aave',
  COMP: 'compound-governance-token', MKR: 'maker', LDO: 'lido-dao',
  GRT: 'the-graph', STORJ: 'storj', BAT: 'basic-attention-token',
  ZRX: '0x', OXT: 'orchid', NEXO: 'nexo', CAKE: 'pancakeswap-token',
  ENS: 'ethereum-name-service', GTC: 'gitcoin', TUSD: 'true-usd',
  GUSD: 'gemini-dollar', FRAX: 'frax', USDE: 'ethena-usde',
  PAXG: 'pax-gold', MANA: 'decentraland', CRO: 'crypto-com-chain',
  ARB: 'arbitrum', AVAX: 'avalanche-2', FTM: 'fantom', OP: 'optimism',
  DEURO: 'deuro', DEPS: 'deps', NDEPS: 'ndeps',
  APE: 'apecoin', BTT: 'bittorrent', BTTC: 'bittorrent', DCR: 'decred',
  DGB: 'digibyte', DYDX: 'dydx', FIRO: 'firo', HBAR: 'hedera-hashgraph',
  KAS: 'kaspa', KMD: 'komodo', PIVX: 'pivx', RUNE: 'thorchain',
  RVN: 'ravencoin', SC: 'siacoin', SCRT: 'secret', STX: 'blockstack',
  'USDC.E': 'usd-coin', XVG: 'verge', ZEN: 'horizen',
};

// Simbolos de monedas personalizadas -> { network, contractAddress }.
let customSources = new Map();

const cache = new Map(); // symbol -> { price, at }

// CoinPaprika: sin clave y sin rate-limit estricto; 1 peticion trae TODO.
const PAPRIKA_TTL_MS = 120_000;
let paprikaCache = { at: 0, map: new Map() };
async function paprikaMap() {
  if (paprikaCache.map.size && Date.now() - paprikaCache.at < PAPRIKA_TTL_MS) return paprikaCache.map;
  const data = await fetchJson(PAPRIKA);
  const m = new Map();
  for (const t of Array.isArray(data) ? data : []) {
    const sym = String(t.symbol || '').toUpperCase();
    const usd = t.quotes && t.quotes.USD && t.quotes.USD.price;
    if (sym && usd != null) m.set(sym, Number(usd));
  }
  const alias = { 'USDC.E': 'USDC', BTTC: 'BTT' };
  for (const [a, b] of Object.entries(alias)) {
    if (!m.has(a) && m.has(b)) m.set(a, m.get(b));
  }
  paprikaCache = { at: Date.now(), map: m };
  return m;
}
let pollerTimer = null;
let refreshInFlight = false;

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Registra los simbolos personalizados para poder buscar su precio por contrato.
export function setCustomCoinSources(list) {
  customSources = new Map();
  for (const c of list || []) {
    if (c && c.symbol && c.contractAddress) {
      customSources.set(c.symbol.toUpperCase(), { network: c.network, contractAddress: c.contractAddress });
    }
  }
}

// Resuelve de UNA sola vez todos los simbolos que no tengan cache fresca:
// 1 peticion a CoinGecko + 1 a CoinPaprika. Evita rate-limits.
export async function resolveBatch(symbols) {
  const now = Date.now();
  const uncached = [];
  for (const s of symbols || []) {
    const key = String(s || '').toUpperCase();
    const hit = cache.get(key);
    if (!hit || now - hit.at > CACHE_TTL_MS) uncached.push(key);
  }
  if (!uncached.length) return;

  // CoinPaprika primero (sin limites y cubre casi todo).
  try {
    const pm = await paprikaMap();
    for (const s of uncached) {
      const p = pm.get(s);
      if (p != null && p > 0) cache.set(s, { price: Number(p), at: Date.now() });
    }
  } catch (_) {}

  // CoinGecko para lo que Paprika no tenga (ids especificos).
  const ids = [...new Set(uncached.map((s) => TICKER_TO_COINGECKO[s]).filter(Boolean))];
  if (!ids.length) return;
  try {
    const data = await fetchJson(`${COINGECKO}?ids=${ids.join(',')}&vs_currencies=usd`);
    for (const s of uncached) {
      const id = TICKER_TO_COINGECKO[s];
      const usd = id && data && data[id] && data[id].usd;
      if (usd != null) cache.set(s, { price: Number(usd), at: Date.now() });
    }
  } catch (_) {}
}

// Precio de un simbolo en USD. force=true ignora la cache (lo usa el poller).
export async function priceUsd(symbol, force = false) {
  const key = symbol.toUpperCase();
  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.price;

  let price = null;

  const ticker = key === 'MATIC' ? 'POL' : key;
  // Fuente 1: Binance (la mas rapida; puede fallar por bloqueo geografico).
  const bin = await fetchJson(`${BINANCE}${ticker}USDT`);
  if (bin && bin.price) {
    price = parseFloat(bin.price);
  }
  // Fuente 2: Coinbase (sin clave, funciona desde EE.UU.).
  if (price == null) {
    const cb = await fetchJson(`${COINBASE}${ticker}-USD/spot`);
    if (cb && cb.data && cb.data.amount && Number(cb.data.amount) > 0) {
      price = parseFloat(cb.data.amount);
    }
  }
  // Fuente 3: Kraken (para XMR, XNO y similares sin par en las anteriores).
  if (price == null) {
    const kp = KRAKEN_PAIR[key];
    if (kp) {
      const kr = await fetchJson(`${KRAKEN}${kp}`);
      if (kr && kr.result && (!kr.error || kr.error.length === 0)) {
        const first = Object.values(kr.result)[0];
        const last = first && first.c && first.c[0];
        if (last && Number(last) > 0) price = parseFloat(last);
      }
    }
  }
  // Fuente 4: CoinPaprika (sin clave; cubre ~2000 monedas en 1 peticion).
  if (price == null) {
    try {
      const pm = await paprikaMap();
      const pp = pm.get(key);
      if (pp != null && pp > 0) price = pp;
    } catch (_) {}
  }
  if (price == null && customSources.has(key)) {
    // Token personalizado (EVM/TRC20): buscar por contrato en CoinGecko.
    const src = customSources.get(key);
    const chain = NETWORK_CG_CHAIN[src.network];
    if (chain && src.contractAddress) {
      const cg = await fetchJson(`${COINGECKO_CONTRACT}/${chain}/contract/${src.contractAddress}`);
      if (cg && cg.market_data && cg.market_data.current_price && cg.market_data.current_price.usd) {
        price = parseFloat(cg.market_data.current_price.usd);
      }
    }
  }
  if (price == null) {
    const cgId = TICKER_TO_COINGECKO[key];
    if (cgId) {
      const cg = await fetchJson(`${COINGECKO}?ids=${cgId}&vs_currencies=usd`);
      if (cg && cg[cgId] && cg[cgId].usd) price = parseFloat(cg[cgId].usd);
    }
  }

  if (price != null && price > 0) {
    cache.set(key, { price, at: Date.now() });
    recordPrice(key, price);
    return price;
  }
  return cached ? cached.price : null;
}

// Refresca en paralelo la lista completa de simbolos (ignorando cache).
async function refreshAll(symbols) {
  if (refreshInFlight || !symbols || symbols.length === 0) return;
  refreshInFlight = true;
  try {
    await mapLimit(symbols, 10, async (symbol) => {
      await priceUsd(symbol, true);
    });
  } catch {
    // fallos individuales se ignoran: el cache conserva el ultimo conocido
  } finally {
    refreshInFlight = false;
  }
}

// Arranca el poller de fondo: cada 15s refresca todos los precios.
export function startPricePoller(symbols, intervalMs = 15_000) {
  if (pollerTimer) clearInterval(pollerTimer);
  refreshAll(symbols);
  pollerTimer = setInterval(() => refreshAll(symbols), intervalMs);
  if (pollerTimer.unref) pollerTimer.unref();
  return pollerTimer;
}

// Convierte un monto USD a cantidad de cripto. Devuelve null si no hay precio.
export async function usdToCrypto(usd, symbol) {
  const price = await priceUsd(symbol);
  if (price == null || price <= 0) return null;
  return usd / price;
}

// Convierte una cantidad de cripto a USD.
export async function cryptoToUsd(amount, symbol) {
  const price = await priceUsd(symbol);
  if (price == null) return null;
  return amount * price;
}
