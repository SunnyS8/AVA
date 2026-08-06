# Общее для шагов установки Авы. Подключается каждым шагом, отдельно не запускается.

APP_DIR=/opt/ava
APP_USER=ava
APP_HOME=/home/ava
STATE="$APP_HOME/.betsy"
PORT=3777
NODE_MAJOR=22

# Где лежит полезная нагрузка (dist/, package.json, конфиг):
# в пакете — рядом со скриптами, в репозитории — на уровень выше.
if [ -d "$HERE/dist" ]; then SRC="$HERE"
elif [ -d "$HERE/../dist" ]; then SRC="$(cd "$HERE/.." && pwd)"
else SRC="$HERE"; fi

say() { echo ">> $*"; }
die() { echo "ОШИБКА: $*" >&2; exit 1; }
root_only() { [ "$(id -u)" = "0" ] || die "нужен root"; }
