#!/usr/bin/env bash
# AppImage несёт свой WebKitGTK, а тот проигрывает звук только через GStreamer.
# Библиотеки GStreamer попадают в образ сами — они прописаны в зависимостях
# libwebkit2gtk и копируются вместе с ним. А вот плагины (парсер WAV,
# преобразование, вывод в ALSA/Pulse) лежат отдельным каталогом, и без них
# пайплайн не собирается: звука нет вообще. Кладём их сами и подсказываем
# GStreamer путь через apprun-хук — собранное на Ubuntu ядро иначе ищет плагины
# в /usr/lib/x86_64-linux-gnu/gstreamer-1.0, которого на других дистрибутивах
# не существует.
#
# Общий шаг nightly и релизной сборки: разойтись они не должны, иначе релиз
# выполнит непроверенный код.
set -euo pipefail

bundle="${1:?usage: bundle-gstreamer-appimage.sh <appimage-bundle-dir>}"
appimage="$(find "$bundle" -name '*.AppImage' -print -quit)"
test -n "$appimage" || { echo "No AppImage in $bundle" >&2; exit 1; }
appimage="$(realpath "$appimage")"

multiarch="$(dpkg-architecture -qDEB_HOST_MULTIARCH)"
plugins="/usr/lib/$multiarch/gstreamer-1.0"
test -d "$plugins" || { echo "No GStreamer plugins at $plugins" >&2; exit 1; }
scanner="$(find /usr/lib/"$multiarch" -name gst-plugin-scanner -print -quit)"
test -n "$scanner" || { echo "gst-plugin-scanner not found" >&2; exit 1; }

# Пересобрать образ умеет appimagetool. Старые версии tauri клали его в свой
# кеш; нынешняя собирает AppImage через linuxdeploy, и отдельного appimagetool
# в кеше уже нет — тогда достаём его из плагина linuxdeploy, который tauri
# скачал сам, а в последнюю очередь берём официальную сборку.
tool=""
if [ -d "$HOME/.cache/tauri" ]; then
  tool="$(find "$HOME/.cache/tauri" -name 'appimagetool*' -type f -print -quit)"
  if [ -z "$tool" ]; then
    plugin="$(find "$HOME/.cache/tauri" -name 'linuxdeploy-plugin-appimage*' -type f -print -quit)"
    if [ -n "$plugin" ]; then
      chmod +x "$plugin"
      toolwork="$(mktemp -d)"
      (cd "$toolwork" && "$plugin" --appimage-extract >/dev/null)
      tool="$(find "$toolwork/squashfs-root" -name 'appimagetool*' -type f -print -quit)"
    fi
  fi
fi
# Найденный бинарь мог остаться от другой версии или зависеть от окружения
# своего AppDir — проверяем, что он вообще запускается.
if [ -n "$tool" ]; then
  chmod +x "$tool"
  if ! APPIMAGE_EXTRACT_AND_RUN=1 "$tool" --version >/dev/null 2>&1 &&
    ! APPIMAGE_EXTRACT_AND_RUN=1 "$tool" --help >/dev/null 2>&1; then
    echo "Cached appimagetool at $tool does not run, falling back"
    tool=""
  fi
fi
if [ -z "$tool" ]; then
  echo "appimagetool is not usable from the tauri cache, downloading the official build"
  test -d "$HOME/.cache/tauri" && find "$HOME/.cache/tauri" -maxdepth 2 || true
  tool="$(mktemp -d)/appimagetool"
  curl --fail --silent --show-error --location --retry 5 --retry-delay 3 \
    --output "$tool" \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-$(uname -m).AppImage"
fi
chmod +x "$tool"
echo "Using appimagetool: $tool"

work="$(mktemp -d)"
(cd "$work" && "$appimage" --appimage-extract >/dev/null)
root="$work/squashfs-root"
install -d "$root/usr/lib/gstreamer-1.0"
cp -a "$plugins"/*.so "$root/usr/lib/gstreamer-1.0/"
cp -a "$scanner" "$root/usr/lib/gstreamer-1.0/"
# AppRun выполняет каждый файл из apprun-hooks перед запуском.
install -d "$root/apprun-hooks"
cat > "$root/apprun-hooks/gstreamer.sh" <<'HOOK'
export GST_PLUGIN_SYSTEM_PATH_1_0="$APPDIR/usr/lib/gstreamer-1.0"
export GST_PLUGIN_SCANNER="$APPDIR/usr/lib/gstreamer-1.0/gst-plugin-scanner"
# Свой файл реестра: общий с системным GStreamer описывал бы совсем другой
# набор плагинов, и наши считались бы неизвестными.
mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}/modelcrew"
export GST_REGISTRY_1_0="${XDG_CACHE_HOME:-$HOME/.cache}/modelcrew/gstreamer-registry.bin"
HOOK
# appimagetool сам является AppImage; extract-and-run избавляет от FUSE.
APPIMAGE_EXTRACT_AND_RUN=1 ARCH="$(uname -m)" "$tool" --no-appstream "$root" "$appimage"
chmod +x "$appimage"

# Патч меняет байты образа, поэтому прежняя подпись к нему уже не относится:
# пересоздаём её тем же ключом.
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  npm run --silent tauri -- signer sign \
    --private-key "$TAURI_SIGNING_PRIVATE_KEY" \
    --password "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
    "$appimage" > /dev/null
fi
