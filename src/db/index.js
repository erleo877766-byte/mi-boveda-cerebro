import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', '..', 'data');
mkdirSync(dataDir, { recursive: true });

// Si TURSO_DATABASE_URL esta definido (Render/produccion) se usa la DB remota
// de Turso (persistente gratis). Si no, se usa un archivo SQLite local.
const url = process.env.TURSO_DATABASE_URL || `file:${path.join(dataDir, 'cerebro.db')}`;
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

const client = createClient({ url, authToken });

export async function initSchema() {
  // PRAGMA solo aplica a la DB local; en remoto se ignora silenciosamente.
  try {
    await client.execute('PRAGMA journal_mode = WAL;');
  } catch (_) {}
  try {
    await client.execute('PRAGMA foreign_keys = ON;');
  } catch (_) {}

  await client.executeMultiple(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Direcciones de reserva propias por moneda (de donde sale el dinero del admin)
CREATE TABLE IF NOT EXISTS reserves (
  symbol      TEXT PRIMARY KEY,           -- XNO, BTC, XMR...
  network     TEXT NOT NULL DEFAULT '',   -- red para multi-network (ej. arb, btc)
  address     TEXT NOT NULL,              -- direccion de reserva (origen) para esa moneda
  receiveAddress TEXT NOT NULL DEFAULT '',-- direccion donde el admin RECIBE la moneda origen del usuario
  payoutAddress  TEXT NOT NULL DEFAULT '',-- direccion desde la que el admin ENVIA la moneda destino
  balance     REAL NOT NULL DEFAULT 0,    -- saldo disponible en esa moneda en la wallet del admin
  enabled     INTEGER NOT NULL DEFAULT 1
);

-- Comision especial opcional para ordenes pequeñas por moneda destino.
-- Si no existe fila o specialUsd es NULL/0 -> se usa la regla normal por velocidad.
CREATE TABLE IF NOT EXISTS small_order_commission (
  symbol     TEXT PRIMARY KEY,
  specialUsd REAL NOT NULL DEFAULT 0
);

-- Comision en % por moneda (rediseno: una fila por criptomoneda de la billetera).
-- Si no existe fila o percent es 0 -> se usa la regla global erleoCommissionPercent.
CREATE TABLE IF NOT EXISTS coin_commissions (
  symbol     TEXT PRIMARY KEY,
  percent    REAL NOT NULL DEFAULT 0
);

-- Direcciones de cobro y reserva por moneda Y red (una o varias redes por moneda).
-- network '' = red principal. El Cerebro es el unico que las conoce y usa.
CREATE TABLE IF NOT EXISTS coin_addresses (
  symbol         TEXT NOT NULL,
  network        TEXT NOT NULL DEFAULT '',
  address        TEXT NOT NULL DEFAULT '',  -- direccion de cobro de comisiones (donde me pagan)
  receiveAddress TEXT NOT NULL DEFAULT '',  -- donde RECIBO la moneda del usuario
  payoutAddress  TEXT NOT NULL DEFAULT '',  -- desde donde ENVIO al usuario (reserva)
  balance        REAL NOT NULL DEFAULT 0,   -- balance manual de reserva (fallback si no hay nodo)
  enabled        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (symbol, network)
);

CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,          -- id unico de la app
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | completed | cancelled
  fromSymbol    TEXT NOT NULL,
  fromNetwork   TEXT NOT NULL DEFAULT '',
  fromAmount    REAL NOT NULL,
  toSymbol      TEXT NOT NULL,
  toNetwork     TEXT NOT NULL DEFAULT '',
  toAddress     TEXT NOT NULL,             -- direccion destino del usuario
  toExtraId     TEXT NOT NULL DEFAULT '',
  speed         TEXT NOT NULL DEFAULT 'medium',  -- slow | medium | fast
  estReceive    REAL NOT NULL DEFAULT 0,   -- monto estimado a recibir (lo que calculo la app)
  appRate       REAL NOT NULL DEFAULT 0,   -- tasa estimada to/from enviada por la app
  commissionUsd REAL NOT NULL DEFAULT 0,   -- comision aplicada (USD)
  netToAmount   REAL NOT NULL DEFAULT 0,   -- monto neto a entregar al usuario (despues de comision)
  commissionPercent REAL NOT NULL DEFAULT 0, -- % de comision aplicado (0 = fallback USD fijo)
  providerFeeSavedUsd REAL NOT NULL DEFAULT 0,
  userLabel     TEXT NOT NULL DEFAULT '',  -- identificacion del usuario (nombre/alias si app lo envia)
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL,
  approvedAt    TEXT,
  completedAt   TEXT,
  rejectedAt    TEXT,
  adminNote     TEXT NOT NULL DEFAULT '',
  txHashPayout  TEXT NOT NULL DEFAULT '',  -- hash de la tx con la que el admin envio al usuario
  txHashRefund  TEXT NOT NULL DEFAULT '',  -- hash de la tx con la que el admin recibio del usuario
  cancelledReason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS commission_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId        TEXT NOT NULL,
  fromSymbol     TEXT NOT NULL,
  toSymbol       TEXT NOT NULL,
  speed          TEXT NOT NULL,
  commissionUsd  REAL NOT NULL,
  commissionSymbol TEXT NOT NULL,          -- moneda en que se desconto (origen)
  commissionAmount REAL NOT NULL,          -- cantidad de cripto descontada
  grossFromAmount REAL NOT NULL,           -- monto enviado por el usuario
  netToAmount    REAL NOT NULL,            -- monto entregado al usuario
  providerFeeSavedUsd REAL NOT NULL DEFAULT 0,
  networkFeeUsd  REAL NOT NULL DEFAULT 0,
  createdAt      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId   TEXT NOT NULL,
  fromStatus TEXT NOT NULL,
  toStatus  TEXT NOT NULL,
  note      TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL
);

-- Notificaciones broadcast: la app las consulta por polling y las muestra.
CREATE TABLE IF NOT EXISTS notifications (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  title     TEXT NOT NULL,
  body      TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL
);

-- Nodos por criptomoneda: el Cerebro los administra y decide cual usar.
CREATE TABLE IF NOT EXISTS nodes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol     TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  uri        TEXT NOT NULL,
  useSsl     INTEGER NOT NULL DEFAULT 1,
  trusted    INTEGER NOT NULL DEFAULT 0,
  isOfficial INTEGER NOT NULL DEFAULT 0,
  isDefault  INTEGER NOT NULL DEFAULT 0,
  autoSwitch INTEGER NOT NULL DEFAULT 1,
  enabled    INTEGER NOT NULL DEFAULT 1,
  latencyMs  REAL NOT NULL DEFAULT 0,    -- ultima latencia medida (0 = sin medir)
  coverage   REAL NOT NULL DEFAULT 0,    -- cobertura/sync 0-100
  lastCheck  TEXT NOT NULL DEFAULT '',   -- fecha de la ultima medicion
  createdAt  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_symbol ON nodes (symbol);

-- Criptomonedas personalizadas: agregadas por el admin desde el panel.
-- Se propagan a la app (feeAddress, tokens EVM) sin necesidad de recompilar.
CREATE TABLE IF NOT EXISTS custom_coins (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol          TEXT NOT NULL UNIQUE,          -- simbolo (XNO, ERLEO...)
  name            TEXT NOT NULL DEFAULT '',      -- nombre completo
  network         TEXT NOT NULL DEFAULT 'custom',-- nano | bitcoin | ethereum | erc20 | bep20 | base | arbitrum | tron | trc20 | solana | custom
  contractAddress TEXT NOT NULL DEFAULT '',      -- contrato del token (EVM/TRC20)
  logo            TEXT NOT NULL DEFAULT '',      -- data URI del logo
  feeAddress      TEXT NOT NULL DEFAULT '',      -- direccion de cobro de comisiones
  reserveAddress  TEXT NOT NULL DEFAULT '',      -- direccion de reserva / envio al usuario
  enabled         INTEGER NOT NULL DEFAULT 1,
  createdAt       TEXT NOT NULL
);
`);

  // Migraciones para tablas que ya existían sin columnas nuevas.
  const migrations = [
    ['ALTER TABLE reserves ADD COLUMN balance REAL NOT NULL DEFAULT 0', 'reserves.balance'],
    ['ALTER TABLE orders ADD COLUMN commissionPercent REAL NOT NULL DEFAULT 0', 'orders.commissionPercent'],
  ];
  for (const [sql, name] of migrations) {
    try {
      await client.execute(sql);
      console.log(`[Cerebro] Migración aplicada: ${name}`);
    } catch (_) {
      // La columna ya existe (o la DB no soporta ALTER): silencioso.
    }
  }

  // Migrar reservas viejas (una por moneda) a coin_addresses (por moneda y red).
  const legacy = await client.execute('SELECT * FROM reserves');
  if (legacy.rows.length) {
    for (const r of legacy.rows) {
      try {
        await client.execute({
          sql: `
            INSERT OR IGNORE INTO coin_addresses
              (symbol, network, address, receiveAddress, payoutAddress, balance, enabled)
            VALUES (?, '', ?, ?, ?, ?, ?)
          `,
          args: [r.symbol, r.address || '', r.receiveAddress || '', r.payoutAddress || '', Number(r.balance) || 0, r.enabled ?? 1],
        });
      } catch (_) {}
    }
    console.log(`[Cerebro] Migración: ${legacy.rows.length} reservas -> coin_addresses`);
  }
}

function stmt(sql) {
  return {
    async get(...args) {
      const r = await client.execute({ sql, args });
      return r.rows.length ? r.rows[0] : undefined;
    },
    async all(...args) {
      const r = await client.execute({ sql, args });
      return r.rows;
    },
    async run(...args) {
      const r = await client.execute({ sql, args });
      return { rowsAffected: r.rowsAffected ?? 0, lastInsertRowid: r.lastInsertRowid };
    },
  };
}

export const db = {
  prepare: stmt,
  async exec(sql) {
    await client.executeMultiple(sql);
  },
};

export async function getSetting(key, def = '') {
  const row = await stmt('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

export async function setSetting(key, value) {
  await stmt(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function nowIso() {
  return new Date().toISOString();
}
