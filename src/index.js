import express from 'express';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import apiRouter from './routes/api.js';
import { initSchema, getSetting, setSetting } from './db/index.js';
import { cerebroApiKey, setCerebroApiKey } from './middleware/auth.js';
import { expirePendingOrders, SUPPORTED_SYMBOLS } from './services/orders.js';
import { seedDefaultNodes, startNodeMonitor } from './services/nodes.js';
import { ensureCakeNodes } from './services/cakeNodes.js';
import { startPricePoller, setCustomCoinSources } from './services/prices.js';
import { customSymbols } from './services/customCoins.js';
import { startProtectionMonitor } from './services/autonomous.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;

const app = express();

// ============================================================
// Seguridad: headers HTTP que protegen contra ataques comunes.
// ============================================================
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// ============================================================
// CORS: solo permite el panel y dominios conocidos.
// ============================================================
app.use((req, res, next) => {
  const origin = req.get('origin');
  const allowed = [
    'https://miboveda-cerebro.onrender.com',
    'http://localhost:8787',
    'http://localhost:3000',
    'https://leonard0001991.github.io',
  ];
  if (origin && allowed.some((a) => origin.startsWith(a))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    // Requests sin origin (app, curl, server-to-server) se permiten.
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-cerebro-api-key, x-session-token, x-device-token');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '100kb' }));

// Proteccion contra fuerza bruta en el login.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Demasiados intentos, intente mas tarde' },
});
app.post('/api/v1/admin/login', loginLimiter);

// Rate limiting para descargas: max 10 descargas por IP por hora.
const dlLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiadas descargas, intenta mas tarde' },
});

app.use('/api/v1', apiRouter);

// Health check para el indicador de conexion del dashboard.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ============================================================
// Descarga de instaladores: proxy a los assets de GitHub Releases.
// Hay redes donde el CDN de descargas de GitHub falla (la descarga se
// queda en 100% y nunca termina). Este endpoint sirve los archivos a
// traves del propio servidor (dominio onrender, sin ese CDN) haciendo
// de puente: el servidor baja el archivo desde GitHub y lo transmite.
// ============================================================
const DOWNLOADABLE_FILES = new Map([
  ['MiBoveda.apk', 'MiBoveda.apk'],
  ['MiBovedaAntiguos.apk', 'MiBovedaAntiguos.apk'],
  ['MiBovedaEmulador.apk', 'MiBovedaEmulador.apk'],
  ['MiBovedaSetup.exe', 'MiBovedaSetup.exe'],
]);

app.get('/dl/:file', dlLimiter, async (req, res) => {
  const file = req.params.file;
  if (!DOWNLOADABLE_FILES.has(file)) {
    return res.status(404).json({ error: 'Archivo no disponible' });
  }
  const url = `https://github.com/erleo877766-byte/mi-boveda/releases/download/latest/${file}`;
  try {
    const upstream = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'Error al obtener el archivo' });
    }
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const { Readable } = await import('node:stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: 'Error de conexion con el origen' });
    else res.destroy();
  }
});

// Dashboard web estatico.
app.use(express.static(path.join(__dirname, '..', 'public')));

// ============================================================
// Primer arranque: crear esquema y claves si no existen.
// ============================================================
async function bootstrap() {
  await initSchema();

  // Si no hay API key en la DB ni en .env, generar una y persistirla en la DB.
  if (!(await cerebroApiKey())) {
    const key = 'cerebro_' + crypto.randomBytes(24).toString('hex');
    await setCerebroApiKey(key);
    console.log('[Cerebro] CEREBRO_API_KEY generada: ' + key);
    console.log('[Cerebro] Se muestra UNA SOLA VEZ en el panel (pestana Intercambios Erleo).');
  }
  if (!process.env.ADMIN_PASSWORD) {
    process.env.ADMIN_PASSWORD = 'admin_' + crypto.randomBytes(4).toString('hex');
    console.log('[Cerebro] ADMIN_PASSWORD generada: ' + process.env.ADMIN_PASSWORD);
  }
  await setSetting('generated', '1');

  // Nodos por defecto si la tabla esta vacia (la app les pregunta al Cerebro).
  await seedDefaultNodes().catch(() => {});

  // Nodos de Cake Wallet: importa la lista oficial publica en una carpeta
  // aparte (data/cake_nodes) y los muestra como oficiales (no borrables).
  await ensureCakeNodes().then((r) => {
    if (!r.cached) console.log('[Cerebro] Nodos de Cake Wallet sincronizados:', r.imported ?? r.error ?? '');
  }).catch(() => {});

  // Monitor continuo: el Cerebro vigila todos los nodos todo el tiempo y
  // elige el de mayor cobertura (auto-seleccion) para cada moneda.
  startNodeMonitor();

  // Precios en vivo: poller de fondo que refresca todas las monedas cada 15s
  // para que el panel y la billetera vean el mismo precio casi en tiempo real.
  const custom = await customSymbols();
  setCustomCoinSources(custom);
  startPricePoller([...SUPPORTED_SYMBOLS, ...custom.map((c) => c.symbol)], 15_000);

  // Auto-rechazo periodico de ordenes pending vencidas (cada 6h).
  expirePendingOrders().catch(() => {});
  setInterval(() => {
    expirePendingOrders().catch(() => {});
  }, 6 * 60 * 60 * 1000);

  // CEREBRO AUTÓNOMO: monitoreo de protección (saldos, volatilidad, sospechosos).
  startProtectionMonitor();

  app.listen(PORT, () => {
    console.log(`[Cerebro] Mi Boveda Cerebro server en http://localhost:${PORT}`);
    console.log(`[Cerebro] Dashboard: http://localhost:${PORT}/`);
    console.log(`[Cerebro] API:       http://localhost:${PORT}/api/v1`);
  });
}

bootstrap().catch((err) => {
  console.error('[Cerebro] Error al iniciar:', err);
  process.exit(1);
});
