#!/usr/bin/env bash
#
# Instalador Linux del Cerebro "Mi Bóveda".
# Instala Node 22 si falta, instala dependencias, crea la base de datos,
# configura el servicio systemd (arranque estable) y muestra cómo acceder.
#
# Uso:
#   bash install_linux.sh
#
# Variables opcionales:
#   PORT=8787             puerto del servidor web
#   ADMIN_PASSWORD=xxx    contraseña del panel (si no, se genera)
#   CEREBRO_API_KEY=xxx   clave de la API (si no, se genera)
#   INSTALL_DIR=/home/$USER/miboveda-cerebro   dónde copiar (por defecto: aquí)

set -euo pipefail

PORT="${PORT:-8787}"
ADMIN_PASSWORD="${MIBOVEDA_ADMIN_PASSWORD:-}"
CEREBRO_API_KEY="${MIBOVEDA_CEREBRO_API_KEY:-}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$SRC_DIR}"
SERVICE_NAME="miboveda-cerebro"

echo "=== Cerebro Mi Bóveda — Instalador Linux ==="
echo "Directorio del código: $SRC_DIR"
echo "Directorio de instalación: $INSTALL_DIR"
echo "Puerto: $PORT"

# 1) Node >= 22
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  echo "==> Node 22 no encontrado. Instalándolo..."
  export DEBIAN_FRONTEND=noninteractive
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node -v)"

# 2) dependencias npm
echo "==> Instalando dependencias npm..."
cd "$INSTALL_DIR"
if [ ! -f package.json ]; then
  echo "ERROR: no hay package.json en $INSTALL_DIR (¿estás en la carpeta del Cerebro?)." >&2
  exit 1
fi
npm install --omit=dev

# 3) .env (conservar si existe, rellenar credenciales si se pasaron)
echo "==> Preparando .env..."
cd "$INSTALL_DIR"
if [ ! -f .env ]; then
  cp .env.example .env 2>/dev/null || touch .env
fi
# Quitar CR / espacios de respaldo que rompan Node en Windows.
sed -i 's/\r$//' .env 2>/dev/null || true
if ! grep -q '^PORT=' .env; then echo "PORT=$PORT" >> .env; fi

# 4) servicio systemd (si hay systemd)
if command -v systemctl >/dev/null 2>&1; then
  echo "==> Creando servicio systemd $SERVICE_NAME..."
  SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  if [ "$(id -u)" -ne 0 ]; then
    mkdir -p "$SYSTEMD_DIR"
    UNIT="$SYSTEMD_DIR/$SERVICE_NAME.service"
    NODE_BIN="$(command -v node)"
    cat > "$UNIT" <<EOF
[Unit]
Description=Mi Boveda Cerebro server
After=network.target

[Service]
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN --env-file-if-exists=.env src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable "$SERVICE_NAME"
    systemctl --user restart "$SERVICE_NAME"
    echo "Servicio de usuario instalado. Estado:"
    systemctl --user status "$SERVICE_NAME" --no-pager || true
  else
    UNIT="/etc/systemd/system/$SERVICE_NAME.service"
    NODE_BIN="$(command -v node)"
    cat > "$UNIT" <<EOF
[Unit]
Description=Mi Boveda Cerebro server
After=network.target

[Service]
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN --env-file-if-exists=.env src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME"
    systemctl restart "$SERVICE_NAME"
    echo "Servicio instalado. Estado:"
    systemctl status "$SERVICE_NAME" --no-pager || true
  fi
else
  echo "==> Sin systemd: arrancando el servidor en segundo plano..."
  nohup node src/index.js > "${INSTALL_DIR}/cerebro.log" 2>&1 &
  echo "Servidor arrancado (PID $!). Log: ${INSTALL_DIR}/cerebro.log"
fi

sleep 3

echo ""
echo "=============================================================="
echo "Cerebro Mi Bóveda instalado."
echo "  Panel (admin):  http://localhost:$PORT/"
echo "  API:            http://localhost:$PORT/api/v1"
echo ""
echo "Credenciales: si no se pasaron, el primer arranque las genera"
echo "y las muestra en el log (pestaña Clave API del panel)."
if [ -f "${INSTALL_DIR}/cerebro.log" ]; then
  echo "Revisa:"
  echo "  grep -iE 'api_key|admin_password' ${INSTALL_DIR}/cerebro.log"
fi
echo "Para desinstalar: bash ${INSTALL_DIR}/uninstall_linux.sh"
echo "=============================================================="
