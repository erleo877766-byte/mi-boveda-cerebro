import { Router } from 'express';
import crypto from 'node:crypto';
import { db, nowIso, getSetting, setSetting } from '../db/index.js';
import { apiKeyAuth, sessionAuth, apiKeyOrSessionAuth, createSession, destroySession, cerebroApiKey, setCerebroApiKey } from '../middleware/auth.js';
import * as ordersService from '../services/orders.js';
import { maxOrderUsd, setMaxOrderUsd, orderExpiryHours, expirePendingOrders } from '../services/orders.js';
import * as reportsService from '../services/reports.js';
import { NORMAL_COMMISSION, commissionUsdFor, specialCommissionFor, commissionPercent, setCommissionPercent, commissionUsdAll, setCommissionUsdAll, coinCommissionPercent, coinCommissionsAll, setCoinCommission } from '../services/commission.js';
import * as nodesService from '../services/nodes.js';
import * as balanceService from '../services/balance.js';
import { syncCakeNodes } from '../services/cakeNodes.js';
import { priceUsd, setCustomCoinSources } from '../services/prices.js';
import * as customCoinsService from '../services/customCoins.js';
import { mapLimit } from '../utils.js';
import { validateAddress } from '../services/address_validation.js';

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
router.post('/admin/login', (req, res) => {
  const ip = clientIp(req);
  const blocked = loginBlocked(ip);
  if (blocked) {
    const retry = Math.ceil((blocked - Date.now()) / 1000);
    return res.status(429).json({ error: `Demasiados intentos. Reintenta en ${retry}s` });
  }
  const password = req.body && req.body.password;
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected) return res.status(500).json({ error: 'ADMIN_PASSWORD no configurada' });
  if (safeEqual(password, expected)) {
    registerLoginSuccess(ip);
    return res.json({ token: createSession() });
  }
  registerLoginFail(ip);
  res.status(401).json({ error: 'Contrasena incorrecta' });
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

  // Nodos: la app NO tiene lista propia, el Cerebro es el unico que la tiene.
  const allNodes = await nodesService.listNodes({ enabledOnly: true });
  const nodes = nodesService.toAppNodes(allNodes);

  return {
    name: 'Cerebro Mi Boveda',
    globalEnabled,
    commissionSlowUsd: usdComms.slow,
    commissionMediumUsd: usdComms.medium,
    commissionFastUsd: usdComms.fast,
    commissionPercent: percent,
    adminCommissionExemption: true,
    minAppVersion: 0,
    coins,
    customTokens,
    specialCommissions,
    nodes,
    announcements: [],
    erleoExchangeEnabled,
  };
}

router.get('/config', apiKeyAuth, async (req, res) => {
  res.json(await buildConfig());
});

// ============================================================
// Ordenes (usadas por la app y por el dashboard)
// ============================================================
// POST /api/v1/orders - la app envia una orden de intercambio pequeno.
router.post('/orders', apiKeyAuth, async (req, res) => {
  const key = req.get('x-api-key') || req.get('x-cerebro-api-key') || '';
  if (orderRateLimited(key)) {
    return res.status(429).json({ error: 'Demasiadas ordenes, espera un rato' });
  }
  const result = await ordersService.createOrder(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result.order);
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
  const symbols = [...ordersService.SUPPORTED_SYMBOLS, ...customSymbols].sort();
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
  const rows = await db.prepare(
    'SELECT id, title, body, createdAt FROM notifications WHERE id > ? ORDER BY id ASC'
  ).all(after);
  res.json({ notifications: rows });
});

// POST /api/v1/notifications - el admin envia una notificacion desde el panel.
router.post('/notifications', sessionAuth, async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  if (!title) return res.status(400).json({ error: 'title requerido' });
  const r = await db.prepare(
    'INSERT INTO notifications (title, body, createdAt) VALUES (?, ?, ?)'
  ).run(title, body, nowIso());
  const id = typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid;
  res.status(201).json({ id, title, body });
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
  const all = [...ordersService.SUPPORTED_SYMBOLS, ...customSyms].sort();
  const requested = req.query.symbols
    ? String(req.query.symbols).split(',').map((s) => s.trim().toUpperCase()).filter((s) => all.includes(s))
    : all;
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
  const result = await customCoinsService.createCustomCoin(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  await syncCustomPriceSources();
  res.status(201).json(result.coin);
});

router.put('/admin/coins/custom/:id', sessionAuth, async (req, res) => {
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

export default router;
