#!/usr/bin/env bash
#
# Despliegue del Cerebro server en un VPS (Ubuntu 22.04/24.04, Debian 12).
# Instala Node 22, copia server/ a /opt/miboveda-cerebro, crea el servicio
# systemd y configura Nginx + HTTPS (Let's Encrypt).
#
# Uso en el VPS (como root o con sudo):
#   bash <(curl -sL https://raw.githubusercontent.com/leonard0001991/mi-boveda/main/server/deploy.sh)
#
# Variables de entorno antes de ejecutar:
#   DOMAIN=api.tudominio.com           (obligatorio: tu dominio)
#   EMAIL=tu@email.com                 (para Let's Encrypt)
#   ADMIN_PASSWORD=xxxxxx              (contraseña del dashboard; si no, se genera)
#   CEREBRO_API_KEY=xxxxxx             (opcional; si no, se genera y se muestra)
#
# Ejemplo:
#   DOMAIN=api.miboveda.com EMAIL=admin@miboveda.com bash deploy.sh

set -euo pipefail

DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
CEREBRO_API_KEY="${CEREBRO_API_KEY:-}"

if [ -z "$DOMAIN" ]; then
  echo "ERROR: define DOMAIN (ej. DOMAIN=api.miboveda.com)" >&2
  exit 1
fi

REPO="https://github.com/leonard0001991/mi-boveda.git"
DIR="/opt/miboveda-cerebro"

echo "==> Instalando dependencias del sistema..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git nginx certbot python3-certbot-nginx

echo "==> Instalando Node.js 22 LTS..."
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node -v)"

echo "==> Clonando servidor..."
if [ ! -d "$DIR" ]; then
  git clone --depth 1 "$REPO" "$DIR"
else
  git -C "$DIR" fetch --depth 1 origin main
  git -C "$DIR" reset --hard origin/main
fi

echo "==> Instalando dependencias npm..."
cd "$DIR/server"
npm install --omit=dev

echo "==> Creando .env..."
cd "$DIR/server"
if [ ! -f .env ]; then
  cp .env.example .env
fi
# Si ADMIN_PASSWORD o CEREBRO_API_KEY se pasaron, se escriben. Si no,
# el servidor las genera en el primer arranque y las imprime.
if [ -n "$ADMIN_PASSWORD" ]; then
  sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$ADMIN_PASSWORD/" .env
fi
if [ -n "$CEREBRO_API_KEY" ]; then
  sed -i "s/^CEREBRO_API_KEY=.*/CEREBRO_API_KEY=$CEREBRO_API_KEY/" .env
fi

echo "==> Creando servicio systemd..."
cat > /etc/systemd/system/miboveda-cerebro.service <<EOF
[Unit]
Description=Mi Boveda Cerebro server
After=network.target

[Service]
WorkingDirectory=$DIR/server
ExecStart=/usr/bin/node --env-file-if-exists=.env src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
# Hardening básico
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable miboveda-cerebro
systemctl restart miboveda-cerebro
sleep 2

echo "==> Configurando Nginx..."
cat > /etc/nginx/sites-available/miboveda-cerebro <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        client_max_body_size 1m;
    }
}
EOF
ln -sf /etc/nginx/sites-available/miboveda-cerebro /etc/nginx/sites-enabled/miboveda-cerebro
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> Configurando HTTPS (Let's Encrypt)..."
if [ -n "$EMAIL" ]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || \
    echo "Aviso: certbot falló (revisa que el DNS apunte a esta IP)."
else
  echo "Sin EMAIL: no se generó certificado. Ejecuta luego: certbot --nginx -d $DOMAIN"
fi

echo ""
echo "=============================================================="
echo "Listo:"
echo "  Dashboard (admin): https://$DOMAIN/"
echo "  API:               https://$DOMAIN/api/v1"
echo ""
echo "Para ver las claves generadas en el primer arranque:"
echo "  journalctl -u miboveda-cerebro | grep -i 'API_KEY\\|ADMIN_PASSWORD'"
echo "O en el panel web, pestana Clave API (se muestra una sola vez)."
echo "=============================================================="
