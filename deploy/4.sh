#!/usr/bin/env bash
# Шаг 4: конфиг и брандмауэр
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/lib.sh"; root_only

say "Шаг 4/5: конфиг и брандмауэр"

if [ -f "$STATE/config.yaml" ]; then
  say "конфиг уже есть — не трогаю"
elif [ -f "$SRC/betsy.config.yaml" ]; then
  install -o "$APP_USER" -g "$APP_USER" -m 600 "$SRC/betsy.config.yaml" "$STATE/config.yaml"
  say "конфиг установлен, права 600"
else
  say "ВНИМАНИЕ: конфига нет — Ава поднимется визардом"
fi

if command -v ufw >/dev/null 2>&1; then
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow 22/tcp >/dev/null          # SSH разрешаем ДО включения
  ufw --force enable >/dev/null
  say "ufw включён: наружу только SSH, порт $PORT закрыт"
else
  say "ufw не установлен — порт $PORT закройте вручную"
fi

say "Шаг 4 готов. Дальше:  bash 5.sh"
