#!/usr/bin/env bash
# Проверка собранного AppImage. Ловим регрессы здесь, а не в отзывах: образ
# обещает работать на любом дистрибутиве, и всё, что он подхватывает из
# системы, — это риск, который должен быть виден на сборке.
set -euo pipefail

bundle="${1:?usage: check-appimage.sh <appimage-bundle-dir>}"
appimage="$(find "$bundle" -name '*.AppImage' -print -quit)"
test -n "$appimage" || { echo "No AppImage in $bundle" >&2; exit 1; }
work="$(mktemp -d)"
cp "$appimage" "$work/app.AppImage"
chmod +x "$work/app.AppImage"
# --appimage-extract разворачивает образ без FUSE.
(cd "$work" && ./app.AppImage --appimage-extract >/dev/null)
root="$work/squashfs-root"
core="$(find "$root" -name 'libgstreamer-1.0.so*' -print -quit || true)"
plugins="$(find "$root" -type d -name 'gstreamer-1.0' -print -quit || true)"
if [ -n "$core" ] && [ -z "$plugins" ]; then
  echo "AppImage ships GStreamer libraries without any plugins:" >&2
  echo "  core:    $core" >&2
  echo "  plugins: (none)" >&2
  echo "Notification sounds would be silent on every machine." >&2
  exit 1
fi
if [ -n "$plugins" ]; then
  echo "GStreamer plugins bundled: $(find "$plugins" -name '*.so' | wc -l)"
else
  echo "No bundled GStreamer: the system one will be used."
fi

# AppImage несёт свои библиотеки, но не свою libc: она всегда системная. Самый
# новый затребованный символ и есть нижняя граница дистрибутивов, на которых
# образ вообще запустится. Печатаем её, чтобы граница была фактом сборки, а не
# догадкой при разборе жалоб.
# Рядом с бинарём приложения в usr/bin лежат вспомогательные скрипты вроде
# xdg-open. Берём первый ELF, а не первый исполняемый файл: иначе проверка
# зависит от порядка обхода каталога и objdump падает на shell-скрипте.
binary=""
while IFS= read -r candidate; do
  if [ "$(od -An -tx1 -N4 "$candidate" | tr -d ' \n')" = "7f454c46" ]; then
    binary="$candidate"
    break
  fi
done < <(find "$root/usr/bin" -type f -perm -u+x | sort)
if [ -n "$binary" ]; then
  floor="$(objdump -T "$binary" \
    | grep -oE 'GLIBC_[0-9]+\.[0-9]+' \
    | sort -u -t_ -k2 -V \
    | tail -1)"
  echo "Minimum glibc required: ${floor:-unknown}"
fi

# Модули GIO и GTK обязаны ехать свои. Подхваченные из системы собраны под её
# версию glib, и именно на них образ ломается на «неправильном» дистрибутиве:
# libgiognutls отвечает за TLS, без него отваливается вся сеть внутри окна.
for modules in gio/modules gtk-3.0; do
  if ! find "$root" -type d -path "*/$modules" -print -quit | grep -q .; then
    echo "AppImage bundles no $modules — the host ones would be loaded" >&2
    exit 1
  fi
done
echo "GIO and GTK modules are bundled"
