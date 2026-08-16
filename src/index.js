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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;

const app = express();
app.use(express.json({ limit: '100kb' }));

// Proteccion basica contra fuerza bruta en el login.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Demasiados intentos, intente mas tarde' },
});
app.post('/api/v1/admin/login', loginLimiter);

app.use('/api/v1', apiRouter);

// Health check para el indicador de conexion del dashboard.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
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
