#!/usr/bin/env bash
#
# Desinstalador Linux del Cerebro "Mi Bóveda".
# Detiene y elimina el servicio systemd y (opcionalmente) la carpeta.
#
# Uso:
#   bash uninstall_linux.sh
#   bash uninstall_linux.sh --purge      # además borra datos y el código

set -euo pipefail

SERVICE_NAME="miboveda-cerebro"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PURGE="${1:-}"

echo "=== Desinstalando Cerebro Mi Bóveda ==="

# Detener y quitar el servicio
if [ "$(id -u)" -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE_NAME.service"
  systemctl daemon-reload
  echo "Servicio de sistema eliminado."
else
  SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$SYSTEMD_DIR/$SERVICE_NAME.service"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Servicio de usuario eliminado."
fi

# Detener procesos restantes del Cerebro
pkill -f "src/index.js" 2>/dev/null || true

if [ "$PURGE" = "--purge" ]; then
  echo "==> Borrando carpeta de datos y código ($SRC_DIR)..."
  rm -rf "$SRC_DIR/data"
  rm -rf "$SRC_DIR"
  echo "Carpeta eliminada por completo."
else
  echo "Carpeta conservada. Para borrarla del todo:"
  echo "  bash $SRC_DIR/uninstall_linux.sh --purge"
fi

echo "=== Desinstalación completada ==="
