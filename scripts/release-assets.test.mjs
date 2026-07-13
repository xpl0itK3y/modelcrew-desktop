import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rootDirectory } from "./release-utils.mjs";

const VERSION = "0.0.1";

function write(filePath, contents = "artifact") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function createFixture({ includeMsiSignature = true } = {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "modelcrew-release-assets-"));
  const input = path.join(fixture, "input");

  const windows = path.join(input, "stable-windows-x64");
  write(path.join(windows, "ModelCrew-setup.exe"));
  write(path.join(windows, "ModelCrew-setup.exe.sig"), "nsis-signature");
  write(path.join(windows, "ModelCrew.msi"));
  if (includeMsiSignature) {
    write(path.join(windows, "ModelCrew.msi.sig"), "msi-signature");
  }

  for (const arch of ["aarch64", "x86_64"]) {
    const macos = path.join(input, `stable-macos-${arch}`);
    write(path.join(macos, "ModelCrew.dmg"));
    write(path.join(macos, "ModelCrew.app.tar.gz"));
    write(path.join(macos, "ModelCrew.app.tar.gz.sig"), `${arch}-signature`);
  }

  for (const arch of ["x86_64", "aarch64"]) {
    const linux = path.join(input, `stable-linux-${arch}`);
    write(path.join(linux, "ModelCrew.AppImage"));
    write(path.join(linux, "ModelCrew.AppImage.sig"), `${arch}-signature`);
    write(path.join(linux, "ModelCrew.deb"));
    write(path.join(linux, "ModelCrew.rpm"));
  }

  return fixture;
}

function prepareAssets(fixture) {
  return spawnSync(
    process.execPath,
    [
      path.join(rootDirectory, "scripts/release/prepare-assets.mjs"),
      "--input",
      path.join(fixture, "input"),
      "--output",
      path.join(fixture, "dist"),
      "--manifest",
      path.join(fixture, "assets.json"),
      "--version",
      VERSION,
    ],
    { cwd: rootDirectory, encoding: "utf8" },
  );
}

function generateLatest(fixture) {
  return spawnSync(
    process.execPath,
    [
      path.join(rootDirectory, "scripts/release/generate-latest.mjs"),
      "--dist",
      path.join(fixture, "dist"),
      "--manifest",
      path.join(fixture, "assets.json"),
      "--version",
      VERSION,
      "--repository",
      "xpl0itK3y/modelcrew-desktop",
      "--pub-date",
      "2026-07-13T00:00:00Z",
    ],
    { cwd: rootDirectory, encoding: "utf8" },
  );
}

test("prepare-assets emits matching NSIS and MSI updater targets", () => {
  const fixture = createFixture();
  try {
    const result = prepareAssets(fixture);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(fixture, "assets.json"), "utf8"),
    );

    assert.deepEqual(manifest.platforms["windows-x86_64"], {
      file: `ModelCrew_${VERSION}_windows_x64-setup.exe`,
      signatureFile: `ModelCrew_${VERSION}_windows_x64-setup.exe.sig`,
    });
    assert.deepEqual(
      manifest.platforms["windows-x86_64-nsis"],
      manifest.platforms["windows-x86_64"],
    );
    assert.deepEqual(manifest.platforms["windows-x86_64-msi"], {
      file: `ModelCrew_${VERSION}_windows_x64.msi`,
      signatureFile: `ModelCrew_${VERSION}_windows_x64.msi.sig`,
    });
    assert.equal(
      fs.readFileSync(
        path.join(fixture, "dist", `ModelCrew_${VERSION}_windows_x64.msi.sig`),
        "utf8",
      ),
      "msi-signature",
    );

    const latestResult = generateLatest(fixture);
    assert.equal(latestResult.status, 0, latestResult.stderr);
    const latest = JSON.parse(
      fs.readFileSync(path.join(fixture, "dist", "latest.json"), "utf8"),
    );
    assert.equal(
      latest.platforms["windows-x86_64"].url,
      `https://github.com/xpl0itK3y/modelcrew-desktop/releases/download/v${VERSION}/ModelCrew_${VERSION}_windows_x64-setup.exe`,
    );
    assert.deepEqual(
      latest.platforms["windows-x86_64-nsis"],
      latest.platforms["windows-x86_64"],
    );
    assert.equal(
      latest.platforms["windows-x86_64-msi"].url,
      `https://github.com/xpl0itK3y/modelcrew-desktop/releases/download/v${VERSION}/ModelCrew_${VERSION}_windows_x64.msi`,
    );
    assert.equal(
      latest.modelcrew.releaseUrl,
      `https://github.com/xpl0itK3y/modelcrew-desktop/releases/tag/v${VERSION}`,
    );
    assert.equal(
      latest.platforms["windows-x86_64-msi"].signature,
      "msi-signature",
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("prepare-assets rejects an unsigned MSI", () => {
  const fixture = createFixture({ includeMsiSignature: false });
  try {
    const result = prepareAssets(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing updater signature.*\.msi/u);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
