import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const PLACEHOLDER = /(?:TODO|TBD|PLACEHOLDER|FILL[ _-]?ME|ЗАПОЛНИТЬ|ЗАМЕНИТЬ)/iu;

export function fail(message) {
  throw new Error(message);
}

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      fail(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

export function requireArg(args, name) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    fail(`Missing required argument --${name}`);
  }
  return value;
}

export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    fail(`Cannot read JSON ${file}: ${error.message}`);
  }
}

export async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function parseSemver(version, label = "version") {
  const match = SEMVER.exec(version);
  if (!match) {
    fail(`${label} is not valid SemVer: ${version}`);
  }
  return {
    raw: version,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? "",
  };
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const field of ["major", "minor", "patch"]) {
    if (a[field] !== b[field]) {
      return a[field] > b[field] ? 1 : -1;
    }
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

function assertPlainText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    fail(`${label} must be at most ${maxLength} characters`);
  }
  if (PLACEHOLDER.test(value)) {
    fail(`${label} still contains placeholder text`);
  }
  if (/[<>]/u.test(value)) {
    fail(`${label} must be plain text and cannot contain HTML brackets`);
  }
}

export function validateReleaseNotes(notes, expectedVersion) {
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) {
    fail("Release notes must be a JSON object");
  }
  if (notes.version !== expectedVersion) {
    fail(
      `Release notes version ${String(notes.version)} does not match ${expectedVersion}`,
    );
  }
  for (const locale of ["ru", "en"]) {
    const localized = notes[locale];
    if (!localized || typeof localized !== "object" || Array.isArray(localized)) {
      fail(`Release notes locale ${locale} is required`);
    }
    assertPlainText(localized.title, `${locale}.title`, 120);
    assertPlainText(localized.summary, `${locale}.summary`, 200);
    if (
      !Array.isArray(localized.highlights) ||
      localized.highlights.length < 1 ||
      localized.highlights.length > 5
    ) {
      fail(`${locale}.highlights must contain between 1 and 5 items`);
    }
    localized.highlights.forEach((item, index) =>
      assertPlainText(item, `${locale}.highlights[${index}]`, 120),
    );
  }
  return notes;
}

export async function collectFiles(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        output.push(absolute);
      }
    }
  }
  await visit(root);
  return output.sort((left, right) => left.localeCompare(right));
}

export async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

export async function assertNonEmptyFile(file, label = path.basename(file)) {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size === 0) {
    fail(`${label} is missing or empty: ${file}`);
  }
}

export function releaseAssetUrl(repository, version, filename) {
  return `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(filename)}`;
}
