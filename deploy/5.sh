#!/usr/bin/env bash
# Шаг 5: запуск службы
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/lib.sh"; root_only

say "Шаг 5/5: запуск"

[ -d "$APP_DIR/node_modules" ] || die "сначала выполните: bash 3.sh"
[ -f "$HERE/ava.service" ] || die "рядом нет ava.service"

install -m 644 "$HERE/ava.service" /etc/systemd/system/ava.service
systemctl daemon-reload
systemctl enable ava >/dev/null 2>&1 || true
systemctl restart ava

sleep 6
st=$(systemctl is-active ava || true)
say "служба: $st"

if [ "$st" != "active" ]; then
  echo "--- журнал ---"
  journalctl -u ava --no-pager -n 20 || true
  die "служба не поднялась"
fi

if curl -fsS --max-time 10 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  say "панель отвечает на 127.0.0.1:$PORT"
else
  say "панель молчит — смотрите: journalctl -u ava -n 30"
fi

say ""
say "ГОТОВО. Ава запущена, напишите ей в Telegram."
say "Удалите пакет с ключами:  rm -rf /root/ava /root/ava.tgz"
