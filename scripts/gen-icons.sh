#!/usr/bin/env bash
#
# Generate platform-specific application icons from a single master logo.
#
# macOS (.icns) keeps transparent padding: the system renders app icons inside
# its own rounded-square grid and adds the drop shadow, so the artwork must sit
# at ~84% of the canvas to look the same size as native apps in the Dock.
#
# Windows (.ico) and Linux (.png) are full-bleed: those platforms add no padding
# of their own, so the artwork fills ~96% of the canvas or it looks too small.
#
# tauri icon generates every file from one source, so we run it twice (once per
# fill) and keep the macOS .icns from the padded pass and everything else from
# the full-bleed pass.
#
# Usage:  scripts/gen-icons.sh [master-logo.png]
#         MAC_FILL=0.84 FULL_FILL=0.96 scripts/gen-icons.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MASTER="${1:-$ROOT/src-tauri/app-icon.png}"
ICONS="$ROOT/src-tauri/icons"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

MAC_FILL="${MAC_FILL:-0.84}"    # macOS: padded for the system icon grid
FULL_FILL="${FULL_FILL:-0.96}"  # Windows/Linux: full-bleed

# render <fill> <out.png> — trim the master to its artwork, then center it on a
# 1024 transparent canvas at the requested fill fraction (LANCZOS resampling).
render() {
  python3 - "$MASTER" "$1" "$2" <<'PY'
import sys
from PIL import Image

master, fill, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
src = Image.open(master).convert("RGBA")
content = src.crop(src.split()[3].getbbox())  # drop the master's own padding
cw, ch = content.size
CANVAS = 1024
scale = (CANVAS * fill) / max(cw, ch)
nw, nh = round(cw * scale), round(ch * scale)
content = content.resize((nw, nh), Image.LANCZOS)
canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
canvas.paste(content, ((CANVAS - nw) // 2, (CANVAS - nh) // 2), content)
canvas.save(out)
PY
}

echo "Master logo: $MASTER"
render "$MAC_FILL"  "$TMP/mac.png"
render "$FULL_FILL" "$TMP/full.png"

# Pass 1: macOS-padded set — keep only its .icns.
npx tauri icon "$TMP/mac.png" >/dev/null
cp "$ICONS/icon.icns" "$TMP/icon-mac.icns"

# Pass 2: full-bleed set for Windows (.ico), Linux (.png) and Store tiles.
npx tauri icon "$TMP/full.png" >/dev/null

# Restore the macOS-padded .icns over the full-bleed one.
cp "$TMP/icon-mac.icns" "$ICONS/icon.icns"

# This desktop app ships no mobile targets — tauri icon emits them anyway.
rm -rf "$ICONS/android" "$ICONS/ios" "$ICONS/64x64.png"

echo "Done: icon.icns @ ${MAC_FILL} (macOS), icon.ico + PNGs @ ${FULL_FILL} (Windows/Linux)"
