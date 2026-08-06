#!/usr/bin/env bash
# Шаг 1: Node.js
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/lib.sh"; root_only

say "Шаг 1/5: Node.js (1-2 мин)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -yqq curl ca-certificates gnupg >/dev/null

cur=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)
if [ "${cur:-0}" -lt 20 ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -yqq nodejs >/dev/null
fi

say "node $(node -v), npm $(npm -v)"
say "Шаг 1 готов. Дальше:  bash 2.sh"
