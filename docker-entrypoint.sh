#!/bin/sh
set -e

# Umbrel bind-mounts ${APP_DATA_DIR}/data. If that host path did not exist,
# Docker creates it as root:root 755. Stay root and make it writable so
# wallets.json can be saved regardless of leftover ownership.
mkdir -p /data /data/zcash
if [ "$(id -u)" = "0" ]; then
  chmod 777 /data /data/zcash 2>/dev/null || true
  if [ -f /data/wallets.json ]; then
    chmod a+rw /data/wallets.json 2>/dev/null || true
  fi
fi

exec node server.js
