# Mi Bóveda · Cerebro Server

Servidor backend del sistema **Erleo**: intercambios propios para montos por debajo del
mínimo permitido por ChangeNOW, con comisiones en categoría separada y dashboard web
de aprobación manual.

## ¿Qué hace?

Cuando un usuario intenta cambiar un monto menor al mínimo de ChangeNOW (ej. 10 XNO
cuando el mínimo es ~18.05), la app **no muestra error**: envía la orden al Cerebro y
muestra "Procesando tu intercambio…".

En el dashboard web (solo tú), la orden aparece como **pendiente**. Tú decides:

- **✅ Aceptar** → se calcula tu comisión (USD convertida a la moneda origen) y el
  monto neto a entregar al usuario. El panel te indica la dirección de tu reserva para
  recibir la moneda origen y cuánto enviar de la moneda destino. Ejecutas manualmente y
  marcas **completada**.
- **❌ Rechazar** → la app muestra el mensaje oficial del mínimo.

Todo queda registrado en la contabilidad separada **"Comisiones - Intercambios Erleo"**,
sin mezclarse con envíos ni con ChangeNOW.

## Requisitos

- Node.js ≥ 22.5.

## Instalación y arranque

```bash
cd server
npm install
cp .env.example .env   # edita las claves
npm start
```

Dashboard: `http://localhost:8787/`
API: `http://localhost:8787/api/v1`

### Variables de entorno (`.env`)

| Variable | Descripción |
|---|---|
| `PORT` | Puerto (por defecto `8787`) |
| `CEREBRO_API_KEY` | Clave que usan las billeteras (header `x-api-key`). Debe coincidir con la configurada en la app. |
| `ADMIN_PASSWORD` | Contraseña del dashboard web. |
| `SESSION_SECRET` | Secreto de sesión (por ahora no crítico, se reserva). |
| `TURSO_DATABASE_URL` | *(opcional)* URL de la base Turso (`libsql://...`). Si no se define, se usa un SQLite local. |
| `TURSO_AUTH_TOKEN` | *(opcional)* Token de acceso de Turso. Solo necesario con `TURSO_DATABASE_URL`. |

> En el **primer arranque**, si faltan `CEREBRO_API_KEY` o `ADMIN_PASSWORD`, se generan
> automáticamente y se imprimen en consola.

## Persistencia de datos (importante)

El servidor guarda órdenes, configuración y claves en una base de datos. Dos modos:

- **Local (desarrollo):** si no defines `TURSO_DATABASE_URL`, se usa un archivo
  `data/cerebro.db` en tu máquina.
- **Turso (producción gratis):** define `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN`.
  Turso ofrece una base **libSQL** compatible con SQLite, gratis y persistente, ideal
  para Render Free (cuyo disco local se borra en cada reinicio).

```bash
# crear base y token en Turso
turso db create cerebro
turso db show --url cerebro        # -> TURSO_DATABASE_URL
turso db tokens create cerebro     # -> TURSO_AUTH_TOKEN
```

## Despliegue en Render Free (gratis, siempre encendido con primer acceso)

Render Free tiene el **sistema de archivos efímero**: cualquier archivo local
(como `data/cerebro.db`) se borra cada vez que el servicio se duerme (15 min sin
tráfico) o se redepliega. Por eso **obligatorio** usar Turso para los datos.

1. Crea una base en Turso (gratis) y copia la URL + token.
2. En **render.com**: `New +` → **Web Service** → conecta tu repo de GitHub.
3. Configura:
   - **Name:** `miboveda-cerebro`
   - **Runtime:** `Node`
   - **Branch:** `main`
   - **Build Command:** `cd server && npm install`
   - **Start Command:** `cd server && npm start`
   - **Instance Type:** `Free`
4. En **Environment** agrega:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - `ADMIN_PASSWORD` (contraseña de tu dashboard)
   - `CEREBRO_API_KEY` (la misma que llevará la app; si la dejas vacía se genera
     automáticamente y se imprime en los logs del primer arranque)
5. **Create Web Service.** Render te da una URL fija, ej. `https://miboveda-cerebro.onrender.com`.
   Esa es la dirección que va dentro de la app (sin puerto).

> Al dormirse por inactividad, el primer acceso tarda ~30-60 s en despertar.

## Despliegue global (producción)

Para que las apps de todo el mundo se conecten, el servidor debe estar en una
**IP/dominio público fijo** (un VPS). Tú operas desde el panel web o desde el
panel dentro de la app; tu PC local nunca se expone.

### Opción A: script de despliegue automático (VPS Ubuntu/Debian)

En el VPS (como root o con sudo), con el DNS de tu dominio apuntando a la IP:

```bash
DOMAIN=api.miboveda.com EMAIL=admin@miboveda.com bash <(curl -sL https://raw.githubusercontent.com/leonard0001991/mi-boveda/main/server/deploy.sh)
```

El script:
1. Instala Node 22, Nginx y Certbot.
2. Clona `server/` en `/opt/miboveda-cerebro`.
3. Crea el servicio systemd `miboveda-cerebro` (autoreinicio).
4. Configura Nginx como proxy inverso + HTTPS (Let's Encrypt).
5. En el primer arranque genera `ADMIN_PASSWORD` y `CEREBRO_API_KEY` y las imprime
   en los logs; la API key también se muestra una sola vez en el panel.

### Opción B: manual

```bash
cd server
npm install --omit=dev
cp .env.example .env   # edita ADMIN_PASSWORD / CEREBRO_API_KEY
npm start              # o usa systemd/nodemon/PM2
```

Y delante un proxy (Nginx/Caddy) con TLS. La app solo necesita la URL final
`https://tu-dominio` y la misma `CEREBRO_API_KEY`.

## Cómo conectar la app

1. En `lib/core/cerebro_service.dart` de la app, pon la URL de tu servidor en
   `kCerebroServerUrl` y la API key en `kCerebroApiKey`:

   ```dart
   static const String kCerebroServerUrl = 'https://miboveda-cerebro.onrender.com';
   static const String kCerebroApiKey = 'la_misma_cerebro_api_key';
   ```

2. Compila la app. Cuando detecte un monto por debajo del mínimo y el servidor tenga
   `erleoExchangeEnabled: true`, ofrecerá el intercambio propio.

### Clave API: se muestra una sola vez

La clave API la genera el servidor automáticamente (en el primer arranque) y se guarda
en la DB. En el dashboard, pestaña **Clave API**, se muestra **una sola vez**: cópiala y
pégala en `kCerebroApiKey` antes de compilar. Después de marcarla como vista ya no
vuelve a aparecer completa (solo puedes regenerarla, lo que invalida los builds
anteriores).

## Panel de escritorio (dentro de la app)

Además del dashboard web, la propia app tiene un panel **Intercambios Erleo** (Ajustes >
Intercambios Erleo) que se conecta al servidor global con la contraseña de
administrador y permite, desde la app de escritorio:

- Botón grande 🟢 **Activar** / 🔴 **Detener** (un clic, persistente en el servidor).
- Ver órdenes pendientes del mundo entero y **✅ Aceptar** / **❌ Rechazar**.
- Marcar envíos como **completados**.
- Reporte de comisiones y **direcciones de reserva**.
- Ver/copiar la clave API.

Las órdenes quedan guardadas en el servidor aunque apagues tu PC: al volver, el panel
muestra todas las pendientes acumuladas.

## Configuración del dashboard

### Direcciones de reserva (obligatorio para aprobar)

En la pestaña **Direcciones de reserva** agrega, por moneda:

- **Moneda**: `XNO`, `BTC`, `XMR`, etc.
- **Red**: opcional (ej. `btc`, `arb`).
- **Dirección de reserva**: tu dirección principal de esa moneda (de donde sale el pago).
- **Recepción** (opcional): dónde recibes la moneda del usuario si es distinta.
- **Pago** (opcional): desde dónde envías al usuario si es distinta.

Sin reserva configurada para la moneda origen o destino, la orden **no se puede aprobar**
(validación doble).

### Comisión especial para órdenes pequeñas (opcional)

Por defecto se usan los montos fijos por velocidad: **Lento $0.10 · Normal $0.25 · Rápido $0.50** (USD).

Puedes definir una comisión distinta solo para órdenes pequeñas por moneda destino vía API:

```bash
curl -X POST http://localhost:8787/api/v1/small-commissions \
  -H "Content-Type: application/json" -H "x-session-token: <token>" \
  -d '{"symbol":"BTC","specialUsd":0.05}'
```

Si la dejas en `0`/sin configurar, se usa la regla normal automáticamente.

## API

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/v1/config` | api-key | Config que consume la app (kill switch, comisiones, coins, erleo). |
| POST | `/api/v1/orders` | api-key | La app envía una orden de intercambio pequeño. |
| GET | `/api/v1/orders/:id` | pública | Estado de una orden (polling de la app). |
| GET | `/api/v1/orders` | sesión | Listado de órdenes. |
| POST | `/api/v1/orders/:id/approve` | sesión | Aprobar (calcula comisión + neto). |
| POST | `/api/v1/orders/:id/reject` | sesión | Rechazar. |
| POST | `/api/v1/orders/:id/complete` | sesión | Confirmar envío manual + registrar comisión. |
| GET/POST/DELETE | `/api/v1/reserves` | sesión | Direcciones de reserva. |
| GET/POST | `/api/v1/small-commissions` | sesión | Comisión especial opcional. |
| GET | `/api/v1/report/commissions` | sesión | Contabilidad separada (filtros por moneda/fechas). |
| GET | `/api/v1/report/export` | sesión | Export CSV de la contabilidad. |
| GET | `/api/v1/report/dashboard` | sesión | Resumen del dashboard (pendientes/aprobadas/recientes). |
| GET/POST | `/api/v1/settings/erleo-enabled` | GET pública, POST sesión | Leer/cambiar el toggle **Activar/Detener** Erleo (persistente). |
| GET | `/api/v1/settings/api-key` | sesión | Clave API de la app (`revealedOnce` indica si ya se mostró). |
| POST | `/api/v1/settings/api-key/reveal` | sesión | Marcar la clave como ya mostrada (no vuelve a aparecer completa). |
| POST | `/api/v1/settings/api-key/regenerate` | sesión | Generar una clave nueva (invalida builds anteriores). |
| POST | `/api/v1/admin/login` | pública | Login del dashboard. |

## Seguridad

- `x-api-key` comparado con `timingSafeEqual` (solo las billeteras la conocen).
- Sesiones del dashboard con token en memoria (12 h).
- Doble validación de monedas antes de aprobar (nunca mueve nada automáticamente).
- **Nunca ejecuta operaciones automáticamente**: siempre requiere tu clic de aprobación.
- Rate limit en el login.
