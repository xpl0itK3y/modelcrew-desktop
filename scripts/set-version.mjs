#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  changelogPath,
  isSemVer,
  releaseNotesDirectory,
  rootDirectory,
} from "./release-utils.mjs";

const nextVersion = process.argv[2];

if (process.argv.length !== 3 || !isSemVer(nextVersion)) {
  console.error("Usage: node scripts/set-version.mjs <semver>");
  process.exit(2);
}

const packageJsonPath = path.join(rootDirectory, "package.json");
const packageLockPath = path.join(rootDirectory, "package-lock.json");
const cargoManifestPath = path.join(rootDirectory, "src-tauri", "Cargo.toml");
const cargoLockPath = path.join(rootDirectory, "src-tauri", "Cargo.lock");
const releaseNotePath = path.join(releaseNotesDirectory, `${nextVersion}.json`);

function readRequired(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${path.relative(rootDirectory, filePath)} does not exist`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function parseJson(text, filePath) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${path.relative(rootDirectory, filePath)} is invalid JSON: ${detail}`);
  }
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function updateCargoPackageVersion(manifest) {
  const packageSection = /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/m;
  if (!packageSection.test(manifest)) {
    throw new Error("src-tauri/Cargo.toml has no package version");
  }
  return manifest.replace(packageSection, `$1${nextVersion}$2`);
}

function createReleaseNote() {
  return {
    version: nextVersion,
    ru: {
      title: "__REPLACE_ME_RU_TITLE__",
      summary: "__REPLACE_ME_RU_SUMMARY__",
      highlights: ["__REPLACE_ME_RU_HIGHLIGHT__"],
    },
    en: {
      title: "__REPLACE_ME_EN_TITLE__",
      summary: "__REPLACE_ME_EN_SUMMARY__",
      highlights: ["__REPLACE_ME_EN_HIGHLIGHT__"],
    },
  };
}

function createChangelogSection() {
  return `## ${nextVersion}

### Русский

__REPLACE_ME_RU_SUMMARY__

- __REPLACE_ME_RU_HIGHLIGHT__

### English

__REPLACE_ME_EN_SUMMARY__

- __REPLACE_ME_EN_HIGHLIGHT__
`;
}

function addChangelogSection(changelog) {
  const existingVersions = [...changelog.matchAll(/^##\s+([^\r\n]+?)\s*$/gm)].map(
    (match) => match[1],
  );
  if (existingVersions.includes(nextVersion)) {
    throw new Error(`CHANGELOG.md already contains version ${nextVersion}`);
  }

  const firstVersionHeading = changelog.search(/^##\s+/m);
  const section = createChangelogSection();
  if (firstVersionHeading === -1) {
    return `${changelog.trimEnd()}\n\n${section}`;
  }
  return `${changelog.slice(0, firstVersionHeading)}${section}\n${changelog.slice(firstVersionHeading)}`;
}

function runCargo(args, label) {
  const result = spawnSync("cargo", args, {
    cwd: rootDirectory,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });

  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || `exit code ${result.status}`;
    throw new Error(`${label} failed: ${detail}`);
  }
}

const originalFiles = new Map();
let releaseNoteCreated = false;

try {
  if (fs.existsSync(releaseNotePath)) {
    throw new Error(`release-notes/${nextVersion}.json already exists`);
  }

  for (const filePath of [
    packageJsonPath,
    packageLockPath,
    cargoManifestPath,
    cargoLockPath,
    changelogPath,
  ]) {
    originalFiles.set(filePath, readRequired(filePath));
  }

  const packageJson = parseJson(originalFiles.get(packageJsonPath), packageJsonPath);
  const packageLock = parseJson(originalFiles.get(packageLockPath), packageLockPath);

  if (typeof packageJson.version !== "string") {
    throw new Error("package.json has no version");
  }
  if (typeof packageLock.version !== "string" || typeof packageLock.packages?.[""]?.version !== "string") {
    throw new Error("package-lock.json has no root package version");
  }

  packageJson.version = nextVersion;
  packageLock.version = nextVersion;
  packageLock.packages[""].version = nextVersion;

  const nextCargoManifest = updateCargoPackageVersion(originalFiles.get(cargoManifestPath));
  const nextChangelog = addChangelogSection(originalFiles.get(changelogPath));

  fs.mkdirSync(releaseNotesDirectory, { recursive: true });
  fs.writeFileSync(packageJsonPath, serializeJson(packageJson));
  fs.writeFileSync(packageLockPath, serializeJson(packageLock));
  fs.writeFileSync(cargoManifestPath, nextCargoManifest);
  fs.writeFileSync(releaseNotePath, serializeJson(createReleaseNote()));
  releaseNoteCreated = true;
  fs.writeFileSync(changelogPath, nextChangelog);

  runCargo(
    ["metadata", "--manifest-path", cargoManifestPath, "--format-version", "1"],
    "cargo metadata",
  );
  runCargo(["check", "--manifest-path", cargoManifestPath, "--locked"], "cargo check --locked");

  console.log(`Updated ModelCrew version to ${nextVersion}.`);
  console.log(`Fill release-notes/${nextVersion}.json and CHANGELOG.md before creating a release.`);
  console.log("No Git tag was created.");
} catch (error) {
  for (const [filePath, contents] of originalFiles) {
    fs.writeFileSync(filePath, contents);
  }
  if (releaseNoteCreated && fs.existsSync(releaseNotePath)) {
    fs.rmSync(releaseNotePath);
  }

  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
