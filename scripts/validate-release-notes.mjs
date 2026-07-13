#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  formatValidationErrors,
  isSemVer,
  readJson,
  releaseNoteFiles,
  releaseNotesDirectory,
  validateReleaseNote,
  versionFromReleaseNotePath,
} from "./release-utils.mjs";

const requestedVersion = process.argv[2];

if (process.argv.length > 3) {
  console.error("Usage: node scripts/validate-release-notes.mjs [version]");
  process.exit(2);
}

if (requestedVersion !== undefined && !isSemVer(requestedVersion)) {
  console.error(`${JSON.stringify(requestedVersion)} is not a valid SemVer value`);
  process.exit(2);
}

const files = requestedVersion
  ? [path.join(releaseNotesDirectory, `${requestedVersion}.json`)]
  : releaseNoteFiles();

if (files.length === 0) {
  console.error("No release-notes/*.json files found");
  process.exit(1);
}

const failures = [];

for (const filePath of files) {
  if (!fs.existsSync(filePath)) {
    failures.push(`${path.relative(process.cwd(), filePath)}: file does not exist`);
    continue;
  }

  try {
    const version = versionFromReleaseNotePath(filePath);
    const errors = validateReleaseNote(readJson(filePath), {
      expectedVersion: version,
    });
    failures.push(...formatValidationErrors(filePath, errors));
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Validated ${files.length} release note file${files.length === 1 ? "" : "s"}.`);
