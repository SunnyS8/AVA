#!/usr/bin/env bash
# Все шаги подряд — для автоматической установки.
# Человеку в мелком терминале удобнее по одному: bash 1.sh, bash 2.sh, ...
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

for s in 1 2 3 4 5; do
  bash "$HERE/$s.sh"
done
