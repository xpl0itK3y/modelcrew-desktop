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

# Без этих элементов WebKit не соберёт конвейер для звука уведомлений: разбор
# WAV, преобразование частоты и хоть какой-то вывод на звуковую карту.
for element in libgstwavparse libgstaudioconvert libgstaudioresample; do
  test -f "$plugins/$element.so" || {
    echo "AppImage has no $element — notification sounds would be silent" >&2
    exit 1
  }
done
if ! find "$plugins" \( -name 'libgstalsa.so' -o -name 'libgstpulse*.so' \) -print | grep -q .; then
  echo "AppImage has no audio sink (alsa or pulse) — nothing would be heard" >&2
  exit 1
fi

# Библиотеки в образе лежат и плоско в usr/lib, и в multiarch-подкаталоге:
# искать зависимости надо во всех, иначе годный плагин будет ошибочно признан
# сломанным и удалён.
libpath="$(find "$root/usr/lib" -maxdepth 1 -type d | tr '\n' ':')"
# Плагин без своих зависимостей грузиться не станет и в бою даст
# «undefined symbol»: ловим это здесь.
for plugin in "$plugins"/*.so; do
  missing="$(LD_LIBRARY_PATH="$libpath" ldd "$plugin" 2>/dev/null | grep 'not found' || true)"
  if [ -n "$missing" ]; then
    echo "Bundled plugin $(basename "$plugin") is missing its libraries:" >&2
    echo "$missing" >&2
    exit 1
  fi
done
echo "Every bundled plugin resolves its libraries"

# Драйверы графики обязаны быть системными. Собранные на Ubuntu Mesa и libEGL
# не договариваются с драйвером другого дистрибутива, и приложение падает с
# EGL_BAD_PARAMETER ещё до появления окна.
graphics="$(find "$root" -type f \( \
  -name 'libEGL*' -o -name 'libGL.so*' -o -name 'libGLX*' \
  -o -name 'libGLdispatch*' -o -name 'libgbm*' -o -name 'libdrm*' \
  -o -name 'libgallium*' -o -name 'libglapi*' \) -print)"
if [ -n "$graphics" ]; then
  echo "AppImage bundles graphics libraries that must come from the host:" >&2
  echo "$graphics" >&2
  exit 1
fi
echo "Graphics stack is left to the host"

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
