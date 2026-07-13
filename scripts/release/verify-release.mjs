#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  assertNonEmptyFile,
  fail,
  parseArgs,
  readJson,
  requireArg,
  sha256,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const dist = path.resolve(requireArg(args, "dist"));
const version = requireArg(args, "version");
const repository = requireArg(args, "repository");
const expected = [
  `ModelCrew_${version}_windows_x64-setup.exe`,
  `ModelCrew_${version}_windows_x64-setup.exe.sig`,
  `ModelCrew_${version}_windows_x64.msi`,
  `ModelCrew_${version}_windows_x64.msi.sig`,
  `ModelCrew_${version}_macos_aarch64.dmg`,
  `ModelCrew_${version}_macos_aarch64.app.tar.gz`,
  `ModelCrew_${version}_macos_aarch64.app.tar.gz.sig`,
  `ModelCrew_${version}_macos_x86_64.dmg`,
  `ModelCrew_${version}_macos_x86_64.app.tar.gz`,
  `ModelCrew_${version}_macos_x86_64.app.tar.gz.sig`,
  `ModelCrew_${version}_linux_x86_64.AppImage`,
  `ModelCrew_${version}_linux_x86_64.AppImage.sig`,
  `ModelCrew_${version}_linux_x86_64.deb`,
  `ModelCrew_${version}_linux_x86_64.rpm`,
  `ModelCrew_${version}_linux_aarch64.AppImage`,
  `ModelCrew_${version}_linux_aarch64.AppImage.sig`,
  `ModelCrew_${version}_linux_aarch64.deb`,
  `ModelCrew_${version}_linux_aarch64.rpm`,
  "PKGBUILD",
  ".SRCINFO",
  "latest.json",
  "SHA256SUMS",
];
for (const name of expected) await assertNonEmptyFile(path.join(dist, name));

const latest = await readJson(path.join(dist, "latest.json"));
if (latest.version !== version) fail(`latest.json version is not ${version}`);
const platformFiles = {
  "windows-x86_64": `ModelCrew_${version}_windows_x64-setup.exe`,
  "windows-x86_64-nsis": `ModelCrew_${version}_windows_x64-setup.exe`,
  "windows-x86_64-msi": `ModelCrew_${version}_windows_x64.msi`,
  "darwin-x86_64": `ModelCrew_${version}_macos_x86_64.app.tar.gz`,
  "darwin-aarch64": `ModelCrew_${version}_macos_aarch64.app.tar.gz`,
  "linux-x86_64": `ModelCrew_${version}_linux_x86_64.AppImage`,
  "linux-aarch64": `ModelCrew_${version}_linux_aarch64.AppImage`,
};
for (const [key, filename] of Object.entries(platformFiles)) {
  const item = latest.platforms?.[key];
  if (!item || typeof item.url !== "string" || typeof item.signature !== "string") {
    fail(`latest.json has invalid ${key}`);
  }
  const expectedUrl = `https://github.com/${repository}/releases/download/v${version}/${filename}`;
  if (item.url !== expectedUrl) {
    fail(`latest.json ${key} points to ${item.url}, expected ${expectedUrl}`);
  }
  if (!item.signature.trim()) fail(`latest.json ${key} has an empty signature`);
}

const checksumLines = (await readFile(path.join(dist, "SHA256SUMS"), "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean);
const checksums = new Map(
  checksumLines.map((line) => {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    if (!match) fail(`Invalid SHA256SUMS line: ${line}`);
    return [match[2], match[1]];
  }),
);
for (const entry of await readdir(dist, { withFileTypes: true })) {
  if (!entry.isFile() || entry.name === "SHA256SUMS") continue;
  const expectedHash = checksums.get(entry.name);
  if (!expectedHash) fail(`SHA256SUMS does not contain ${entry.name}`);
  if ((await sha256(path.join(dist, entry.name))) !== expectedHash) {
    fail(`Checksum mismatch for ${entry.name}`);
  }
}
console.log(`Verified ${expected.length} required release assets for ${version}`);
