#!/usr/bin/env bash
# Разворачивает Аву на Ubuntu 24.04. Запускать от root НА СЕРВЕРЕ, из
# распакованной папки пакета:
#
#   tar -xzf ava-deploy.tar.gz && cd ava-deploy && bash install.sh
#
# Пакет самодостаточен: код уже собран, к GitHub скрипт не обращается.
# Из сети нужны только apt (Node.js) и npm-реестр (зависимости).
#
# Скрипт идемпотентен: повторный запуск обновляет код и перезапускает сервис,
# НЕ трогая уже существующие конфиг и базу.
#
#   bash install.sh                  # код + сервис
#   bash install.sh --with-browser   # ещё и Chromium для браузерного инструмента

set -euo pipefail

APP_DIR=/opt/ava
APP_USER=ava
APP_HOME=/home/ava
STATE_DIR="$APP_HOME/.betsy"
NODE_MAJOR=22
PORT=3777

WITH_BROWSER=0
[ "${1:-}" = "--with-browser" ] && WITH_BROWSER=1

log()  { echo "==> $*"; }
fail() { echo "ОШИБКА: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fail "нужен root (запустите от root или через sudo)"

# Где лежит полезная нагрузка: рядом со скриптом или на уровень выше
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -d "$HERE/dist" ]; then ROOT="$HERE"
elif [ -d "$HERE/../dist" ]; then ROOT="$(cd "$HERE/.." && pwd)"
else fail "рядом со скриптом нет каталога dist/ — распакуйте архив целиком"; fi
SERVICE_FILE="$HERE/ava.service"
[ -f "$SERVICE_FILE" ] || SERVICE_FILE="$ROOT/deploy/ava.service"
[ -f "$SERVICE_FILE" ] || fail "не найден ava.service"

log "Полезная нагрузка: $ROOT"

log "Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -yqq curl ca-certificates gnupg tar >/dev/null

log "Node.js"
current=$(node --version 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)
if [ "${current:-0}" -lt 20 ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -yqq nodejs >/dev/null
fi
log "node $(node --version), npm $(npm --version)"

log "Пользователь $APP_USER"
id -u "$APP_USER" >/dev/null 2>&1 || \
  useradd --system --create-home --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$STATE_DIR"

log "Код в $APP_DIR"
install -d "$APP_DIR"
rm -rf "$APP_DIR/dist"                       # код заменяем целиком
cp -r "$ROOT/dist" "$APP_DIR/dist"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$APP_DIR/"

log "Зависимости (production) — может занять пару минут"
cd "$APP_DIR"
if ! npm ci --omit=dev --no-audit --no-fund; then
  log "Сборка нативных модулей — доставляю инструменты и повторяю"
  apt-get install -yqq build-essential python3 >/dev/null
  npm ci --omit=dev --no-audit --no-fund
fi

if [ "$WITH_BROWSER" = "1" ]; then
  log "Chromium для браузерного инструмента"
  PLAYWRIGHT_BROWSERS_PATH="$APP_DIR/.playwright" npx --yes playwright install --with-deps chromium
fi

log "Конфиг"
if [ -f "$STATE_DIR/config.yaml" ]; then
  log "config.yaml уже есть — не трогаю"
elif [ -f "$ROOT/betsy.config.yaml" ]; then
  install -o "$APP_USER" -g "$APP_USER" -m 600 "$ROOT/betsy.config.yaml" "$STATE_DIR/config.yaml"
  log "config.yaml установлен, права 600"
else
  log "ВНИМАНИЕ: конфига нет — Ава поднимется в режиме визарда"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$APP_HOME"

log "Брандмауэр: наружу только SSH"
if command -v ufw >/dev/null 2>&1; then
  # --force осмыслен только для enable/reset; для default его не передаём
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  # Разрешаем SSH ДО включения — иначе можно потерять доступ к серверу
  ufw allow 22/tcp >/dev/null
  ufw --force enable >/dev/null
  log "ufw: $(ufw status | sed -n '1p')"
else
  log "ufw нет — порт $PORT может быть виден снаружи, закройте вручную"
fi

log "Служба systemd"
install -m 644 "$SERVICE_FILE" /etc/systemd/system/ava.service
systemctl daemon-reload
systemctl enable ava >/dev/null 2>&1 || true
systemctl restart ava

log "Проверка"
sleep 6
state=$(systemctl is-active ava || true)
echo "systemctl is-active ava -> $state"
if [ "$state" != "active" ]; then
  echo "--- последние строки журнала ---"
  journalctl -u ava --no-pager --lines=40 || true
  fail "служба не поднялась"
fi

if curl -fsS --max-time 10 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  echo "панель отвечает на 127.0.0.1:$PORT"
else
  echo "ВНИМАНИЕ: панель на 127.0.0.1:$PORT не ответила — смотрите журнал ниже"
  journalctl -u ava --no-pager --lines=30 || true
fi

echo
echo "=== ГОТОВО ==="
echo "Служба:   systemctl status ava"
echo "Журнал:   journalctl -u ava -f"
echo "Обновить: распаковать новый пакет и снова запустить install.sh"
echo "Панель наружу закрыта. Открыть у себя туннелем:"
echo "  ssh -L $PORT:127.0.0.1:$PORT root@<IP-сервера>   → http://localhost:$PORT"
