// ============================================================
// Validacion COMPLETA de formato de direcciones por moneda y red.
// Capa de seguridad: evita enviar fondos a direcciones invalidas,
// de red equivocada, o con errores de tipeo.
//
// Cubre TODAS las monedas de SUPPORTED_SYMBOLS + monedas custom
// (valida por su red: bitcoin, ethereum, tron, solana, nano, etc.)
// ============================================================

import { getCustomCoin } from './customCoins.js';

// ---- Charset helpers ----
const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
const BECH32_DATA = '[qpzry9x8gf2tvdw0s3jn54khce6mua7l]';

function bech32Regex(hrp) {
  return new RegExp(`^${hrp}(q${BECH32_DATA}{25,80}|p${BECH32_DATA}{38,90})$`);
}

const BTC_BECH32 = bech32Regex('bc1');
const BTC_BECH32M = new RegExp(`^bc1p${BECH32_DATA}{58,62}$`);
const LTC_BECH32 = bech32Regex('ltc1');
const DGB_BECH32 = bech32Regex('dgb');

function evm(a) { return /^0x[a-fA-F0-9]{40}$/.test(a); }
function base58addr(a, min, max) { return new RegExp(`^[1-9A-HJ-NP-Za-km-z]{${min},${max}}$`).test(a); }

const VALIDATORS = {
  // Bitcoin family
  BTC: (a) => {
    const l = a.toLowerCase();
    if (l.startsWith('bc1q') || l.startsWith('bc1p')) return BTC_BECH32.test(l) || BTC_BECH32M.test(l);
    if (/^[13]/.test(a)) return /^[13][1-9A-HJ-NP-Za-km-z]{25,33}$/.test(a);
    if (/^[mn]/.test(a)) return /^[mn][1-9A-HJ-NP-Za-km-z]{25,33}$/.test(a);
    return false;
  },
  LTC: (a) => {
    const l = a.toLowerCase();
    if (l.startsWith('ltc1')) return LTC_BECH32.test(l);
    return /^[LM3][1-9A-HJ-NP-Za-km-z]{25,33}$/.test(a);
  },
  BCH: (a) => /^(bitcoincash:)?[qp][a-z0-9]{41}$/i.test(a) || /^[13][1-9A-HJ-NP-Za-km-z]{25,33}$/.test(a),
  DASH: (a) => /^X[1-9A-HJ-NP-Za-km-z]{33}$/.test(a),
  DOGE: (a) => /^D[1-9A-HJ-NP-Za-km-z]{33}$/.test(a),
  DCR: (a) => /^D[ks][1-9A-HJ-NP-Za-km-z]{24,33}$/.test(a),
  DGB: (a) => a.toLowerCase().startsWith('dgb1') ? DGB_BECH32.test(a.toLowerCase()) : /^[AD][1-9A-HJ-NP-Za-km-z]{25,33}$/.test(a),
  RVN: (a) => /^R[1-9A-HJ-NP-Za-km-z]{33}$/.test(a),
  FIRO: (a) => /^Z[1-9A-HJ-NP-Za-km-z]{33}$/.test(a),
  PIVX: (a) => /^D[1-9A-HJ-NP-Za-km-z]{33}$/.test(a),
  KMD: (a) => /^R[1-9A-HJ-NP-Za-km-z]{33}$/.test(a),
  ZEN: (a) => /^z[SN][1-9A-HJ-NP-Za-km-z]{33}$/.test(a),

  // Monero family
  XMR: (a) => /^[48][1-9A-HJ-NP-Za-km-z]{94}$/.test(a) || /^[1-9A-HJ-NP-Za-km-z]{95}$/.test(a),
  WOW: (a) => /^WOW[1-9A-HJ-NP-Za-km-z]{94}$/.test(a),
  ZANO: (a) => /^[1-9A-HJ-NP-Za-km-z]{90,200}$/.test(a) || /^@[\w.-]+$/.test(a),
  XHV: (a) => /^(4|8)[1-9A-HJ-NP-Za-km-z]{94}$/.test(a),

  // Zcash
  ZEC: (a) => /^t1[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) || /^t3[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) || /^zs[a-z0-9]{76}$/.test(a) || /^u1[a-z0-9]{76,80}$/.test(a),

  // Nano / Banano
  XNO: (a) => /^(nano|xrb)_[13456789abcdefghijkmnopqrstuwxyz]{60}$/.test(a),
  BAN: (a) => /^ban_[13456789abcdefghijkmnopqrstuwxyz]{60}$/.test(a),

  // EVM native + tokens
  ETH: evm, MATIC: evm, POL: evm, BNB: evm, ARB: evm, AVAX: evm, FTM: evm, OP: evm, BASE: evm, SC: evm,
  DEPS: evm, NDEPS: evm, DEURO: evm, FLIP: evm,
  USDT: evm, USDC: evm, DAI: evm, WBTC: evm, WETH: evm, SHIB: evm, PEPE: evm, UNI: evm, AAVE: evm,
  COMP: evm, MKR: evm, LDO: evm, GRT: evm, STORJ: evm, BAT: evm, ZRX: evm, OXT: evm, NEXO: evm,
  CAKE: evm, ENS: evm, GTC: evm, TUSD: evm, GUSD: evm, FRAX: evm, USDE: evm, PAXG: evm, STETH: evm,
  MANA: evm, CRO: evm,

  // Tron
  TRX: (a) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a),
  BTT: (a) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a),
  BTTC: (a) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a),

  // Solana
  SOL: (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a),

  // XRP
  XRP: (a) => /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a) || /^X[1-9A-HJ-NP-Za-km-z]{34}$/.test(a),

  // Stellar
  XLM: (a) => /^G[A-Z0-9]{55}$/.test(a) || /^G[A-Z0-9]{55}:[A-Z0-9]{1,12}$/.test(a),

  // Cardano
  ADA: (a) => /^addr1[a-z0-9]{50,110}$/.test(a) || /^[1-9A-HJ-NP-Za-km-z]{59}$/.test(a),

  // Polkadot
  DOT: (a) => /^1[1-9A-HJ-NP-Za-km-z]{46,47}$/.test(a),

  // NEAR
  NEAR: (a) => /^[0-9a-f]{64}$/.test(a) || /^[a-z0-9._-]{2,64}\.near$/.test(a) || /^(near|@)[\w.-]+$/.test(a),

  // EOS
  EOS: (a) => /^[1-5a-z]{1,12}$/.test(a),

  // TON
  TON: (a) => /^[A-Za-z0-9_-]{48}$/.test(a) || /^EQ[A-Za-z0-9_-]{44,46}$/.test(a),

  // Hedera
  HBAR: (a) => /^[0-9]+\.[0-9]+\.[0-9]+$/.test(a),

  // Kaspa
  KAS: (a) => /^kaspa:[a-z0-9]{61,64}$/.test(a) || /^[a-z0-9]{61,64}$/.test(a),

  // Cosmos
  ATOM: (a) => /^cosmos1[0-9a-z]{38}$/.test(a),

  // Secret Network
  SCRT: (a) => /^secret1[0-9a-z]{38}$/.test(a),

  // THORChain
  RUNE: (a) => /^thor1[0-9a-z]{38}$/.test(a) || /^[a-z0-9]{2,20}$/.test(a),

  // dYdX
  DYDX: (a) => /^dydx1[0-9a-z]{38}$/.test(a),

  // Verge
  XVG: (a) => /^D[1-9A-HJ-NP-Za-km-z]{33}$/.test(a),

  // Stacks
  STX: (a) => /^SP[1-9A-HJ-NP-Za-km-z]{33,34}$/.test(a),
};

// ============================================================
// VALIDACION POR RED (para monedas custom)
// ============================================================
const NETWORK_VALIDATORS = {
  bitcoin: (a) => {
    const l = a.toLowerCase();
    if (l.startsWith('bc1')) return BTC_BECH32.test(l) || BTC_BECH32M.test(l);
    if (/^[13]/.test(a)) return /^[13][1-9A-HJ-NP-Za-km-z]{25,33}$/.test(a);
    return false;
  },
  ethereum: evm, erc20: evm, bep20: evm, base: evm, arbitrum: evm, polygon: evm,
  tron: (a) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a),
  trc20: (a) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a),
  solana: (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a),
  nano: (a) => /^(nano|xrb)_[13456789abcdefghijkmnopqrstuwxyz]{60}$/.test(a),
  custom: () => true,
};

const NETWORK_NAMES = {
  bitcoin: 'Bitcoin', ethereum: 'Ethereum (ERC-20)', erc20: 'ERC-20',
  bep20: 'BSC (BEP-20)', base: 'Base', arbitrum: 'Arbitrum',
  polygon: 'Polygon', tron: 'Tron (TRC-20)', trc20: 'TRC-20',
  solana: 'Solana', nano: 'Nano', custom: 'la red configurada',
};

// ============================================================
// DETECCION DE DIRECCION POR FORMATO
// Devuelve el simbolo detectado o null si no se reconoce.
// ============================================================
export function detectSymbolByAddress(address) {
  const a = String(address || '').trim();
  if (!a) return null;

  // Bitcoin
  if (/^(bc1[qp][a-z0-9]{58,62}|[13][1-9A-HJ-NP-Za-km-z]{25,33}|[mn][1-9A-HJ-NP-Za-km-z]{25,33})$/i.test(a)) return 'BTC';
  // Litecoin
  if (/^(ltc1[qp][a-z0-9]{38,80}|[LM3][1-9A-HJ-NP-Za-km-z]{25,33})$/i.test(a)) return 'LTC';
  // Bitcoin Cash
  if (/^(bitcoincash:)?[qp][a-z0-9]{41}$/i.test(a)) return 'BCH';
  // EVM (ETH / ERC-20 / BEP-20)
  if (/^0x[a-fA-F0-9]{40}$/.test(a)) return 'ETH';
  // Tron
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return 'TRX';
  // Solana
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return 'SOL';
  // Monero
  if (/^[48][1-9A-HJ-NP-Za-km-z]{94}$/.test(a)) return 'XMR';
  // Nano
  if (/^(nano|xrb)_[13456789abcdefghijkmnopqrstuwxyz]{60}$/.test(a)) return 'XNO';
  // XRP
  if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a)) return 'XRP';
  // Cardano
  if (/^addr1[a-z0-9]{50,110}$/.test(a)) return 'ADA';
  // Polkadot
  if (/^1[1-9A-HJ-NP-Za-km-z]{46,47}$/.test(a)) return 'DOT';
  // Zcash
  if (/^(t1|t3)[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) || /^zs[a-z0-9]{76}$/.test(a)) return 'ZEC';
  // Dogecoin
  if (/^D[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return 'DOGE';
  // Dash
  if (/^X[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return 'DASH';
  // Cosmos
  if (/^cosmos1[0-9a-z]{38}$/.test(a)) return 'ATOM';

  return null;
}

// ============================================================
// VALIDACION POR SÍMBOLO
// Devuelve null si valida, string de error si no.
// ============================================================
export function validateAddress(symbol, address, expectedNetwork) {
  const s = String(address || '').trim();
  if (s === '') return null;
  const sym = String(symbol || '').toUpperCase();

  // 1. Si es moneda custom, buscar su red y validar por red
  const custom = awaitGetCustomCoin(sym);
  if (custom) {
    return validateByNetwork(custom.network, s, sym);
  }

  // 2. Validador especifico del simbolo
  const validator = VALIDATORS[sym];
  if (validator) {
    if (!validator(s)) {
      return `Direccion ${sym} invalida: formato no reconocido`;
    }
    // 3. Si se espera una red especifica, verificar que la direccion pertenece a ella
    if (expectedNetwork) {
      const netErr = validateNetworkMismatch(sym, s, expectedNetwork);
      if (netErr) return netErr;
    }
    return null;
  }

  // 4. Sin validador especifico: longitud minima defensiva
  return s.length >= 4 ? null : 'Direccion demasiado corta';
}

// Wrapper sincrono para getCustomCoin (async) - cache simple
const _customCache = new Map();
let _cacheTime = 0;
const CACHE_TTL = 30000; // 30s

function awaitGetCustomCoin(sym) {
  // Si el cache esta fresco, usarlo (evita await en path sync)
  if (Date.now() - _cacheTime < CACHE_TTL) {
    return _customCache.get(sym) || null;
  }
  return null; // En el primer call o si expiro, retorna null
}

export function clearCustomCache() {
  _customCache.clear();
  _cacheTime = 0;
}

// Precarga el cache de custom coins (llamar al inicio y en cada refresh)
export async function refreshCustomCache(symbols = []) {
  _customCache.clear();
  for (const sym of symbols) {
    try {
      const coin = await getCustomCoin(sym);
      if (coin) _customCache.set(sym.toUpperCase(), coin);
    } catch (_) {}
  }
  _cacheTime = Date.now();
}

// ============================================================
// VALIDACION POR RED (para monedas custom)
// ============================================================
export function validateByNetwork(network, address, symbolLabel) {
  const s = String(address || '').trim();
  if (!s) return null;
  const net = String(network || '').toLowerCase();
  const label = symbolLabel || 'la moneda';
  const netName = NETWORK_NAMES[net] || net;

  const validator = NETWORK_VALIDATORS[net];
  if (!validator) return null; // Red desconocida: sin validacion

  if (!validator(s)) {
    return `Direccion ${label} invalida: no es una direccion valida de ${netName}`;
  }
  return null;
}

// ============================================================
// DETECCION DE RED EQUIVOCADA
// ============================================================
const NETWORK_FORMAT = {
  bitcoin: (a) => /^(bc1|[13]|^[mn])/.test(a),
  ethereum: evm, erc20: evm, bep20: evm, base: evm, arbitrum: evm, polygon: evm,
  tron: (a) => /^T/.test(a),
  trc20: (a) => /^T/.test(a),
  solana: (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && !/^(bc1|[13mn]|T|addr1|nano_|xrb_)/.test(a),
  nano: (a) => /^(nano|xrb)_/.test(a),
};

function formatMatchesNetwork(address, network) {
  const net = String(network || '').toLowerCase();
  const fn = NETWORK_FORMAT[net];
  if (!fn) return true; // Sin filtro: no rechazar
  return fn(address);
}

function detectActualNetwork(address) {
  const a = String(address).trim();
  if (/^(bc1|[13])/.test(a)) return 'bitcoin';
  if (/^0x/.test(a)) return 'ethereum';
  if (/^T/.test(a)) return 'tron';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && !/^(bc1|[13mn]|T)/.test(a)) return 'solana';
  if (/^(nano|xrb)_/.test(a)) return 'nano';
  return null;
}

function validateNetworkMismatch(symbol, address, expectedNetwork) {
  if (!expectedNetwork) return null;
  const expected = String(expectedNetwork).toLowerCase();
  const detected = detectActualNetwork(address);
  if (!detected) return null;

  // Si la red detectada no coincide con la esperada, advertir
  const isCompatible = formatMatchesNetwork(address, expected);
  if (!isCompatible) {
    const expectedName = NETWORK_NAMES[expected] || expected;
    const detectedName = NETWORK_NAMES[detected] || detected;
    return `Direccion parece ser de ${detectedName} pero la moneda ${symbol} esta en ${expectedName}. Usa una direccion correcta de ${expectedName}`;
  }
  return null;
}

// ============================================================
// VALIDACION CONTEXTO: llama validateAddress con cache async
// Para usar en rutas async del servidor.
// ============================================================
export async function validateAddressAsync(symbol, address, expectedNetwork) {
  const s = String(address || '').trim();
  if (s === '') return null;
  const sym = String(symbol || '').toUpperCase();

  // 1. Buscar si es custom coin
  const custom = await getCustomCoin(sym);
  if (custom) {
    return validateByNetwork(custom.network, s, sym);
  }

  // 2. Validador del simbolo
  const validator = VALIDATORS[sym];
  if (validator) {
    if (!validator(s)) return `Direccion ${sym} invalida: formato no reconocido`;
    if (expectedNetwork) {
      const netErr = validateNetworkMismatch(sym, s, expectedNetwork);
      if (netErr) return netErr;
    }
    return null;
  }

  // 3. Fallback: longitud minima
  return s.length >= 4 ? null : 'Direccion demasiado corta';
}

// ============================================================
// UTILIDADES PARA EL PANEL
// ============================================================
export function getNetworkForSymbol(symbol) {
  const sym = String(symbol || '').toUpperCase();
  // Tokens EVM multi-chain
  const evmTokens = ['USDT', 'USDC', 'DAI', 'WBTC', 'WETH', 'SHIB', 'PEPE', 'UNI', 'AAVE', 'COMP', 'MKR', 'LDO', 'GRT', 'STORJ', 'BAT', 'ZRX', 'OXT', 'NEXO', 'CAKE', 'ENS', 'GTC', 'TUSD', 'GUSD', 'FRAX', 'USDE', 'PAXG', 'STETH', 'MANA', 'CRO'];
  if (evmTokens.includes(sym)) return 'evm-multi';
  const evmNative = ['ETH', 'MATIC', 'POL', 'BNB', 'ARB', 'AVAX', 'FTM', 'OP', 'BASE'];
  if (evmNative.includes(sym)) return 'evm-native';
  const btcFamily = ['BTC', 'LTC', 'BCH', 'DASH', 'DOGE', 'DCR', 'DGB', 'RVN', 'FIRO', 'PIVX', 'KMD', 'ZEN'];
  if (btcFamily.includes(sym)) return 'bitcoin-family';
  if (['TRX', 'BTT', 'BTTC'].includes(sym)) return 'tron';
  if (['XMR', 'WOW', 'ZANO', 'XHV'].includes(sym)) return 'monero-family';
  if (sym === 'SOL') return 'solana';
  if (sym === 'XRP') return 'xrp';
  if (sym === 'XLM') return 'stellar';
  if (sym === 'ADA') return 'cardano';
  if (sym === 'DOT') return 'polkadot';
  if (sym === 'NEAR') return 'near';
  if (sym === 'ZEC') return 'zcash';
  if (sym === 'XNO') return 'nano';
  if (sym === 'BAN') return 'banano';
  if (sym === 'ATOM') return 'cosmos';
  if (sym === 'KAS') return 'kaspa';
  if (sym === 'TON') return 'ton';
  if (sym === 'HBAR') return 'hedera';
  return 'unknown';
}
