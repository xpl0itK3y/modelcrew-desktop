#!/usr/bin/env node
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  collectFiles,
  fail,
  parseArgs,
  requireArg,
  writeJson,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const input = path.resolve(requireArg(args, "input"));
const output = path.resolve(requireArg(args, "output"));
const manifestPath = path.resolve(requireArg(args, "manifest"));
const version = requireArg(args, "version");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(path.dirname(manifestPath), { recursive: true });

function one(files, predicate, label) {
  const matches = files.filter(predicate);
  if (matches.length !== 1) {
    fail(`${label}: expected exactly one file, found ${matches.length}: ${matches.join(", ")}`);
  }
  return matches[0];
}

async function platformFiles(artifact) {
  const root = path.join(input, artifact);
  try {
    return await collectFiles(root);
  } catch (error) {
    fail(`Missing build artifact directory ${root}: ${error.message}`);
  }
}

async function copy(source, filename) {
  await copyFile(source, path.join(output, filename));
  return filename;
}

async function copySignature(files, source, filename, required = true) {
  const signature = files.find((file) => file === `${source}.sig`);
  if (!signature) {
    if (required) fail(`Missing updater signature for ${source}`);
    return null;
  }
  return copy(signature, `${filename}.sig`);
}

const manifest = { version, platforms: {} };

{
  const files = await platformFiles("stable-windows-x64");
  const exe = one(files, (file) => /(?:-setup|_setup|setup)\.exe$/iu.test(file), "Windows NSIS installer");
  const msi = one(files, (file) => file.endsWith(".msi"), "Windows MSI installer");
  const exeName = await copy(exe, `ModelCrew_${version}_windows_x64-setup.exe`);
  const exeSig = await copySignature(files, exe, exeName);
  const msiName = await copy(msi, `ModelCrew_${version}_windows_x64.msi`);
  const msiSig = await copySignature(files, msi, msiName);
  const nsisArtifact = { file: exeName, signatureFile: exeSig };
  manifest.platforms["windows-x86_64"] = nsisArtifact;
  manifest.platforms["windows-x86_64-nsis"] = nsisArtifact;
  manifest.platforms["windows-x86_64-msi"] = {
    file: msiName,
    signatureFile: msiSig,
  };
}

for (const arch of ["aarch64", "x86_64"]) {
  const files = await platformFiles(`stable-macos-${arch}`);
  const dmg = one(files, (file) => file.endsWith(".dmg"), `macOS ${arch} DMG`);
  const archive = one(files, (file) => file.endsWith(".app.tar.gz"), `macOS ${arch} updater archive`);
  await copy(dmg, `ModelCrew_${version}_macos_${arch}.dmg`);
  const archiveName = await copy(archive, `ModelCrew_${version}_macos_${arch}.app.tar.gz`);
  const signatureName = await copySignature(files, archive, archiveName);
  manifest.platforms[`darwin-${arch}`] = {
    file: archiveName,
    signatureFile: signatureName,
  };
}

for (const arch of ["x86_64", "aarch64"]) {
  const files = await platformFiles(`stable-linux-${arch}`);
  const appImage = one(files, (file) => file.endsWith(".AppImage"), `Linux ${arch} AppImage`);
  const deb = one(files, (file) => file.endsWith(".deb"), `Linux ${arch} deb`);
  const rpm = one(files, (file) => file.endsWith(".rpm"), `Linux ${arch} rpm`);
  const appImageName = await copy(appImage, `ModelCrew_${version}_linux_${arch}.AppImage`);
  const signatureName = await copySignature(files, appImage, appImageName);
  await copy(deb, `ModelCrew_${version}_linux_${arch}.deb`);
  await copy(rpm, `ModelCrew_${version}_linux_${arch}.rpm`);
  manifest.platforms[`linux-${arch}`] = {
    file: appImageName,
    signatureFile: signatureName,
  };
}

await writeJson(manifestPath, manifest);
console.log(`Prepared release assets in ${output}`);
