import { Router } from 'express';
import crypto from 'node:crypto';
import { db, nowIso, getSetting, setSetting } from '../db/index.js';
import { apiKeyAuth, sessionAuth, apiKeyOrSessionAuth, apiKeyOrDeviceAuth, createSession, destroySession, cerebroApiKey, setCerebroApiKey, logLoginEvent as logLogin } from '../middleware/auth.js';
import * as auth from '../middleware/auth.js';
import * as ordersService from '../services/orders.js';
import { maxOrderUsd, setMaxOrderUsd, orderExpiryHours, expirePendingOrders } from '../services/orders.js';
import * as reportsService from '../services/reports.js';
import { NORMAL_COMMISSION, commissionUsdFor, specialCommissionFor, commissionPercent, setCommissionPercent, commissionUsdAll, setCommissionUsdAll, coinCommissionPercent, coinCommissionsAll, setCoinCommission, commissionPctAll, setCommissionPctBySpeed, resetCommissionPctBySpeed } from '../services/commission.js';
import { setOwnerAddresses, ownerAddresses, isAdminOrOwnerAddress } from '../services/commission.js';
import { statusPerCoin, withdrawGain, withdrawalHistory } from '../services/earnings.js';
import * as nodesService from '../services/nodes.js';
import * as balanceService from '../services/balance.js';
import { syncCakeNodes } from '../services/cakeNodes.js';
import { priceUsd, resolveBatch, setCustomCoinSources, getPriceSources, setPriceSources } from '../services/prices.js';
import * as customCoinsService from '../services/customCoins.js';
import { mapLimit } from '../utils.js';
import { validateAddress } from '../services/address_validation.js';
import * as autonomous from '../services/autonomous.js';
import * as erleoExchange from '../services/erleoExchange.js';

const router = Router();

// ============================================================
// Rate limiting
// ============================================================
// Login: max 5 intentos fallidos por IP en 15 minutos.
const loginAttempts = new Map(); // ip -> { fails, blockedUntil }
const LOGIN_MAX_FAILS = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

// Ordenes de la app: max 30 por hora por API key.
const orderBuckets = new Map(); // apiKey -> [timestamps]
const ORDERS_PER_HOUR = 30;

function clientIp(req) {
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function loginBlocked(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (rec.blockedUntil > Date.now()) return rec.blockedUntil;
  if (rec.fails >= LOGIN_MAX_FAILS) {
    rec.blockedUntil = Date.now() + LOGIN_BLOCK_MS;
    rec.fails = 0;
    return rec.blockedUntil;
  }
  return false;
}

function registerLoginFail(ip) {
  const rec = loginAttempts.get(ip) || { fails: 0, blockedUntil: 0 };
  rec.fails += 1;
  rec.blockedUntil = 0;
  loginAttempts.set(ip, rec);
}

function registerLoginSuccess(ip) {
  loginAttempts.delete(ip);
}

function orderRateLimited(apiKey) {
  const now = Date.now();
  const key = apiKey || 'unknown';
  const list = (orderBuckets.get(key) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (list.length >= ORDERS_PER_HOUR) {
    orderBuckets.set(key, list);
    return true;
  }
  list.push(now);
  orderBuckets.set(key, list);
  return false;
}

// ============================================================
// Auth del dashboard
// ============================================================
router.post('/admin/login', async (req, res) => {
  const ip = clientIp(req);
  const ua = req.get('user-agent') || '';
  const blocked = loginBlocked(ip);
  if (blocked) {
    const retry = Math.ceil((blocked - Date.now()) / 1000);
    await logLogin(ip, ua, false, 'Bloqueado por rate limit');
    return res.status(429).json({ error: `Demasiados intentos. Reintenta en ${retry}s` });
  }
  const password = req.body && req.body.password;
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected) return res.status(500).json({ error: 'ADMIN_PASSWORD no configurada' });
  if (!safeEqual(password, expected)) {
    registerLoginFail(ip);
    await logLogin(ip, ua, false, 'Contraseña incorrecta');
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  // Password correcto. Verificar 2FA si está activo.
  const totpStatus = await auth.getTotpStatus();
  if (totpStatus.enabled) {
    const code = req.body?.totpCode || req.get('x-totp-code') || '';
    if (!code) {
      // Login parcial: password ok, falta 2FA.
      await logLogin(ip, ua, false, '2FA requerido');
      return res.status(200).json({ totpRequired: true, message: 'Contraseña correcta. Ingresa el código 2FA.' });
    }
    if (!auth.verifyTOTP(totpStatus.secret, code)) {
      registerLoginFail(ip);
      await logLogin(ip, ua, false, 'Código 2FA incorrecto');
      return res.status(401).json({ error: 'Código 2FA incorrecto' });
    }
  }
  registerLoginSuccess(ip);
  const token = createSession(ip, ua);
  await logLogin(ip, ua, true);
  res.json({ token, totpRequired: false });
});

router.post('/admin/logout', sessionAuth, (req, res) => {
  destroySession(req.get('x-session-token'));
  res.json({ ok: true });
});

// ============================================================
// Config consumida por la app (compatible con cerebro_service.dart)
// ============================================================
async function buildConfig() {
  const coins = {};
  const addrRows = await db.prepare('SELECT * FROM coin_addresses').all();
  // La app usa la red principal (network '') de cada moneda.
  // Solo aparecen las monedas con direccion configurada: cada una conserva su
  // propio flag enabled. Las monedas SIN reserva no se envian (la app las
  // trata como habilitadas por defecto para crear billeteras; el admin puede
  // desactivarlas explicitamente configurando su direccion con enabled=false).
  for (const r of addrRows) {
    if (r.network !== '') continue;
    coins[r.symbol] = { enabled: r.enabled === 1, feeAddress: r.address };
  }
  // Criptomonedas personalizadas del admin: se agregan al config con sus
  // direcciones, y los tokens EVM/TRC20 viajan en customTokens para que la app
  // los muestre en la lista de billeteras sin necesidad de actualizar.
  const customList = await customCoinsService.listCustomCoins();
  const customTokens = [];
  for (const c of customList) {
    if (coins[c.symbol]) {
      coins[c.symbol] = { ...coins[c.symbol], enabled: c.enabled, feeAddress: c.feeAddress || coins[c.symbol].feeAddress };
    } else {
      coins[c.symbol] = { enabled: c.enabled, feeAddress: c.feeAddress };
    }
    if (c.enabled) {
      customTokens.push({
        symbol: c.symbol,
        name: c.name,
        network: c.network,
        contractAddress: c.contractAddress,
        logo: c.logo,
      });
    }
  }
  const globalEnabledRaw = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('globalEnabled');
  const globalEnabled = globalEnabledRaw ? globalEnabledRaw.value === '1' : true;

  const erleoEnabledRaw = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('erleoExchangeEnabled');
  // Por defecto el sistema Erleo está ACTIVADO; el panel puede detenerlo con un clic.
  const erleoExchangeEnabled = erleoEnabledRaw ? erleoEnabledRaw.value === '1' : true;

  const specials = await db.prepare('SELECT * FROM small_order_commission').all();
  const specialCommissions = {};
  for (const sp of specials) specialCommissions[sp.symbol] = sp.specialUsd;

  const percent = await commissionPercent();
  const usdComms = await commissionUsdAll();
  // Reparto por velocidad del global (Lento 50% / Normal 75% / Rapido 100%).
  const pctSpeed = await commissionPctAll();

  // Nodos: la app NO tiene lista propia, el Cerebro es el unico que la tiene.
  const allNodes = await nodesService.listNodes({ enabledOnly: true });
  const nodes = nodesService.toAppNodes(allNodes);

  // Tiempos estimados de confirmación por moneda y velocidad (en segundos).
  // Basado en confirmaciones reales de las blockchains: slow = 1 conf, medium = 2-3, fast = 6+.
  const confirmationEstimates = {
    BTC:  { slow: 3600,  medium: 1800, fast: 600 },   // 1h / 30m / 10m
    ETH:  { slow: 300,   medium: 150,  fast: 60 },     // 5m / 2.5m / 1m
    LTC:  { slow: 900,   medium: 600,  fast: 300 },    // 15m / 10m / 5m
    XMR:  { slow: 600,   medium: 300,  fast: 120 },    // 10m / 5m / 2m
    XNO:  { slow: 30,    medium: 15,   fast: 5 },       // 30s / 15s / 5s
    DOGE: { slow: 600,   medium: 300,  fast: 120 },    // 10m / 5m / 2m
    BCH:  { slow: 900,   medium: 600,  fast: 300 },    // 15m / 10m / 5m
    SOL:  { slow: 120,   medium: 60,   fast: 30 },     // 2m / 1m / 30s
    TRX:  { slow: 180,   medium: 90,   fast: 30 },     // 3m / 1.5m / 30s
    BNB:  { slow: 300,   medium: 150,  fast: 60 },     // 5m / 2.5m / 1m
    XRP:  { slow: 300,   medium: 150,  fast: 30 },     // 5m / 2.5m / 30s
    ADA:  { slow: 900,   medium: 600,  fast: 300 },    // 15m / 10m / 5m
    DASH: { slow: 900,   medium: 600,  fast: 300 },    // 15m / 10m / 5m
    BAN:  { slow: 60,    medium: 30,   fast: 10 },     // 1m / 30s / 10s
    ZEC:  { slow: 900,   medium: 600,  fast: 300 },    // 15m / 10m / 5m
    AVAX: { slow: 300,   medium: 150,  fast: 60 },     // 5m / 2.5m / 1m
    MATIC:{ slow: 300,   medium: 150,  fast: 60 },     // 5m / 2.5m / 1m
    POL:  { slow: 300,   medium: 150,  fast: 60 },     // 5m / 2.5m / 1m
    DEFAULT: { slow: 1800, medium: 900, fast: 300 },   // 30m / 15m / 5m fallback
  };

  return {
    name: 'Cerebro Mi Boveda',
    globalEnabled,
    commissionSlowUsd: usdComms.slow,
    commissionMediumUsd: usdComms.medium,
    commissionFastUsd: usdComms.fast,
    commissionPercent: percent,
    commissionBySpeed: {
      global: pctSpeed.global,
      slow: pctSpeed.slow,
      medium: pctSpeed.medium,
      fast: pctSpeed.fast,
    },
    adminCommissionExemption: true,
    minAppVersion: 0,
    coins,
    customTokens,
    specialCommissions,
    nodes,
    announcements: [],
    confirmationEstimates,
    downloads: {
      version: (await getSetting('appLatestVersion')).trim(),
      apkUrl: (await getSetting('appApkUrl')).trim(),
      apkMirrorUrl: (await getSetting('appApkMirrorUrl')).trim(),
      exeUrl: (await getSetting('appExeUrl')).trim(),
      exeMirrorUrl: (await getSetting('appExeMirrorUrl')).trim(),
    },
    erleoExchangeEnabled,
  };
}

router.get('/config', apiKeyOrDeviceAuth, async (req, res) => {
  res.json(await buildConfig());
});

// ============================================================
// Ordenes (usadas por la app y por el dashboard)
// ============================================================
// POST /api/v1/orders - la app envia una orden de intercambio pequeno.
router.post('/orders', apiKeyOrDeviceAuth, async (req, res) => {
  const key = req.get('x-api-key') || req.get('x-cerebro-api-key') || req.get('x-device-token') || '';
  if (orderRateLimited(key)) {
    return res.status(429).json({ error: 'Demasiadas ordenes, espera un rato' });
  }
  // CEREBRO AUTÓNOMO: verificar actividad sospechosa.
  autonomous.recordKeyActivity(key);
  const suspicious = await autonomous.checkSuspiciousActivity(key);
  if (suspicious) {
    await autonomous.createAlert('suspicious_activity', 'critical',
      `Actividad sospechosa: ${suspicious.recentCount} órdenes/min de key ${suspicious.apiKey}`,
      JSON.stringify(suspicious));
    if ((await autonomous.getProtectionSetting('autoPauseOnSuspiciousActivity')) === '1') {
      return res.status(429).json({ error: 'Actividad sospechosa detectada. Orden bloqueada.' });
    }
  }
  // CEREBRO AUTÓNOMO: verificar que los símbolos no estén pausados.
  const from = String(req.body?.fromSymbol ?? '').toUpperCase();
  const to = String(req.body?.toSymbol ?? '').toUpperCase();
  if (autonomous.isSymbolPaused(from)) {
    return res.status(503).json({ error: `Moneda ${from} pausada temporalmente por protección automática` });
  }
  if (autonomous.isSymbolPaused(to)) {
    return res.status(503).json({ error: `Moneda ${to} pausada temporalmente por protección automática` });
  }
  // CEREBRO AUTÓNOMO: verificar que la dirección destino no esté en blocklist.
  const toAddress = String(req.body?.toAddress ?? '').trim();
  if (toAddress) {
    const blocked = await autonomous.isAddressBlocked(toAddress);
    if (blocked) {
      await autonomous.createAlert('blocked_address', 'critical',
        `Intento de envío a dirección bloqueada: ${toAddress}`,
        JSON.stringify({ address: toAddress, reason: blocked.reason, from: from, to: to }));
      return res.status(400).json({ error: `Dirección destino bloqueada: ${blocked.reason}` });
    }
  }
  const result = await ordersService.createOrder(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result.order);
});

// POST /api/v1/orders/check-liquidity - la app consulta ANTES de aceptar si la
// reserva del admin tiene saldo para entregar el monto destino.
// body: { toSymbol, toAmount, toNetwork? }
router.post('/orders/check-liquidity', apiKeyOrDeviceAuth, async (req, res) => {
  const { toSymbol, toAmount, toNetwork } = req.body || {};
  const r = await ordersService.checkLiquidity(toSymbol, toAmount, toNetwork);
  if (r.error && r.sufficient === false) return res.status(200).json(r);
  res.json(r);
});

// GET /api/v1/balances - la billetera consulta los saldos del Cerebro en vivo
// (reservas del admin por moneda) para mostrar y decidir si tiene con que pagar
// el destino antes de aceptar un intercambio.
router.get('/balances', apiKeyOrDeviceAuth, async (req, res) => {
  res.json(await ordersService.allReserveBalances());
});

// GET /api/v1/orders/:id - la app consulta estado (pending/approved/rejected/completed).
router.get('/orders/:id', apiKeyOrSessionAuth, async (req, res) => {
  const order = await ordersService.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'orden no encontrada' });
  res.json(order);
});

// GET /api/v1/orders - listado (dashboard).
router.get('/orders', sessionAuth, async (req, res) => {
  res.json(await ordersService.listOrders({ status: req.query.status, limit: req.query.limit }));
});

// POST /api/v1/orders/:id/approve - admin aprueba (calcula comision + monto neto).
router.post('/orders/:id/approve', sessionAuth, async (req, res) => {
  const result = await ordersService.approveOrder(req.params.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.order);
});

// POST /api/v1/orders/:id/reject - admin rechaza.
router.post('/orders/:id/reject', sessionAuth, async (req, res) => {
  const result = await ordersService.rejectOrder(req.params.id, req.body && req.body.reason);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.order);
});

// POST /api/v1/orders/:id/complete - admin confirma envio manual.
router.post('/orders/:id/complete', sessionAuth, async (req, res) => {
  const result = await ordersService.completeOrder(req.params.id, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.order);
});

// POST /api/v1/orders/clear-history - borra solo las ordenes ya terminadas.
router.post('/orders/clear-history', sessionAuth, async (req, res) => {
  const result = await ordersService.clearOrderHistory();
  res.json(result);
});

// ============================================================
// Toggle Erleo (sistema de intercambios propios)
// ============================================================
// GET /api/v1/settings/erleo-enabled - lee el estado actual (permite el dashboard).
router.get('/settings/erleo-enabled', apiKeyOrSessionAuth, async (req, res) => {
  const config = await buildConfig();
  res.json(config.erleoExchangeEnabled && config.globalEnabled);
});

// POST /api/v1/settings/erleo-enabled - admin enciende/apaga con un clic (persistente).
// Es el kill switch unico: controla a la vez los intercambios (erleoExchangeEnabled)
// y los envios (globalEnabled) para que la app lo respete en ambos flujos.
router.post('/settings/erleo-enabled', sessionAuth, async (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  for (const key of ['erleoExchangeEnabled', 'globalEnabled']) {
    await db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, enabled ? '1' : '0');
  }
  res.json({ enabled });
});

// ============================================================
// Comision en % configurable (lo que el admin cobra por intercambio)
// ============================================================
router.get('/settings/commission-percent', apiKeyOrSessionAuth, async (req, res) => {
  res.json({ percent: await commissionPercent() });
});

// Comisiones en % POR MONEDA (rediseno): mapa symbol -> percent.
router.get('/settings/coin-commissions', apiKeyOrSessionAuth, async (req, res) => {
  res.json(await coinCommissionsAll());
});

// Redes conocidas por moneda + lista completa de simbolos (para el panel).
// Incluye las monedas personalizadas del admin: aparecen solas en la tabla
// de "% por moneda" y en las listas de Direcciones/Comisiones.
router.get('/settings/coin-networks', apiKeyOrSessionAuth, async (req, res) => {
  const custom = await customCoinsService.customSymbols();
  const customSymbols = custom.map((c) => c.symbol).sort();
  const networks = { ...ordersService.COIN_NETWORKS };
  for (const sym of customSymbols) {
    if (!networks[sym]) networks[sym] = ['cerebro'];
  }
  const symbols = [...new Set([...ordersService.SUPPORTED_SYMBOLS, ...customSymbols])].sort();
  res.json({ symbols, networks, custom: customSymbols });
});

// Guarda la comision % de una moneda (crea/actualiza en la nube).
router.post('/settings/coin-commissions', sessionAuth, async (req, res) => {
  const { symbol, percent } = req.body || {};
  const r = await setCoinCommission(symbol, percent);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

router.post('/settings/commission-percent', sessionAuth, async (req, res) => {
  const result = await setCommissionPercent(Number(req.body && req.body.percent));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// Porcentaje GLOBAL BASE -> Lento/Normal/Rapido (Lento 50 / Normal 75 / Rapido 100).
// GET devuelve el global + los 3 niveles calculados (con overrides manuales aplicados).
router.get('/settings/commission-by-speed', apiKeyOrSessionAuth, async (req, res) => {
  res.json(await commissionPctAll());
});

// POST guarda el override manual de UN nivel (valida que no supere el global).
// body: { speed: 'slow'|'medium'|'fast', percent: Number }
router.post('/settings/commission-by-speed', sessionAuth, async (req, res) => {
  const { speed, percent } = req.body || {};
  const r = await setCommissionPctBySpeed(String(speed), percent);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// DELETE vuelve los 3 niveles al reparto automatico del global (sin overrides).
router.delete('/settings/commission-by-speed', sessionAuth, async (req, res) => {
  res.json(await resetCommissionPctBySpeed());
});

// ============================================================
// FUENTES de precios del Mercado (activar/desactivar + prioridad)
// ============================================================
// GET devuelve el estado de cada fuente y el orden de prioridad actual.
router.get('/settings/price-sources', apiKeyOrSessionAuth, async (req, res) => {
  res.json(await getPriceSources());
});

// body: { enabled: { binance: bool, ... }, order: ['kraken', 'binance', ...] }
router.post('/settings/price-sources', sessionAuth, async (req, res) => {
  const r = await setPriceSources(req.body || {});
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// Direcciones de reconocimiento del admin (para cobrar CERO comision).
router.get('/settings/owner-addresses', apiKeyOrSessionAuth, async (req, res) => {
  res.json(await ownerAddresses());
});

// body: { BTC: ['bc1q...', ...], XMR: '...', ... }
router.post('/settings/owner-addresses', sessionAuth, async (req, res) => {
  const r = await setOwnerAddresses(req.body);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// ============================================================
// GANANCIAS del admin + retiro a cuenta principal (sin costo)
// ============================================================
// Estado por moneda: reserva (on-chain en lo posible, con manual como fallback)
// + ganancia acumulada retirable + disponible.
router.get('/earnings/status', apiKeyOrSessionAuth, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM coin_addresses WHERE enabled = 1').all();
  const persisted = {};
  for (const r of rows) {
    if (r.network !== '') continue;
    let reserve = Number(r.balance) || 0;
    try {
      if (r.payoutAddress) reserve = await balanceService.availableBalance(r.symbol, r.payoutAddress, reserve);
    } catch { /* mantiene fallback manual */ }
    persisted[r.symbol] = { reserve };
  }
  const status = await statusPerCoin(persisted);
  res.json({ coins: status, updatedAt: new Date().toISOString() });
});

// Retira la ganancia acumulada de una moneda a la cuenta principal del admin.
// Query: ?symbol=BTC&to=bc1q_admin (opcional) — si no se pasa 'to', se usa la
// direccion de pago de la moneda configurada.
router.post('/earnings/withdraw', sessionAuth, async (req, res) => {
  const { symbol, to } = req.body || {};
  let toAddress = String(to || '').trim();
  if (!toAddress) {
    const row = await db
      .prepare('SELECT payoutAddress AS addr FROM coin_addresses WHERE symbol = ? AND network = ?')
      .get(String(symbol || '').toUpperCase(), '');
    toAddress = row && row.addr ? row.addr : '';
  }
  const r = await withdrawGain(symbol, { toAddress });
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// Historial de retiros de ganancias.
router.get('/earnings/withdrawals', apiKeyOrSessionAuth, async (req, res) => {
  res.json({ withdrawals: await withdrawalHistory({ limit: 200 }) });
});


// Comision en USD configurable por velocidad (Lento/Normal/Rapido).
router.get('/settings/commissions-usd', apiKeyOrSessionAuth, async (req, res) => {
  res.json(await commissionUsdAll());
});

router.post('/settings/commissions-usd', sessionAuth, async (req, res) => {
  const result = await setCommissionUsdAll(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// ============================================================
// Limite maximo por orden + expiracion de ordenes pending
// ============================================================
router.get('/settings/max-order-usd', apiKeyOrSessionAuth, async (req, res) => {
  res.json({ maxOrderUsd: await maxOrderUsd() });
});

router.post('/settings/max-order-usd', sessionAuth, async (req, res) => {
  const result = await setMaxOrderUsd(Number(req.body && req.body.maxOrderUsd));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

router.get('/settings/order-expiry-hours', apiKeyOrSessionAuth, async (req, res) => {
  res.json({ orderExpiryHours: await orderExpiryHours() });
});

router.post('/settings/order-expiry-hours', sessionAuth, async (req, res) => {
  const value = Number(req.body && req.body.orderExpiryHours);
  const clean = Number.isFinite(value) && value > 0 ? value : 48;
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES ('erleoOrderExpiryHours', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(clean));
  res.json({ orderExpiryHours: clean });
});

// ============================================================
// Actualizacion de la app: version disponible + enlaces de descarga
// ============================================================
router.get('/settings/app-update', apiKeyOrSessionAuth, async (req, res) => {
  res.json({
    version: (await getSetting('appLatestVersion')).trim(),
    apkUrl: (await getSetting('appApkUrl')).trim(),
    apkMirrorUrl: (await getSetting('appApkMirrorUrl')).trim(),
    exeUrl: (await getSetting('appExeUrl')).trim(),
    exeMirrorUrl: (await getSetting('appExeMirrorUrl')).trim(),
  });
});

router.post('/settings/app-update', sessionAuth, async (req, res) => {
  const b = req.body || {};
  const version = String(b.version ?? '').trim();
  if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
    return res.status(400).json({ error: 'La versión debe tener formato X.Y.Z (ej. 4.0.1)' });
  }
  await setSetting('appLatestVersion', version);
  await setSetting('appApkUrl', String(b.apkUrl ?? '').trim());
  await setSetting('appApkMirrorUrl', String(b.apkMirrorUrl ?? '').trim());
  await setSetting('appExeUrl', String(b.exeUrl ?? '').trim());
  await setSetting('appExeMirrorUrl', String(b.exeMirrorUrl ?? '').trim());
  res.json({ ok: true });
});

// Expira ya las ordenes pending vencidas (tambien corre automaticamente).
router.post('/orders/expire-pending', sessionAuth, async (req, res) => {
  const count = await expirePendingOrders();
  res.json({ expired: count });
});

// ============================================================
// API key de la app (se muestra UNA SOLA VEZ en el panel)
// ============================================================
// GET /api/v1/settings/api-key - devuelve la key la primera vez; despues solo
// la ultima parte para confirmar que es la misma.
router.get('/settings/api-key', sessionAuth, async (req, res) => {
  const key = await cerebroApiKey();
  const shown = (await getSetting('apiKeyShown')) === '1';
  res.json({
    apiKey: key,
    revealedOnce: shown,
  });
});

// POST /api/v1/settings/api-key/reveal - marca como vista (ya no se vuelve a mostrar completa).
router.post('/settings/api-key/reveal', sessionAuth, async (req, res) => {
  await setSetting('apiKeyShown', '1');
  res.json({ ok: true });
});

// POST /api/v1/settings/api-key/regenerate - genera una key nueva (la app debe actualizarse).
router.post('/settings/api-key/regenerate', sessionAuth, async (req, res) => {
  const key = 'cerebro_' + crypto.randomBytes(24).toString('hex');
  await setCerebroApiKey(key);
  await setSetting('apiKeyShown', '1');
  res.json({ apiKey: key });
});

// ============================================================
// Direcciones de cobro y reserva por moneda y red (config del admin)
// ============================================================
// GET /api/v1/coin-addresses - lista todas (por moneda y red).
router.get('/coin-addresses', sessionAuth, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM coin_addresses ORDER BY symbol, network').all();
  // Adjunta el saldo on-chain actual de la reserva (para que el panel lo vea en vivo).
  const withBalances = await Promise.all(rows.map(async (r) => {
    const addr = (r.payoutAddress || r.address || '').trim();
    let onchain = null;
    if (addr && addr.length >= 4) {
      try { onchain = await balanceService.fetchBalance(r.symbol, addr); } catch (_) {}
    }
    return { ...r, onchainBalance: onchain };
  }));
  res.json(withBalances);
});

// POST /api/v1/coin-addresses - crea/actualiza una direccion por moneda+red.
router.post('/coin-addresses', sessionAuth, async (req, res) => {
  const { symbol, network = '', address = '', receiveAddress = '', payoutAddress = '', balance = 0, enabled = true } = req.body || {};
  if (!symbol || !String(symbol).trim()) return res.status(400).json({ error: 'symbol requerido' });
  if (!address && !payoutAddress && !receiveAddress)
    return res.status(400).json({ error: 'falta al menos una direccion' });
  const sym = String(symbol).toUpperCase();
  const net = String(network || '').trim();
  // Validar el FORMATO de cada direccion segun la moneda: un typo aqui
  // significa fondos enviados a una direccion inexistente o de otro.
  for (const [field, value] of [['address', address], ['receiveAddress', receiveAddress], ['payoutAddress', payoutAddress]]) {
    if (value && String(value).trim()) {
      const err = validateAddress(sym, value);
      if (err) return res.status(400).json({ error: `${field}: ${err}` });
    }
  }
  await db.prepare(`
    INSERT INTO coin_addresses (symbol, network, address, receiveAddress, payoutAddress, balance, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, network) DO UPDATE SET
      address=excluded.address, receiveAddress=excluded.receiveAddress,
      payoutAddress=excluded.payoutAddress, balance=excluded.balance, enabled=excluded.enabled
  `).run(
    sym, net, String(address).trim(), String(receiveAddress).trim(), String(payoutAddress).trim(),
    Number(balance) || 0, enabled ? 1 : 0
  );
  res.json(await db.prepare('SELECT * FROM coin_addresses WHERE symbol = ? AND network = ?').get(sym, net));
});

// DELETE /api/v1/coin-addresses/:symbol?network= - elimina una direccion.
router.delete('/coin-addresses/:symbol', sessionAuth, async (req, res) => {
  const network = String(req.query.network ?? '');
  await db.prepare('DELETE FROM coin_addresses WHERE symbol = ? AND network = ?')
    .run(req.params.symbol.toUpperCase(), network);
  res.json({ ok: true });
});

// POST /api/v1/coin-addresses/:symbol/balance?network= - actualiza el saldo manual.
router.post('/coin-addresses/:symbol/balance', sessionAuth, async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const network = String(req.query.network ?? '');
  const balance = Number(req.body && req.body.balance);
  if (!Number.isFinite(balance) || balance < 0)
    return res.status(400).json({ error: 'balance invalido' });
  const exists = await db.prepare('SELECT symbol FROM coin_addresses WHERE symbol = ? AND network = ?').get(symbol, network);
  if (!exists) return res.status(404).json({ error: 'no hay direccion para esa moneda/red' });
  await db.prepare('UPDATE coin_addresses SET balance = ? WHERE symbol = ? AND network = ?').run(balance, symbol, network);
  res.json({ ok: true, symbol, network, balance });
});

// ============================================================
// Comision especial opcional para ordenes pequenas
// ============================================================
router.get('/small-commissions', sessionAuth, async (req, res) => {
  res.json(await db.prepare('SELECT * FROM small_order_commission').all());
});

router.post('/small-commissions', sessionAuth, async (req, res) => {
  const { symbol, specialUsd } = req.body || {};
  if (!symbol) return res.status(400).json({ error: 'symbol requerido' });
  await db.prepare(`
    INSERT INTO small_order_commission (symbol, specialUsd) VALUES (?, ?)
    ON CONFLICT(symbol) DO UPDATE SET specialUsd = excluded.specialUsd
  `).run(symbol.toUpperCase(), Number(specialUsd) || 0);
  res.json({ ok: true });
});

// ============================================================
// Notificaciones broadcast (la app las consulta por polling)
// ============================================================
// GET /api/v1/notifications?after=<id> - la app trae solo las nuevas; el panel consulta el historial.
router.get('/notifications', apiKeyOrSessionAuth, async (req, res) => {
  const after = Number(req.query.after) || 0;
  const deviceToken = req.get('x-device-token') || req.query.deviceToken || '';
  const rows = await db.prepare(
    'SELECT id, title, body, priority, createdAt FROM notifications WHERE id > ? ORDER BY id ASC'
  ).all(after);
  // Si el device manda su token, adjuntamos si cada notificación ya fue leída.
  const reads = deviceToken
    ? await db.prepare('SELECT notificationId FROM notification_reads WHERE deviceToken = ?').all(deviceToken)
    : [];
  const readSet = new Set(reads.map((r) => r.notificationId));
  const notifications = rows.map((n) => ({
    ...n,
    read: readSet.has(n.id),
  }));
  res.json({ notifications });
});

// POST /api/v1/notifications/:id/read - el dispositivo confirma que leyó una notificación.
router.post('/notifications/:id/read', apiKeyOrSessionAuth, async (req, res) => {
  const notificationId = Number(req.params.id);
  if (!notificationId) return res.status(400).json({ error: 'id invalido' });
  const deviceToken = req.get('x-device-token') || '';
  const deviceName = req.body?.deviceName || '';
  if (!deviceToken) {
    // Si no hay device token, intentar con API key como fallback.
    return res.status(400).json({ error: 'x-device-token requerido para confirmar lectura' });
  }
  await db.prepare(`
    INSERT OR IGNORE INTO notification_reads (notificationId, deviceToken, deviceName, readAt)
    VALUES (?, ?, ?, ?)
  `).run(notificationId, deviceToken, deviceName, nowIso());
  res.json({ ok: true });
});

// POST /api/v1/notifications/read-all - marca todas como leídas para un dispositivo.
router.post('/notifications/read-all', apiKeyOrSessionAuth, async (req, res) => {
  const deviceToken = req.get('x-device-token') || '';
  if (!deviceToken) return res.status(400).json({ error: 'x-device-token requerido' });
  const deviceName = req.body?.deviceName || '';
  // Obtener todas las notificaciones que el dispositivo no ha leído.
  const unread = await db.prepare(`
    SELECT n.id FROM notifications n
    LEFT JOIN notification_reads nr ON nr.notificationId = n.id AND nr.deviceToken = ?
    WHERE nr.notificationId IS NULL
  `).all(deviceToken);
  const ts = nowIso();
  for (const n of unread) {
    await db.prepare(`
      INSERT OR IGNORE INTO notification_reads (notificationId, deviceToken, deviceName, readAt)
      VALUES (?, ?, ?, ?)
    `).run(n.id, deviceToken, deviceName, ts);
  }
  res.json({ ok: true, marked: unread.length });
});

// GET /api/v1/notifications/stats - estadísticas de lectura (panel).
router.get('/notifications/stats', sessionAuth, async (req, res) => {
  const total = await db.prepare('SELECT COUNT(*) as c FROM notifications').get();
  const totalDevices = await db.prepare('SELECT COUNT(DISTINCT deviceToken) as c FROM notification_reads').get();
  // Última notificación y su tasa de lectura.
  const latest = await db.prepare('SELECT id, title, createdAt FROM notifications ORDER BY id DESC LIMIT 1').get();
  let latestReadRate = 0;
  if (latest) {
    const readCount = await db.prepare('SELECT COUNT(DISTINCT deviceToken) as c FROM notification_reads WHERE notificationId = ?').get(latest.id);
    const registeredDevices = await db.prepare('SELECT COUNT(*) as c FROM device_tokens WHERE revoked = 0').get();
    if (registeredDevices?.c > 0) {
      latestReadRate = Math.round(((readCount?.c || 0) / registeredDevices.c) * 100);
    }
  }
  res.json({
    totalNotifications: total?.c || 0,
    registeredDevices: totalDevices?.c || 0,
    latest: latest || null,
    latestReadRate,
  });
});

// POST /api/v1/notifications - el admin envia una notificacion desde el panel.
router.post('/notifications', sessionAuth, async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  const priority = String(req.body?.priority || 'normal').trim();
  if (!title) return res.status(400).json({ error: 'title requerido' });
  if (!['normal', 'urgent', 'critical'].includes(priority))
    return res.status(400).json({ error: 'priority debe ser normal|urgent|critical' });
  const r = await db.prepare(
    'INSERT INTO notifications (title, body, priority, createdAt) VALUES (?, ?, ?, ?)'
  ).run(title, body, priority, nowIso());
  const id = typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid;
  res.status(201).json({ id, title, body, priority });
});

// ============================================================
// Reportes / contabilidad separada
// ============================================================
router.get('/report/commissions', sessionAuth, async (req, res) => {
  res.json(await reportsService.commissionReport(req.query));
});

router.get('/report/dashboard', sessionAuth, async (req, res) => {
  res.json(await reportsService.dashboardSummary());
});

router.get('/report/export', sessionAuth, async (req, res) => {
  const { events } = await reportsService.commissionReport({ ...req.query, limit: 5000 });
  const header = ['orderId','fromSymbol','toSymbol','speed','commissionUsd','commissionSymbol','commissionAmount','grossFromAmount','netToAmount','providerFeeSavedUsd','networkFeeUsd','createdAt'];
  const rows = events.map((e) => header.map((h) => e[h] ?? '').join(','));
  const csv = header.join(',') + '\n' + rows.join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=comisiones_erleo.csv');
  res.send(csv);
});

// ============================================================
// Nodos por criptomoneda (solo el Cerebro los administra)
// ============================================================
// GET /api/v1/nodes - listado completo (dashboard).
router.get('/nodes', sessionAuth, async (req, res) => {
  res.json(await nodesService.listNodes({ symbol: req.query.symbol }));
});

// GET /api/v1/nodes/best?symbol=XNO - la app consulta cual nodo usar.
router.get('/nodes/best', apiKeyOrSessionAuth, async (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase();
  const node = await nodesService.selectBestNode(symbol);
  if (!node) return res.status(404).json({ error: `sin nodos habilitados para ${symbol}` });
  res.json(nodesService.toAppNodes([node])[0]);
});

// POST /api/v1/nodes - crear.
router.post('/nodes', sessionAuth, async (req, res) => {
  const result = await nodesService.createNode(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result.node);
});

// PUT /api/v1/nodes/:id - editar.
router.put('/nodes/:id', sessionAuth, async (req, res) => {
  const result = await nodesService.updateNode(req.params.id, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.node);
});

// POST /api/v1/nodes/validate - validar URL sin guardar.
router.post('/nodes/validate', sessionAuth, async (req, res) => {
  const { uri } = req.body || {};
  const validation = nodesService.validateNodeUrl(uri || '');
  if (!validation.valid) return res.status(400).json({ error: validation.error, valid: false });
  // Si la URL es valida, probar conexion
  const probe = await nodesService.probeLatency(validation.normalized, 5000);
  if (!probe) {
    return res.status(400).json({ error: 'El nodo no responde', valid: true, connected: false, normalized: validation.normalized });
  }
  res.json({
    valid: true,
    connected: probe.ok,
    normalized: validation.normalized,
    hostname: validation.hostname,
    latencyMs: probe.ms,
    status: probe.status,
    error: probe.ok ? null : (probe.error || `HTTP ${probe.status}`),
  });
});

// POST /api/v1/nodes/:id/reactivate - reactivar un nodo desactivado manualmente.
router.post('/nodes/:id/reactivate', sessionAuth, async (req, res) => {
  const existing = await nodesService.getNode(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'nodo no encontrado' });
  // Probar si responde
  const probe = await nodesService.probeLatency(existing.uri, 5000);
  if (!probe || !probe.ok) {
    const reason = probe ? (probe.error || `HTTP ${probe.status}`) : 'sin respuesta';
    return res.status(400).json({ error: `Nodo no responde (${reason}). No se puede reactivar.` });
  }
  // Reactivar
  const ts = new Date().toISOString();
  await db.prepare(`
    UPDATE nodes SET enabled=1, consecutiveFailures=0, latencyMs=?, coverage=?,
      lastCheck=?, deactivatedReason='', lastError=''
    WHERE id=?
  `).run(probe.ms, probe.ok ? (probe.ms <= 200 ? 100 : probe.ms <= 400 ? 80 : 50) : 0, ts, Number(req.params.id));
  res.json({ ok: true, node: await nodesService.getNode(Number(req.params.id)) });
});

// POST /api/v1/nodes/:id/test - mide latencia y cobertura ahora.
router.post('/nodes/:id/test', sessionAuth, async (req, res) => {
  const result = await nodesService.testNode(req.params.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.node);
});

// DELETE /api/v1/nodes/:id - eliminar (los oficiales no se pueden borrar).
router.delete('/nodes/:id', sessionAuth, async (req, res) => {
  const result = await nodesService.deleteNode(req.params.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// POST /api/v1/nodes/sync-cake - re-descarga la lista oficial de Cake Wallet
// y trae todos los nodos nuevos (se guardan en data/cake_nodes, carpeta aparte).
router.post('/nodes/sync-cake', sessionAuth, async (req, res) => {
  try {
    const r = await syncCakeNodes();
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: String(err && err.message || err) });
  }
});

// ============================================================
// Mercado: precios en vivo (Binance con fallback CoinGecko), los mismos
// que usa la billetera del usuario. Si una moneda no tiene precio, se
// devuelve el ultimo conocido o null (el panel avisa que no hay conexion).
// ============================================================
router.get('/market/prices', apiKeyOrSessionAuth, async (req, res) => {
  const customSyms = (await customCoinsService.customSymbols()).map((c) => c.symbol);
  const all = [...new Set([...ordersService.SUPPORTED_SYMBOLS, ...customSyms])].sort();
  const requested = req.query.symbols
    ? String(req.query.symbols).split(',').map((s) => s.trim().toUpperCase()).filter((s) => all.includes(s))
    : all;
  // 1 peticion batch a CoinGecko para todo lo posible; el resto cae a la
  // cadena por-simbolo (Binance -> Coinbase -> Kraken -> CoinGecko).
  await resolveBatch(requested).catch(() => {});
  const prices = await mapLimit(requested, 10, async (symbol) => ({
    symbol,
    price: await priceUsd(symbol),
  }));
  res.json({ prices, ts: Date.now() });
});

// ============================================================
// Criptomonedas personalizadas (panel del admin)
// ============================================================
// Mantiene las fuentes de precio (por contrato) sincronizadas tras cada cambio.
async function syncCustomPriceSources() {
  setCustomCoinSources(await customCoinsService.customSymbols());
}

router.get('/admin/coins/custom', sessionAuth, async (req, res) => {
  res.json({ coins: await customCoinsService.listCustomCoins() });
});

router.post('/admin/coins/custom', sessionAuth, async (req, res) => {
  const symCheck = String(req.body?.symbol || '').toUpperCase().trim();
  if (symCheck && ordersService.SUPPORTED_SYMBOLS.has(symCheck)) {
    return res.status(400).json({ error: `La moneda ${symCheck} ya existe como moneda nativa.` });
  }
  const result = await customCoinsService.createCustomCoin(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  await syncCustomPriceSources();
  // Avisar a las billeteras conectadas que hay una moneda nueva.
  await db.prepare(
    'INSERT INTO notifications (title, body, priority, createdAt) VALUES (?, ?, ?, ?)'
  ).run(
    `Nueva moneda disponible: ${result.coin.symbol}`,
    `${result.coin.name || result.coin.symbol} ya esta disponible para intercambio en tu billetera.`,
    'normal',
    nowIso()
  );
  res.status(201).json(result.coin);
});

router.put('/admin/coins/custom/:id', sessionAuth, async (req, res) => {
  const symCheck = String(req.body?.symbol || '').toUpperCase().trim();
  if (symCheck && ordersService.SUPPORTED_SYMBOLS.has(symCheck)) {
    return res.status(400).json({ error: `La moneda ${symCheck} ya existe como moneda nativa.` });
  }
  const result = await customCoinsService.updateCustomCoin(req.params.id, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  await syncCustomPriceSources();
  res.json(result.coin);
});

router.post('/admin/coins/custom/:id/toggle', sessionAuth, async (req, res) => {
  const enabled = req.body && req.body.enabled === false ? false : true;
  const result = await customCoinsService.setCustomCoinEnabled(req.params.id, enabled);
  if (result.error) return res.status(400).json({ error: result.error });
  await syncCustomPriceSources();
  res.json({ ok: true, enabled });
});

router.delete('/admin/coins/custom/:id', sessionAuth, async (req, res) => {
  const result = await customCoinsService.removeCustomCoin(req.params.id);
  if (result.error) return res.status(400).json({ error: result.error });
  await syncCustomPriceSources();
  res.json(result);
});

// ============================================================
// 2FA TOTP — Doble protección del panel
// ============================================================
router.get('/admin/2fa/status', sessionAuth, async (req, res) => {
  const totp = await auth.getTotpStatus();
  res.json({ enabled: totp.enabled === 1, hasSecret: !!totp.secret });
});

router.post('/admin/2fa/setup', sessionAuth, async (req, res) => {
  const result = await auth.setupTotp();
  res.json(result);
});

router.post('/admin/2fa/verify', sessionAuth, async (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!code || code.length !== 6) return res.status(400).json({ error: 'Código de 6 dígitos requerido' });
  const result = await auth.verifyAndEnableTotp(code);
  if (result.error) return res.status(400).json(result);
  auth.refresh2faCache?.();
  res.json(result);
});

router.post('/admin/2fa/disable', sessionAuth, async (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Código requerido para desactivar 2FA' });
  const result = await auth.disableTotp(code);
  if (result.error) return res.status(400).json(result);
  auth.refresh2faCache?.();
  res.json(result);
});

// ============================================================
// Login con 2FA: el login normal verifica password + TOTP si está activo
// ============================================================
const origLoginHandler = router.stack.find(
  (r) => r.route?.path === '/admin/login' && r.route?.methods?.post
);
// No podemos reemplazar fácilmente; en su lugar, añadimos un check
// de 2FA después del login exitoso. Si 2FA está activo, el login
// devuelve { totpRequired: true } y el cliente envía el código.
// Esto se maneja en el handler de login existente (ver más abajo).

// ============================================================
// Sesiones admin: listar, revocar, cerrar todas
// ============================================================
router.get('/admin/sessions', sessionAuth, (req, res) => {
  res.json({ sessions: auth.listSessions() });
});

router.delete('/admin/sessions/:tokenPreview', sessionAuth, (req, res) => {
  // El cliente envía el tokenPreview; destruimos por coincidencia parcial.
  const preview = req.params.tokenPreview;
  let destroyed = false;
  // Nota: necesitamos acceso al mapa interno. Exportaremos una función.
  // Por ahora, destruir por token completo si se proporciona.
  auth.destroySession(preview);
  res.json({ ok: true });
});

router.post('/admin/sessions/revoke-all', sessionAuth, (req, res) => {
  const currentToken = req.get('x-session-token');
  const count = auth.destroyAllSessionsExcept(currentToken);
  res.json({ revoked: count });
});

// ============================================================
// Historial de login (auditoría)
// ============================================================
router.get('/admin/login-history', sessionAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = await db.prepare(
    'SELECT id, ip, userAgent, success, note, createdAt FROM login_events ORDER BY id DESC LIMIT ?'
  ).all(limit);
  res.json({ events: rows });
});

router.get('/admin/login-stats', sessionAuth, async (req, res) => {
  const total = await db.prepare('SELECT COUNT(*) as c FROM login_events').get();
  const failed = await db.prepare('SELECT COUNT(*) as c FROM login_events WHERE success = 0').get();
  const recent = await db.prepare(
    "SELECT COUNT(*) as c FROM login_events WHERE success = 0 AND createdAt > datetime('now', '-1 hour')"
  ).get();
  res.json({
    total: total?.c || 0,
    failed: failed?.c || 0,
    failedLastHour: recent?.c || 0,
  });
});

// ============================================================
// Blocklist de direcciones maliciosas
// ============================================================
router.get('/admin/blocklist', sessionAuth, async (req, res) => {
  res.json({ entries: await autonomous.listBlocklist() });
});

router.post('/admin/blocklist', sessionAuth, async (req, res) => {
  const { address, reason } = req.body || {};
  if (!address || !String(address).trim()) return res.status(400).json({ error: 'address requerida' });
  await autonomous.addToBlocklist(address, reason || '');
  res.json({ ok: true });
});

router.delete('/admin/blocklist/:address', sessionAuth, async (req, res) => {
  await autonomous.removeFromBlocklist(decodeURIComponent(req.params.address));
  res.json({ ok: true });
});

// ============================================================
// Protección autónoma: configuración + alertas
// ============================================================
router.get('/admin/protection/settings', sessionAuth, async (req, res) => {
  res.json(await autonomous.getAllProtectionSettings());
});

router.post('/admin/protection/settings', sessionAuth, async (req, res) => {
  const updates = req.body || {};
  for (const [key, value] of Object.entries(updates)) {
    if (key in autonomous.DEFAULTS || key.endsWith('Enabled') || key.includes('Threshold') || key.includes('Limit') || key.includes('Pct') || key.includes('Sec')) {
      await autonomous.setProtectionSetting(key, value);
    }
  }
  res.json(await autonomous.getAllProtectionSettings());
});

router.get('/admin/protection/alerts', sessionAuth, async (req, res) => {
  const unresolved = await autonomous.getUnresolvedAlerts();
  const recent = await autonomous.getAlertHistory(30);
  res.json({ unresolved, recent });
});

router.post('/admin/protection/alerts/:id/resolve', sessionAuth, async (req, res) => {
  await autonomous.resolveAlert(Number(req.params.id));
  res.json({ ok: true });
});

router.post('/admin/protection/alerts/resolve-all', sessionAuth, async (req, res) => {
  await autonomous.resolveAllAlerts();
  res.json({ ok: true });
});

router.get('/admin/protection/paused', sessionAuth, (req, res) => {
  res.json({ paused: autonomous.getPausedSymbols() });
});

router.post('/admin/protection/pause', sessionAuth, (req, res) => {
  const { symbol, durationMs } = req.body || {};
  if (!symbol) return res.status(400).json({ error: 'symbol requerido' });
  autonomous.pauseSymbol(symbol.toUpperCase(), 'Pausa manual del admin', Number(durationMs) || 0);
  res.json({ ok: true, symbol: symbol.toUpperCase() });
});

router.post('/admin/protection/resume', sessionAuth, (req, res) => {
  const { symbol } = req.body || {};
  if (!symbol) return res.status(400).json({ error: 'symbol requerido' });
  autonomous.resumeSymbol(symbol.toUpperCase());
  res.json({ ok: true, symbol: symbol.toUpperCase() });
});

// ============================================================
// Tokens de dispositivo (app auth mejorada)
// ============================================================
router.post('/auth/device', apiKeyAuth, async (req, res) => {
  const { deviceName, deviceFingerprint } = req.body || {};
  const ip = req.ip || req.connection?.remoteAddress || '';
  const token = await auth.registerDeviceToken(deviceName || 'unknown', deviceFingerprint || '', ip);
  res.status(201).json({ token, expiresIn: '90d' });
});

router.get('/admin/devices', sessionAuth, async (req, res) => {
  res.json({ devices: await auth.listDeviceTokens() });
});

router.post('/admin/devices/revoke', sessionAuth, async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token requerido' });
  await auth.revokeDeviceToken(token);
  res.json({ ok: true });
});

// ============================================================
// Rotación de API key
// ============================================================
router.post('/settings/api-key/rotate', sessionAuth, async (req, res) => {
  const graceMinutes = Number(req.body?.graceMinutes) || 60;
  const newKey = 'cerebro_' + crypto.randomBytes(24).toString('hex');
  const oldKey = await cerebroApiKey();
  // Guardar la key anterior con tiempo de gracia.
  await setSetting('apiKeyPrevious', oldKey);
  await setSetting('apiKeyGraceExpires', new Date(Date.now() + graceMinutes * 60 * 1000).toISOString());
  await setCerebroApiKey(newKey);
  res.json({
    apiKey: newKey,
    previousKeyValidUntil: new Date(Date.now() + graceMinutes * 60 * 1000).toISOString(),
    message: `La key anterior seguirá funcionando por ${graceMinutes} minutos.`,
  });
});

// ============================================================
// Integración: el router necesita acceso a autonomous y auth.
// Se importan al inicio del archivo.
// ============================================================

// ============================================================
// MODO INTERCAMBIO ERLEO AUTOMATIZADO
// ============================================================

// GET /api/v1/erleo/status - estado general del sistema Erleo.
router.get('/erleo/status', apiKeyOrSessionAuth, async (req, res) => {
  res.json(await erleoExchange.getErleoStatus());
});

// POST /api/v1/erleo/auto-mode - activar/desactivar modo automático.
router.post('/erleo/auto-mode', sessionAuth, async (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  res.json(await erleoExchange.toggleAutoMode(enabled));
});

// --- Wallets del servidor ---
// GET /api/v1/erleo/wallets - listar wallets (sin claves privadas).
router.get('/erleo/wallets', sessionAuth, async (req, res) => {
  res.json(await erleoExchange.listWallets({ symbol: req.query.symbol, enabledOnly: req.query.enabled === '1' }));
});

// POST /api/v1/erleo/wallets - crear wallet (address + encryptedKey).
router.post('/erleo/wallets', sessionAuth, async (req, res) => {
  const result = await erleoExchange.createWallet(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result.wallet);
});

// PUT /api/v1/erleo/wallets/:id - editar wallet.
router.put('/erleo/wallets/:id', sessionAuth, async (req, res) => {
  const result = await erleoExchange.updateWallet(req.params.id, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.wallet);
});

// DELETE /api/v1/erleo/wallets/:id - eliminar wallet.
router.delete('/erleo/wallets/:id', sessionAuth, async (req, res) => {
  const result = await erleoExchange.deleteWallet(req.params.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// POST /api/v1/erleo/wallets/import - importar múltiples wallets desde CSV o JSON.
router.post('/erleo/wallets/import', sessionAuth, async (req, res) => {
  const { wallets } = req.body || {};
  if (!Array.isArray(wallets)) return res.status(400).json({ error: 'Se espera un array wallets' });
  const results = [];
  for (const w of wallets) {
    const r = await erleoExchange.createWallet(w);
    results.push(r);
  }
  const created = results.filter((r) => r.wallet).length;
  const errors = results.filter((r) => r.error).map((r) => r.error);
  res.json({ created, errors });
});

// --- Transacciones Erleo ---
// GET /api/v1/erleo/transactions - historial de transacciones.
router.get('/erleo/transactions', sessionAuth, async (req, res) => {
  let sql = 'SELECT * FROM erleo_transactions';
  const params = [];
  const clauses = [];
  if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
  if (req.query.symbol) { clauses.push('symbol = ?'); params.push(req.query.symbol.toUpperCase()); }
  if (req.query.orderId) { clauses.push('orderId = ?'); params.push(req.query.orderId); }
  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
  sql += ' ORDER BY createdAt DESC LIMIT ?';
  params.push(Math.min(Number(req.query.limit) || 100, 500));
  res.json(await db.prepare(sql).all(...params));
});

// POST /api/v1/erleo/execute-swap - ejecutar un intercambio automatizado.
router.post('/erleo/execute-swap', sessionAuth, async (req, res) => {
  const { fromSymbol, fromNetwork, fromAmount, toSymbol, toNetwork, toAddress, speed = 'medium' } = req.body || {};
  if (!fromSymbol || !toSymbol || !fromAmount || !toAddress) {
    return res.status(400).json({ error: 'fromSymbol, toSymbol, fromAmount, toAddress requeridos' });
  }
  // Verificar si se puede ejecutar.
  const check = await erleoExchange.canExecuteAutoSwap(fromSymbol, fromNetwork || '', toSymbol, toNetwork || '', Number(fromAmount));
  if (!check.ok) return res.status(400).json({ error: check.error });
  // Calcular monto neto.
  const estReceive = Number(req.body?.estReceive) || 0;
  const appRate = estReceive > 0 ? estReceive / Number(fromAmount) : 0;
  const calc = await erleoExchange.calculateSwapResult(fromSymbol, Number(fromAmount), toSymbol, speed, appRate);
  if (!calc.ok) return res.status(400).json({ error: calc.error });
  // Registrar transacción.
  const tx = await erleoExchange.createTransaction({
    type: 'swap',
    symbol: fromSymbol,
    network: fromNetwork || '',
    fromAddress: check.sourceWallet.address,
    toAddress,
    amount: Number(fromAmount),
  });
  res.status(201).json({ transaction: tx, result: calc });
});

// POST /api/v1/erleo/broadcast/:id - broadcast de una transacción pendiente.
router.post('/erleo/broadcast/:id', sessionAuth, async (req, res) => {
  const id = Number(req.params.id);
  const txHash = req.body?.txHash || '';
  if (!txHash) return res.status(400).json({ error: 'txHash requerido' });
  await erleoExchange.markBroadcasting(id, txHash);
  res.json({ ok: true, id, txHash });
});

// POST /api/v1/erleo/confirm/:id - confirmar una transacción.
router.post('/erleo/confirm/:id', sessionAuth, async (req, res) => {
  const id = Number(req.params.id);
  const confirmations = Number(req.body?.confirmations) || 1;
  const fee = Number(req.body?.fee) || 0;
  await erleoExchange.markConfirmed(id, confirmations, fee);
  res.json({ ok: true, id, confirmations, fee });
});

// POST /api/v1/erleo/fail/:id - marcar una transacción como fallida.
router.post('/erleo/fail/:id', sessionAuth, async (req, res) => {
  const id = Number(req.params.id);
  const note = req.body?.note || '';
  await erleoExchange.markFailed(id, note);
  res.json({ ok: true, id });
});

export default router;
