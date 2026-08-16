// ============================================================
// Nodos de Cake Wallet.
// Se descargan de la lista oficial publica del repositorio de Cake Wallet
// y se guardan en una carpeta SEPARADA (data/cake_nodes) sin mezclarse con
// los nodos manuales del admin. Se extraen TODOS los nodos de cada lista y
// se importan al Cerebro como nodos oficiales: pueden desactivarse pero
// NO eliminarse. Los nodos manuales si se pueden eliminar.
// ============================================================
import { db, nowIso } from '../db/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Carpeta aparte donde se guardan las listas descargadas.
export const CAKE_DIR = path.join(__dirname, '..', '..', 'data', 'cake_nodes');

// Lista oficial publica de Cake Wallet (rama main, assets).
const GITHUB_RAW = 'https://raw.githubusercontent.com/caketech/cake_wallet/main/assets';

// Fallback offline: el repo local de la billetera (MiBoveda_Erleo_Final) si no hay internet.
const FALLBACK_DIR = path.join(os.homedir(), 'Pictures', 'MiBoveda_Erleo_Final', 'assets');

// Mapeo de cada lista oficial al/los simbolo(s) del Cerebro que cubre.
export const CAKE_LISTS = [
  { file: 'node_list.yml', symbols: ['XMR'] },
  { file: 'bitcoin_electrum_server_list.yml', symbols: ['BTC'] },
  { file: 'litecoin_electrum_server_list.yml', symbols: ['LTC'] },
  { file: 'bitcoin_cash_electrum_server_list.yml', symbols: ['BCH'] },
  { file: 'dogecoin_electrum_server_list.yml', symbols: ['DOGE'] },
  { file: 'zcash_node_list.yml', symbols: ['ZEC'] },
  { file: 'decred_node_list.yml', symbols: ['DCR'] },
  { file: 'nano_node_list.yml', symbols: ['XNO'] },
  { file: 'banano_node_list.yml', symbols: ['BAN'] },
  { file: 'wownero_node_list.yml', symbols: ['WOW'] },
  { file: 'zano_node_list.yml', symbols: ['ZANO'] },
  { file: 'haven_node_list.yml', symbols: ['XHV'] },
  { file: 'ethereum_server_list.yml', symbols: ['ETH'] },
  { file: 'arbitrum_node_list.yml', symbols: ['ARB'] },
  { file: 'base_node_list.yml', symbols: ['BASE'] },
  { file: 'bsc_node_list.yml', symbols: ['BNB'] },
  { file: 'polygon_node_list.yml', symbols: ['POL'] },
  { file: 'solana_node_list.yml', symbols: ['SOL'] },
  { file: 'tron_node_list.yml', symbols: ['TRX'] },
];

// Parsea el formato simple de las listas (bloques "-" con "clave: valor").
function parseNodeList(text) {
  const entries = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '-') {
      current = {};
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^\d+(\.\d+)?$/.test(val)) val = Number(val);
    current[key] = val;
  }
  return entries.filter((e) => e && e.uri);
}

// Construye las filas de nodos a partir de una entrada de la lista.
function toNodeRows(entries, symbol) {
  return entries.map((e) => {
    const useSsl = e.useSSL !== false;
    const host = String(e.uri).trim();
    const p = String(e.path || '').trim();
    const uri = `${useSsl ? 'https' : 'http'}://${host}${p ? (p.startsWith('/') ? p : '/' + p) : ''}`;
    return {
      symbol,
      name: String(e.label || host).trim() || host,
      uri,
      official: true,
      trusted: !!e.trusted,
      isDefault: false,
      autoSwitch: e.isEnabledForAutoSwitching !== false,
    };
  });
}

async function fetchFile(file) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${GITHUB_RAW}/${file}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// Descarga/importa (o re-importa) todos los nodos de Cake Wallet.
export async function syncCakeNodes() {
  await fs.mkdir(CAKE_DIR, { recursive: true });
  const ts = nowIso();
  let files = 0;
  let imported = 0;
  let skipped = 0;
  for (const { file, symbols } of CAKE_LISTS) {
    let text = null;
    try {
      text = await fetchFile(file);
    } catch {
      // Fallback: leer la lista local de la billetera si existe.
      try {
        text = await fs.readFile(path.join(FALLBACK_DIR, file), 'utf8');
      } catch (_) {
        skipped++;
        continue;
      }
    }
    try {
      await fs.writeFile(path.join(CAKE_DIR, file), text, 'utf8');
      files++;
    } catch (_) {}
    const entries = parseNodeList(text);
    if (!entries.length) continue;
    for (const symbol of symbols) {
      for (const e of toNodeRows(entries, symbol)) {
        const exists = await db.prepare('SELECT id FROM nodes WHERE symbol = ? AND uri = ?').get(e.symbol, e.uri);
        if (exists) continue;
        await db.prepare(`
          INSERT INTO nodes (symbol, name, uri, useSsl, trusted, isOfficial, isDefault, autoSwitch, enabled, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
          e.symbol, e.name, e.uri,
          e.uri.startsWith('https') ? 1 : 0,
          e.trusted ? 1 : 0,
          1, 0, e.autoSwitch ? 1 : 0, ts
        );
        imported++;
      }
    }
  }
  return { files, imported, skipped };
}

// Al arrancar: importa solo si nunca se hizo o la lista tiene mas de 24h.
export async function ensureCakeNodes() {
  const last = await db.prepare("SELECT value FROM settings WHERE key = 'cakeNodesSyncedAt'").get();
  const lastTs = last ? new Date(last.value).getTime() : 0;
  const age = Date.now() - lastTs;
  if (lastTs && age < 24 * 60 * 60 * 1000) return { cached: true };
  try {
    const r = await syncCakeNodes();
    await db.prepare(`
      INSERT INTO settings (key, value) VALUES ('cakeNodesSyncedAt', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(nowIso());
    return r;
  } catch {
    return { cached: false, error: 'no se pudieron importar los nodos de Cake Wallet' };
  }
}
