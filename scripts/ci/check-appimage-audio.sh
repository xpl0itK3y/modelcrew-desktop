#!/usr/bin/env bash
# Ловим регресс здесь, а не в отзывах пользователей: образ с библиотеками
# GStreamer, но без плагинов, молчит на любой машине.
set -euo pipefail

bundle="${1:?usage: check-appimage-audio.sh <appimage-bundle-dir>}"
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
