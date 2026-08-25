import crypto from 'node:crypto';
import { db, getSetting, setSetting, nowIso } from '../db/index.js';

// ============================================================
// Sesiones admin: en memoria + datos de dispositivo en la DB.
// Almacenar en memoria sigue siendo rápido para auth check;
// la DB solo se usa para historial y listing.
// ============================================================
const sessions = new Map(); // token -> { user, expiresAt, ip, userAgent, createdAt }

// ============================================================
// TOTP (Time-based One-Time Password) — implementación pura
// con crypto nativo de Node.js. Sin dependencias externas.
// ============================================================
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let result = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    result += BASE32_CHARS[parseInt(chunk, 2)];
  }
  return result;
}

function base32Decode(input) {
  let bits = '';
  for (const ch of input.toUpperCase()) {
    const idx = BASE32_CHARS.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return bytes;
}

function generateTOTP(secret, timeMs) {
  const counter = Math.floor((timeMs || Date.now()) / 30000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0, 0);
  buf.writeUInt32BE(counter, 4);
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

export function verifyTOTP(secret, code, window = 1) {
  const now = Date.now();
  for (let i = -window; i <= window; i++) {
    if (generateTOTP(secret, now + i * 30000) === code) return true;
  }
  return false;
}

function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return codes;
}

// ============================================================
// API Key (para la app)
// ============================================================
export async function cerebroApiKey() {
  return (await getSetting('apiKey')) || process.env.CEREBRO_API_KEY || '';
}

export function setCerebroApiKey(key) {
  return setSetting('apiKey', key);
}

// ============================================================
// Login audit trail
// ============================================================
export async function logLoginEvent(ip, userAgent, success, note = '') {
  try {
    await db.prepare(
      'INSERT INTO login_events (ip, userAgent, success, note, createdAt) VALUES (?, ?, ?, ?, ?)'
    ).run(ip, userAgent, success ? 1 : 0, note, nowIso());
  } catch (_) {}
}

// ============================================================
// 2FA TOTP management
// ============================================================
export async function getTotpStatus() {
  const row = await db.prepare('SELECT * FROM admin_totp WHERE id = 1').get();
  return row || { secret: '', enabled: 0, backupCodes: '', createdAt: '' };
}

export async function setupTotp() {
  const secret = base32Encode(crypto.randomBytes(20));
  const backupCodes = generateBackupCodes();
  await db.prepare(
    'INSERT INTO admin_totp (id, secret, enabled, backupCodes, createdAt) VALUES (1, ?, 0, ?, ?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret, enabled=0, backupCodes=excluded.backupCodes, createdAt=excluded.createdAt'
  ).run(secret, backupCodes.join(','), nowIso());
  return {
    secret,
    backupCodes,
    otpauthUri: `otpauth://totp/MiBoveda:admin?secret=${secret}&issuer=MiBoveda&digits=6&period=30`,
  };
}

export async function verifyAndEnableTotp(code) {
  const totp = await getTotpStatus();
  if (!totp.secret) return { error: 'Primero debes generar el secreto TOTP' };
  if (verifyTOTP(totp.secret, code)) {
    await db.prepare('UPDATE admin_totp SET enabled = 1 WHERE id = 1').run();
    return { ok: true };
  }
  return { error: 'Código TOTP incorrecto' };
}

export async function verifyTotpCode(code) {
  const totp = await getTotpStatus();
  if (!totp.enabled) return true; // 2FA no activo → permitir
  // Verificar contra TOTP
  if (verifyTOTP(totp.secret, code)) return true;
  // Verificar contra códigos de respaldo (uso único)
  const codes = totp.backupCodes.split(',').filter(Boolean);
  const idx = codes.indexOf(code.toUpperCase());
  if (idx !== -1) {
    codes.splice(idx, 1);
    await db.prepare('UPDATE admin_totp SET backupCodes = ? WHERE id = 1').run(codes.join(','));
    return true;
  }
  return false;
}

export async function disableTotp(code) {
  const totp = await getTotpStatus();
  if (!totp.enabled) return { error: '2FA no está activo' };
  if (!verifyTOTP(totp.secret, code) && !totp.backupCodes.split(',').includes(code.toUpperCase())) {
    return { error: 'Código incorrecto' };
  }
  await db.prepare('UPDATE admin_totp SET enabled = 0, secret = "", backupCodes = "" WHERE id = 1').run();
  return { ok: true };
}

export async function totpAuth(req, res, next) {
  try {
    const totp = await getTotpStatus();
    if (!totp.enabled) return next();
    const code = req.get('x-totp-code') || req.body?.totpCode || '';
    if (!code) return res.status(401).json({ error: 'Código 2FA requerido', totpRequired: true });
    if (verifyTOTP(totp.secret, code)) return next();
    return res.status(401).json({ error: 'Código 2FA incorrecto' });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Auth para endpoints de la billetera (x-api-key).
// ============================================================
export async function apiKeyAuth(req, res, next) {
  try {
    const provided = req.get('x-api-key') || req.get('x-cerebro-api-key') || '';
    const expected = await cerebroApiKey();
    if (!expected) {
      return res.status(500).json({ error: 'CEREBRO_API_KEY no configurada' });
    }
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Auth para el dashboard web (sesión con device tracking).
// ============================================================
export function sessionAuth(req, res, next) {
  const token = req.get('x-session-token');
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  const s = sessions.get(token);
  if (!s || s.expiresAt < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Sesión expirada' });
  }
  req.session = s;
  next();
}

// Acepta API key de la app, token de dispositivo, o sesión de admin.
export async function apiKeyOrSessionAuth(req, res, next) {
  const hasKey = req.get('x-api-key') || req.get('x-cerebro-api-key');
  if (hasKey) return apiKeyAuth(req, res, next);
  const hasDevice = req.get('x-device-token');
  if (hasDevice) return deviceTokenAuth(req, res, next);
  return sessionAuth(req, res, next);
}

// Auth para endpoints usados por la billetera: acepta x-api-key O
// x-device-token. La wallet registra un device token y después envía
// SOLO ese token; sin esto /config y POST /orders devuelven 401 eterno.
export async function apiKeyOrDeviceAuth(req, res, next) {
  const hasKey = req.get('x-api-key') || req.get('x-cerebro-api-key');
  if (hasKey) return apiKeyAuth(req, res, next);
  if (req.get('x-device-token')) return deviceTokenAuth(req, res, next);
  return res.status(401).json({ error: 'Unauthorized' });
}

// ============================================================
// Sesiones admin: crear / destruir / listar / device tracking
// ============================================================
export function createSession(ip, userAgent) {
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    user: 'admin',
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    ip: ip || '',
    userAgent: userAgent || '',
    createdAt: nowIso(),
  };
  sessions.set(token, session);
  return token;
}

export function destroySession(token) {
  if (!token) return;
  sessions.delete(token);
}

export function listSessions() {
  const result = [];
  for (const [token, s] of sessions) {
    result.push({
      tokenPreview: token.slice(0, 8) + '...',
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      expiresAt: new Date(s.expiresAt).toISOString(),
      active: s.expiresAt > Date.now(),
    });
  }
  return result;
}

export function destroyAllSessionsExcept(currentToken) {
  let count = 0;
  for (const [token] of sessions) {
    if (token !== currentToken) {
      sessions.delete(token);
      count++;
    }
  }
  return count;
}

// ============================================================
// Tokens de dispositivo para la app (reemplaza API key estática).
// ============================================================
export async function registerDeviceToken(deviceName, deviceFp, ip) {
  const token = 'dev_' + crypto.randomBytes(24).toString('hex');
  const ttl = 90 * 24 * 60 * 60 * 1000; // 90 días
  await db.prepare(
    'INSERT INTO device_tokens (token, deviceName, deviceFp, ip, createdAt, expiresAt, lastUsedAt, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
  ).run(token, deviceName, deviceFp, ip, nowIso(), new Date(Date.now() + ttl).toISOString(), nowIso());
  return token;
}

async function deviceTokenAuth(req, res, next) {
  try {
    const token = req.get('x-device-token');
    if (!token) return res.status(401).json({ error: 'Token de dispositivo requerido' });
    const row = await db.prepare('SELECT * FROM device_tokens WHERE token = ? AND revoked = 0').get(token);
    if (!row) return res.status(401).json({ error: 'Token de dispositivo inválido' });
    if (new Date(row.expiresAt).getTime() < Date.now()) {
      return res.status(401).json({ error: 'Token de dispositivo expirado' });
    }
    // Actualizar último uso.
    await db.prepare('UPDATE device_tokens SET lastUsedAt = ? WHERE token = ?').run(nowIso(), token);
    req.deviceToken = row;
    next();
  } catch (err) {
    next(err);
  }
}

export async function revokeDeviceToken(token) {
  await db.prepare('UPDATE device_tokens SET revoked = 1 WHERE token = ?').run(token);
}

export async function listDeviceTokens() {
  return db.prepare('SELECT token, deviceName, deviceFp, ip, createdAt, expiresAt, lastUsedAt, revoked FROM device_tokens ORDER BY createdAt DESC').all();
}
