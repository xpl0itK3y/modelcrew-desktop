import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const PLACEHOLDER_MARKERS = [
  "__replace_me",
  "placeholder",
  "todo",
  "tbd",
  "fixme",
  "заполнить",
  "заполните",
];

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));

export const rootDirectory = path.resolve(scriptsDirectory, "..");
export const releaseNotesDirectory = path.join(rootDirectory, "release-notes");
export const changelogPath = path.join(rootDirectory, "CHANGELOG.md");

export function isSemVer(value) {
  return typeof value === "string" && SEMVER_PATTERN.test(value);
}

export function characterCount(value) {
  return Array.from(value).length;
}

export function containsPlaceholder(value) {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  return PLACEHOLDER_MARKERS.some((marker) => normalized.includes(marker));
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateText(value, field, maximumLength, allowPlaceholders) {
  const errors = [];

  if (typeof value !== "string") {
    return [`${field} must be a string`];
  }

  if (value.length === 0 || value.trim().length === 0) {
    errors.push(`${field} must not be empty`);
  } else if (value !== value.trim()) {
    errors.push(`${field} must not have leading or trailing whitespace`);
  }

  if (maximumLength !== undefined && characterCount(value) > maximumLength) {
    errors.push(`${field} must not exceed ${maximumLength} characters`);
  }

  if (!allowPlaceholders && containsPlaceholder(value)) {
    errors.push(`${field} still contains placeholder text`);
  }

  return errors;
}

function validateLocale(note, locale, allowPlaceholders) {
  const errors = [];
  const value = note[locale];

  if (!isPlainObject(value)) {
    return [`${locale} must be an object`];
  }

  errors.push(...validateText(value.title, `${locale}.title`, undefined, allowPlaceholders));
  errors.push(...validateText(value.summary, `${locale}.summary`, 200, allowPlaceholders));

  if (!Array.isArray(value.highlights)) {
    errors.push(`${locale}.highlights must be an array`);
    return errors;
  }

  if (value.highlights.length < 1 || value.highlights.length > 5) {
    errors.push(`${locale}.highlights must contain between 1 and 5 items`);
  }

  value.highlights.forEach((highlight, index) => {
    errors.push(
      ...validateText(
        highlight,
        `${locale}.highlights[${index}]`,
        120,
        allowPlaceholders,
      ),
    );
  });

  return errors;
}

export function validateReleaseNote(
  note,
  { expectedVersion, allowPlaceholders = false } = {},
) {
  const errors = [];

  if (!isPlainObject(note)) {
    return ["release note must be a JSON object"];
  }

  if (!isSemVer(note.version)) {
    errors.push("version must be a valid SemVer value");
  }

  if (expectedVersion !== undefined && note.version !== expectedVersion) {
    errors.push(
      `version ${JSON.stringify(note.version)} does not match filename version ${JSON.stringify(expectedVersion)}`,
    );
  }

  errors.push(...validateLocale(note, "ru", allowPlaceholders));
  errors.push(...validateLocale(note, "en", allowPlaceholders));

  return errors;
}

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read JSON from ${path.relative(rootDirectory, filePath)}: ${detail}`);
  }
}

export function releaseNoteFiles() {
  if (!fs.existsSync(releaseNotesDirectory)) {
    return [];
  }

  return fs
    .readdirSync(releaseNotesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(releaseNotesDirectory, entry.name))
    .sort((left, right) => left.localeCompare(right, "en"));
}

export function versionFromReleaseNotePath(filePath) {
  return path.basename(filePath, ".json");
}

export function formatValidationErrors(filePath, errors) {
  const label = path.relative(rootDirectory, filePath);
  return errors.map((error) => `${label}: ${error}`);
}
