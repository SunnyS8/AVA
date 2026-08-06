#!/usr/bin/env bash
# Шаг 3: зависимости
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/lib.sh"; root_only

say "Шаг 3/5: зависимости (2-4 мин, вывод в /tmp/ava-npm.log)"

[ -f "$APP_DIR/package.json" ] || die "сначала выполните: bash 2.sh"
cd "$APP_DIR"

if ! npm ci --omit=dev --no-audit --no-fund >/tmp/ava-npm.log 2>&1; then
  say "нужны инструменты сборки, доставляю"
  apt-get install -yqq build-essential python3 >/dev/null
  npm ci --omit=dev --no-audit --no-fund >/tmp/ava-npm.log 2>&1 || {
    tail -20 /tmp/ava-npm.log
    die "npm ci не прошёл (полный журнал: /tmp/ava-npm.log)"
  }
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
say "установлено пакетов: $(ls "$APP_DIR/node_modules" | wc -l)"
say "Шаг 3 готов. Дальше:  bash 4.sh"
