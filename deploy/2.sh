#!/usr/bin/env bash
# Шаг 2: пользователь и код
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/lib.sh"; root_only

say "Шаг 2/5: пользователь и код"

[ -d "$SRC/dist" ] || die "рядом нет dist/ — распакуйте архив целиком"

id -u "$APP_USER" >/dev/null 2>&1 || \
  useradd --system --create-home --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$STATE"

install -d "$APP_DIR"
rm -rf "$APP_DIR/dist"                 # код заменяем целиком
cp -r "$SRC/dist" "$APP_DIR/dist"
cp "$SRC/package.json" "$SRC/package-lock.json" "$APP_DIR/"

say "пользователь $APP_USER, код в $APP_DIR"
say "Шаг 2 готов. Дальше:  bash 3.sh"
