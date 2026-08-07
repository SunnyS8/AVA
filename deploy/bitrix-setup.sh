#!/usr/bin/env bash
# Поднимает публичный HTTPS для событий Битрикса. Запускать от root НА СЕРВЕРЕ.
# Идемпотентен: повторный запуск обновляет конфиги и перечитывает nginx.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DOMAIN=83.222.26.241.sslip.io

say() { echo ">> $*"; }
[ "$(id -u)" = "0" ] || { echo "нужен root"; exit 1; }

say "Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -yqq nginx certbot curl >/dev/null

say "Брандмауэр: открываю 80 и 443"
ufw allow 80/tcp  >/dev/null
ufw allow 443/tcp >/dev/null

say "Конфиг nginx (только :80, до сертификата)"
install -d /var/www/acme
install -m 644 "$HERE/nginx-ava.conf" /etc/nginx/sites-available/ava
ln -sf /etc/nginx/sites-available/ava /etc/nginx/sites-enabled/ava
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

say "Сертификат Let's Encrypt"
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  certbot certonly --webroot -w /var/www/acme -d "$DOMAIN" \
    --non-interactive --agree-tos --register-unsafely-without-email
else
  say "сертификат уже есть — не перевыпускаю"
fi

say "Включаю публичный блок :443"
install -m 644 "$HERE/nginx-ava-public.conf" /etc/nginx/sites-available/ava-public
ln -sf /etc/nginx/sites-available/ava-public /etc/nginx/sites-enabled/ava-public
nginx -t
systemctl reload nginx

say "Проверка снаружи"
code=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/bitrix/" -X POST -d 'x=1' || true)
echo "POST https://$DOMAIN/bitrix/ -> HTTP $code (ожидаем 400 или 401: события нет или токен не тот)"
code_root=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/" || true)
echo "GET  https://$DOMAIN/          -> HTTP $code_root (ожидаем 404: панель закрыта)"

say "Готово. Адрес обработчика: https://$DOMAIN/bitrix/"
