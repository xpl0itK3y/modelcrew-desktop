import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tauriConfig = JSON.parse(
  fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const archPackageScript = fs.readFileSync(
  path.join(root, "scripts", "ci", "build-arch-package.sh"),
  "utf8",
);

function bytes(relativePath, length) {
  const file = fs.readFileSync(path.join(root, relativePath));
  assert.ok(file.length >= length, `${relativePath} is unexpectedly short`);
  return file.subarray(0, length);
}

test("the Arch desktop entry matches the Linux executable identity", () => {
  // GTK/Wayland falls back to the executable name when enableGTKAppId is off.
  // KDE uses that identity (or StartupWMClass on X11) to find the desktop
  // entry and its icon in the overview/task switcher.
  assert.notEqual(tauriConfig.app.enableGTKAppId, true);
  assert.match(archPackageScript, /Exec=modelcrew-desktop/u);
  assert.match(archPackageScript, /Icon=modelcrew-desktop/u);
  assert.match(archPackageScript, /StartupWMClass=modelcrew-desktop/u);
  assert.doesNotMatch(archPackageScript, /StartupWMClass=ModelCrew/u);
});

test("Tauri bundles the native icon format for every desktop platform", () => {
  const configuredIcons = new Set(tauriConfig.bundle.icon);
  for (const icon of [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.ico",
    "icons/icon.icns",
  ]) {
    assert.ok(configuredIcons.has(icon), `${icon} is missing from bundle.icon`);
  }

  for (const icon of [
    "src-tauri/icons/32x32.png",
    "src-tauri/icons/128x128.png",
    "src-tauri/icons/128x128@2x.png",
  ]) {
    assert.deepEqual(
      bytes(icon, 8),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      `${icon} is not a PNG`,
    );
  }

  assert.deepEqual(
    bytes("src-tauri/icons/icon.ico", 4),
    Buffer.from([0x00, 0x00, 0x01, 0x00]),
    "Windows icon.ico has an invalid header",
  );
  assert.equal(
    bytes("src-tauri/icons/icon.icns", 4).toString("ascii"),
    "icns",
    "macOS icon.icns has an invalid header",
  );
});
