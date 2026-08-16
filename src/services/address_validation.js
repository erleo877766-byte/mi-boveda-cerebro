// ============================================================
// Validacion de formato de direcciones por moneda.
// Evita que un typo en una direccion de reserva (o destino) envie
// fondos a una direccion inexistente o de otra persona.
// Los patrones se inspiran en lib/core/address_validator.dart (Dart)
// y se adaptan a las monedas soportadas por SUPPORTED_SYMBOLS.
// ============================================================

// Base58check (Bitcoin): excluye 0, O, I, l.
const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
// Charset Bech32 (BIP-173): excluye b, i, o, 1.
const BECH32_DATA = '[qpzry9x8gf2tvdw0s3jn54khce6mua7l]';
// Z-base32 de Nano/Banano: excluye 0, 2, l, v.
const ZBASE32 = '[13456789abcdefghijkmnopqrstuwxyz]';

function bech32Regex(hrp) {
  return new RegExp(
    `^${hrp}(q${BECH32_DATA}{25,80}|p${BECH32_DATA}{38,90})$`
  );
}

const BTC_SEGWIT = bech32Regex('bc1');
const LTC_SEGWIT = bech32Regex('ltc1');

const VALIDATORS = {
  // ---------- Bitcoin-like (base58check + bech32) ----------
  BTC: (a) => {
    const lower = a.toLowerCase();
    return new RegExp(`^${BASE58}{25,34}$`).test(a) || BTC_SEGWIT.test(lower);
  },
  LTC: (a) => {
    const lower = a.toLowerCase();
    return new RegExp(`^[LM3]${BASE58}{25,34}$`).test(a) || LTC_SEGWIT.test(lower);
  },
  BCH: (a) => {
    return /^(bitcoincash:)?(q|p)[0-9a-z]{41}$/i.test(a) ||
      /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
  },
  DASH: (a) => new RegExp(`^X${BASE58}{33}$`).test(a),
  DOGE: (a) => new RegExp(`^D${BASE58}{33}$`).test(a),
  DCR: (a) => /^D[ks][1-9A-HJ-NP-Za-km-z]{24,33}$/.test(a),

  // ---------- Monero-like (base58) ----------
  XMR: (a) => new RegExp(`^(4|8)${BASE58}{94}$`).test(a) ||
    new RegExp(`^${BASE58}{95}$`).test(a),
  WOW: (a) => new RegExp(`^WOW${BASE58}{94}$`).test(a),
  ZANO: (a) => new RegExp(`^${BASE58}{90,200}$`).test(a) || /^@[\w.-]+$/.test(a),
  ZEC: (a) => /^(t1|t3)[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) ||
    /^zs[a-z0-9]{76}$/.test(a) ||
    /^u1[a-z0-9]{1,300}$/.test(a),

  // ---------- Nano / Banano (z-base32 con prefijo) ----------
  XNO: (a) => new RegExp(`^(nano|xrb)_${ZBASE32}{60}$`).test(a),
  BAN: (a) => new RegExp(`^ban_${ZBASE32}{60}$`).test(a),

  // ---------- Otras ----------
  SOL: (a) => new RegExp(`^${BASE58}{32,44}$`).test(a),
  TRX: (a) => new RegExp(`^T${BASE58}{33}$`).test(a),
  XRP: (a) => new RegExp(`^r${BASE58}{25,34}$`).test(a) || new RegExp(`^X${BASE58}{34}$`).test(a),
  NEAR: (a) => /^[0-9a-f]{64}$/.test(a) ||
    /^[a-z0-9._-]{2,64}\.near$/.test(a) ||
    /^(near|@)[\w.-]+$/.test(a),
};

function evm(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// Simbolos de tokens EVM mapeados como EVM (evitan duplicados).
const EVM_SYMBOLS = new Set([
  'ETH', 'WETH', 'USDT', 'USDC', 'USDC.E', 'DAI', 'MATIC', 'POL',
  'ARB', 'OP', 'BASE', 'BNB', 'BSC', 'FLIP',
]);

// Valida el FORMATO de una direccion para un simbolo dado.
// Devuelve null si es valida, o un mensaje de error si no.
// - Simbolos sin validador: solo se exige una longitud minima (defensivo).
// - Permite vacio (campos opcionales como receiveAddress/payoutAddress).
export function validateAddress(symbol, address) {
  const s = String(address || '').trim();
  if (s === '') return null;
  const sym = String(symbol || '').toUpperCase();

  if (EVM_SYMBOLS.has(sym)) {
    return evm(s) ? null : `direccion ${sym} invalida: debe ser 0x + 40 hex`;
  }

  const validator = VALIDATORS[sym];
  if (validator) {
    return validator(s) ? null : `direccion ${sym} invalida (formato no reconocido)`;
  }

  // Sin validador especifico: longitud minima defensiva.
  return s.length >= 4 ? null : 'direccion demasiado corta';
}
