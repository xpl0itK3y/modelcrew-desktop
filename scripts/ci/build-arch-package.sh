#!/usr/bin/env bash
# Собирает пакет для pacman прямо на Arch: бинарь линкуется ровно с теми
# библиотеками, с которыми потом будет работать. Переупаковка ubuntu-овского
# .deb этого не даёт — Arch обновляет WebKitGTK заметно раньше, и расхождение
# проявляется чёрным окном, а не понятной ошибкой.
set -euo pipefail

arch="${1:?usage: build-arch-package.sh <x86_64|aarch64>}"

# Только через CLI tauri: голый `cargo build` не включает фичу
# `custom-protocol`, приложение остаётся в dev-режиме и грузит
# http://localhost:1420 вместо вшитого фронтенда. `--no-bundle` останавливает
# CLI после бинаря — пакет для pacman собираем сами.
npm run tauri build -- --ci --no-bundle

pkgver="$(node -p "require('./package.json').version")"
test -n "$pkgver"

stage="$(mktemp -d)"
install -Dm755 src-tauri/target/release/modelcrew-desktop \
  "$stage/usr/bin/modelcrew-desktop"
install -Dm644 src-tauri/icons/32x32.png \
  "$stage/usr/share/icons/hicolor/32x32/apps/modelcrew-desktop.png"
install -Dm644 src-tauri/icons/128x128.png \
  "$stage/usr/share/icons/hicolor/128x128/apps/modelcrew-desktop.png"
install -Dm644 'src-tauri/icons/128x128@2x.png' \
  "$stage/usr/share/icons/hicolor/256x256/apps/modelcrew-desktop.png"
install -d "$stage/usr/share/applications"
cat > "$stage/usr/share/applications/ModelCrew.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=ModelCrew
Comment=Desktop workspace for projects, sessions, and multiple terminals
Exec=modelcrew-desktop
Icon=modelcrew-desktop
Terminal=false
Categories=Development;
StartupWMClass=ModelCrew
DESKTOP

# makepkg отказывается работать от root, поэтому упаковываем под обычным
# пользователем. Компиляция уже позади: package() только раскладывает дерево.
useradd -m builder
work=/home/builder/work
install -d -o builder -g builder "$work"
tar -C "$stage" -czf "$work/modelcrew-files.tar.gz" .
cat > "$work/PKGBUILD" <<PKGBUILD
pkgname=modelcrew-bin
pkgver=$pkgver
pkgrel=1
pkgdesc='Desktop workspace for projects, sessions, and multiple terminals'
arch=('$arch')
url='https://github.com/xpl0itK3y/modelcrew-desktop'
license=('MIT')
depends=('cairo' 'desktop-file-utils' 'gdk-pixbuf2' 'git' 'glib2' 'gst-plugins-base' 'gst-plugins-good' 'gtk3' 'hicolor-icon-theme' 'libayatana-appindicator' 'libsoup3' 'openssl' 'pango' 'polkit' 'webkit2gtk-4.1' 'xdg-utils')
provides=('modelcrew')
conflicts=('modelcrew')
options=('!strip')
source=('modelcrew-files.tar.gz')
sha256sums=('SKIP')
package() {
cp -a "\$srcdir/usr" "\$pkgdir/"
}
PKGBUILD
chown builder:builder "$work/PKGBUILD" "$work/modelcrew-files.tar.gz"
su builder -c "cd '$work' && makepkg -f --nodeps --clean"
mkdir -p arch-out
cp "$work"/*.pkg.tar.zst arch-out/

# Пакет обязан не только собираться, но и разрешать все библиотеки на самом
# Arch — ровно это и ломалось у переупакованного .deb.
package_file="$(find arch-out -name '*.pkg.tar.zst' -print -quit)"
test -n "$package_file" || { echo "No package built" >&2; exit 1; }
pacman -U --noconfirm "$package_file"
test -x /usr/bin/modelcrew-desktop
missing="$(ldd /usr/bin/modelcrew-desktop | grep 'not found' || true)"
if [ -n "$missing" ]; then
  echo "Unresolved libraries on Arch:" >&2
  echo "$missing" >&2
  exit 1
fi
ldd /usr/bin/modelcrew-desktop | grep -E 'webkit2gtk|libsoup'
