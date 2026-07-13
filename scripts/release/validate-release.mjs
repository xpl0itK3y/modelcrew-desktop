#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  compareSemver,
  fail,
  parseArgs,
  parseSemver,
  readJson,
  validateReleaseNotes,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(typeof args.root === "string" ? args.root : ".");
const packageJson = await readJson(path.join(root, "package.json"));
const version = packageJson.version;
parseSemver(version, "package.json version");
const packageLock = await readJson(path.join(root, "package-lock.json"));
if (
  packageLock.version !== version ||
  packageLock.packages?.[""]?.version !== version
) {
  fail(`package-lock.json does not match package.json version ${version}`);
}

const cargoToml = await readFile(path.join(root, "src-tauri/Cargo.toml"), "utf8");
const cargoPackage = /\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/u.exec(cargoToml);
if (!cargoPackage) fail("Cannot locate [package] version in src-tauri/Cargo.toml");
if (cargoPackage[1] !== version) {
  fail(`Cargo version ${cargoPackage[1]} does not match package.json ${version}`);
}
const cargoLock = await readFile(path.join(root, "src-tauri/Cargo.lock"), "utf8");
const cargoLockPackage = new RegExp(
  `\\[\\[package\\]\\]\\nname = "${packageJson.name}"\\nversion = "([^"]+)"`,
  "u",
).exec(cargoLock);
if (!cargoLockPackage) {
  fail(`Cannot locate ${packageJson.name} in src-tauri/Cargo.lock`);
}
if (cargoLockPackage[1] !== version) {
  fail(`Cargo.lock version ${cargoLockPackage[1]} does not match package.json ${version}`);
}

const tauriConfig = await readJson(path.join(root, "src-tauri/tauri.conf.json"));
if (tauriConfig.version !== "../package.json" && tauriConfig.version !== version) {
  fail(
    `tauri.conf.json version must be ../package.json (or ${version} during migration)`,
  );
}

const notesPath = path.join(root, "release-notes", `${version}.json`);
validateReleaseNotes(await readJson(notesPath), version);

const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const section = new RegExp(
  `(?:^|\\n)## ${escapedVersion}\\s*\\n([\\s\\S]*?)(?=\\n## \\S|$)`,
  "u",
).exec(changelog)?.[1];
if (!section) fail(`CHANGELOG.md has no section for ${version}`);
if (!/^### Русский\s*$/mu.test(section) || !/^### English\s*$/mu.test(section)) {
  fail(`CHANGELOG.md ${version} must contain Russian and English sections`);
}
if (/(?:TODO|TBD|PLACEHOLDER|ЗАПОЛНИТЬ)/iu.test(section)) {
  fail(`CHANGELOG.md ${version} still contains placeholder text`);
}

if (typeof args.tag === "string") {
  const expectedTag = `v${version}`;
  if (args.tag !== expectedTag) {
    fail(`Tag ${args.tag} does not match application version ${expectedTag}`);
  }
  if (!/^v\d+\.\d+\.\d+$/u.test(args.tag)) {
    fail(`Release tag has invalid format: ${args.tag}`);
  }

  const latestTag = typeof args["latest-tag"] === "string" ? args["latest-tag"] : "";
  if (!latestTag) {
    if (version !== "0.0.1") {
      fail(`The first public release must be 0.0.1, not ${version}`);
    }
  } else {
    if (!latestTag.startsWith("v")) fail(`Invalid latest release tag: ${latestTag}`);
    const latestVersion = latestTag.slice(1);
    parseSemver(latestVersion, "latest public release version");
    if (compareSemver(version, latestVersion) <= 0) {
      fail(`${version} must be greater than the latest public release ${latestVersion}`);
    }
  }
}

console.log(`Release metadata is valid for ${version}`);
