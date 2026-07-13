import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rootDirectory } from "./release-utils.mjs";

const VERSION = "0.0.1";
const REPOSITORY = "xpl0itK3y/modelcrew-desktop";
const LINUX_ARCHES = ["x86_64", "aarch64"];
const NATIVE_LINUX_TARGETS = [
  ["deb", "deb"],
  ["rpm", "rpm"],
  ["pacman", "pkg.tar.zst"],
];

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

  for (const arch of LINUX_ARCHES) {
    const linux = path.join(input, `stable-linux-${arch}`);
    write(path.join(linux, "ModelCrew.AppImage"));
    write(path.join(linux, "ModelCrew.AppImage.sig"), `${arch}-signature`);
    write(path.join(linux, "ModelCrew.deb"));
    write(path.join(linux, "ModelCrew.rpm"));
  }

  for (const arch of LINUX_ARCHES) {
    const archLinux = path.join(input, `stable-arch-${arch}`);
    write(path.join(archLinux, "modelcrew-bin.pkg.tar.zst"));
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

function addNativeLinuxSignatures(fixture, { omitTarget } = {}) {
  for (const arch of LINUX_ARCHES) {
    for (const [target, extension] of NATIVE_LINUX_TARGETS) {
      const platform = `linux-${arch}-${target}`;
      if (platform === omitTarget) continue;
      const filename = `ModelCrew_${VERSION}_linux_${arch}.${extension}`;
      write(
        path.join(fixture, "dist", `${filename}.sig`),
        `${arch}-${target}-signature`,
      );
    }
  }
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
      REPOSITORY,
      "--pub-date",
      "2026-07-13T00:00:00Z",
    ],
    { cwd: rootDirectory, encoding: "utf8" },
  );
}

function prepareAur(fixture) {
  return spawnSync(
    process.execPath,
    [
      path.join(rootDirectory, "scripts/release/prepare-aur.mjs"),
      "--dist",
      path.join(fixture, "dist"),
      "--version",
      VERSION,
      "--repository",
      REPOSITORY,
    ],
    { cwd: rootDirectory, encoding: "utf8" },
  );
}

function writeChecksums(fixture) {
  return spawnSync(
    process.execPath,
    [
      path.join(rootDirectory, "scripts/release/checksums.mjs"),
      "--dist",
      path.join(fixture, "dist"),
    ],
    { cwd: rootDirectory, encoding: "utf8" },
  );
}

function verifyRelease(fixture) {
  return spawnSync(
    process.execPath,
    [
      path.join(rootDirectory, "scripts/release/verify-release.mjs"),
      "--dist",
      path.join(fixture, "dist"),
      "--version",
      VERSION,
      "--repository",
      REPOSITORY,
    ],
    { cwd: rootDirectory, encoding: "utf8" },
  );
}

test("release metadata includes signed desktop and native Linux updater targets", () => {
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

    for (const arch of LINUX_ARCHES) {
      const appImage = {
        file: `ModelCrew_${VERSION}_linux_${arch}.AppImage`,
        signatureFile: `ModelCrew_${VERSION}_linux_${arch}.AppImage.sig`,
      };
      assert.deepEqual(manifest.platforms[`linux-${arch}`], appImage);
      assert.deepEqual(manifest.platforms[`linux-${arch}-appimage`], appImage);
      for (const [target, extension] of NATIVE_LINUX_TARGETS) {
        const filename = `ModelCrew_${VERSION}_linux_${arch}.${extension}`;
        assert.deepEqual(manifest.platforms[`linux-${arch}-${target}`], {
          file: filename,
          signatureFile: `${filename}.sig`,
        });
        assert.equal(
          fs.existsSync(path.join(fixture, "dist", `${filename}.sig`)),
          false,
          `${filename} must be signed after its release filename is normalized`,
        );
      }
    }

    addNativeLinuxSignatures(fixture);

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
    for (const arch of LINUX_ARCHES) {
      assert.deepEqual(
        latest.platforms[`linux-${arch}-appimage`],
        latest.platforms[`linux-${arch}`],
      );
      for (const [target, extension] of NATIVE_LINUX_TARGETS) {
        const filename = `ModelCrew_${VERSION}_linux_${arch}.${extension}`;
        assert.deepEqual(latest.platforms[`linux-${arch}-${target}`], {
          signature: `${arch}-${target}-signature`,
          url: `https://github.com/${REPOSITORY}/releases/download/v${VERSION}/${filename}`,
        });
      }
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("generate-latest rejects a native Linux target without its normalized signature", () => {
  const fixture = createFixture();
  try {
    const prepareResult = prepareAssets(fixture);
    assert.equal(prepareResult.status, 0, prepareResult.stderr);
    addNativeLinuxSignatures(fixture, { omitTarget: "linux-x86_64-deb" });

    const result = generateLatest(fixture);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(`ModelCrew_${VERSION.replaceAll(".", "\\.")}_linux_x86_64\\.deb\\.sig`, "u"),
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("verify-release requires native signatures and validates native target URLs", () => {
  const fixture = createFixture();
  try {
    const prepareResult = prepareAssets(fixture);
    assert.equal(prepareResult.status, 0, prepareResult.stderr);
    addNativeLinuxSignatures(fixture);
    const aurResult = prepareAur(fixture);
    assert.equal(aurResult.status, 0, aurResult.stderr);
    const latestResult = generateLatest(fixture);
    assert.equal(latestResult.status, 0, latestResult.stderr);
    const checksumsResult = writeChecksums(fixture);
    assert.equal(checksumsResult.status, 0, checksumsResult.stderr);
    const validResult = verifyRelease(fixture);
    assert.equal(validResult.status, 0, validResult.stderr);

    const rpmSignature = path.join(
      fixture,
      "dist",
      `ModelCrew_${VERSION}_linux_aarch64.rpm.sig`,
    );
    fs.rmSync(rpmSignature);
    const missingSignatureResult = verifyRelease(fixture);
    assert.notEqual(missingSignatureResult.status, 0);
    assert.match(missingSignatureResult.stderr, /linux_aarch64\.rpm\.sig/u);

    write(rpmSignature, "aarch64-rpm-signature");
    const latestPath = path.join(fixture, "dist", "latest.json");
    const latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
    latest.platforms["linux-aarch64-rpm"].url = "https://example.invalid/wrong.rpm";
    fs.writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
    const wrongUrlResult = verifyRelease(fixture);
    assert.notEqual(wrongUrlResult.status, 0);
    assert.match(wrongUrlResult.stderr, /linux-aarch64-rpm points to/u);

    latest.platforms["linux-aarch64-rpm"].url =
      `https://github.com/${REPOSITORY}/releases/download/v${VERSION}/ModelCrew_${VERSION}_linux_aarch64.rpm`;
    latest.platforms["linux-aarch64-rpm"].signature = "wrong-signature";
    fs.writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
    const wrongSignatureResult = verifyRelease(fixture);
    assert.notEqual(wrongSignatureResult.status, 0);
    assert.match(
      wrongSignatureResult.stderr,
      /linux-aarch64-rpm signature does not match/u,
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
