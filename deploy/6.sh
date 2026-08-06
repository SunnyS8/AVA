#!/usr/bin/env bash
# Шаг 6 (по желанию): доступ по SSH-ключу
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/lib.sh"; root_only

say "Доступ по SSH-ключу"

[ -f "$HERE/key.pub" ] || die "рядом нет key.pub"

install -d -m 700 /root/.ssh
[ -f /root/.ssh/authorized_keys ] || : > /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

k=$(cat "$HERE/key.pub")
if grep -qF "$k" /root/.ssh/authorized_keys; then
  say "ключ уже добавлен — ничего не меняю"
else
  printf '%s\n' "$k" >> /root/.ssh/authorized_keys
  say "ключ добавлен: $(printf '%s' "$k" | awk '{print $3}')"
fi

say "Парольный вход НЕ отключаю — сделаем это, когда ключ проверим в деле."
say "Готово."
