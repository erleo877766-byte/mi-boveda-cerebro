import crypto from 'node:crypto';
import { getSetting, setSetting } from '../db/index.js';

const sessions = new Map(); // token -> { user, expiresAt }

// La API key se guarda en la DB (settings) para poder generarla una sola vez
// y mostrarla/regenerarla desde el panel. Si no existe, se usa la de .env.
export async function cerebroApiKey() {
  return (await getSetting('apiKey')) || process.env.CEREBRO_API_KEY || '';
}

export function setCerebroApiKey(key) {
  return setSetting('apiKey', key);
}

// Auth para endpoints de la billetera (header x-api-key).
export async function apiKeyAuth(req, res, next) {
  try {
    const provided = req.get('x-api-key') || req.get('x-cerebro-api-key') || '';
    const expected = await cerebroApiKey();
    if (!expected) {
      return res.status(500).json({ error: 'CEREBRO_API_KEY no configurada en el servidor' });
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

// Auth para el dashboard web (sesion por header x-session-token).
export function sessionAuth(req, res, next) {
  const token = req.get('x-session-token');
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  const s = sessions.get(token);
  if (!s || s.expiresAt < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Sesion expirada' });
  }
  req.session = s;
  next();
}

// Acepta la API key de la app O una sesion de admin valida.
export async function apiKeyOrSessionAuth(req, res, next) {
  const hasKey = req.get('x-api-key') || req.get('x-cerebro-api-key');
  if (hasKey) return apiKeyAuth(req, res, next);
  return sessionAuth(req, res, next);
}

export function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user: 'admin', expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
  return token;
}

export function destroySession(token) {
  if (!token) return;
  sessions.delete(token);
}
