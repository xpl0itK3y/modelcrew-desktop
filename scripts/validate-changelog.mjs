#!/usr/bin/env node

import fs from "node:fs";
import {
  changelogPath,
  containsPlaceholder,
  isSemVer,
  releaseNoteFiles,
  versionFromReleaseNotePath,
} from "./release-utils.mjs";

if (!fs.existsSync(changelogPath)) {
  console.error("CHANGELOG.md does not exist");
  process.exit(1);
}

const changelog = fs.readFileSync(changelogPath, "utf8");
const headingPattern = /^##\s+([^\r\n]+?)\s*$/gm;
const headings = [...changelog.matchAll(headingPattern)].map((match) => ({
  version: match[1],
  start: match.index,
  bodyStart: match.index + match[0].length,
}));
const errors = [];
const releaseVersions = releaseNoteFiles().map(versionFromReleaseNotePath);
const seenVersions = new Set();

if (headings.length === 0) {
  errors.push("CHANGELOG.md must contain at least one `## <version>` section");
}

for (let index = 0; index < headings.length; index += 1) {
  const heading = headings[index];
  const end = headings[index + 1]?.start ?? changelog.length;
  const body = changelog.slice(heading.bodyStart, end);

  if (!isSemVer(heading.version)) {
    errors.push(`section ${JSON.stringify(heading.version)} is not a valid SemVer version`);
    continue;
  }

  if (seenVersions.has(heading.version)) {
    errors.push(`version ${heading.version} appears more than once`);
  }
  seenVersions.add(heading.version);

  const russianHeading = body.indexOf("### Русский");
  const englishHeading = body.indexOf("### English");

  if (russianHeading === -1) {
    errors.push(`version ${heading.version} is missing the \`### Русский\` section`);
  }
  if (englishHeading === -1) {
    errors.push(`version ${heading.version} is missing the \`### English\` section`);
  }
  if (russianHeading !== -1 && englishHeading !== -1 && russianHeading > englishHeading) {
    errors.push(`version ${heading.version} must list Russian notes before English notes`);
  }

  const russianBody =
    russianHeading === -1
      ? ""
      : body.slice(
          russianHeading + "### Русский".length,
          englishHeading === -1 ? body.length : englishHeading,
        );
  const englishBody =
    englishHeading === -1 ? "" : body.slice(englishHeading + "### English".length);

  if (russianHeading !== -1 && !/^\s*\S/m.test(russianBody)) {
    errors.push(`version ${heading.version} has an empty Russian section`);
  }
  if (englishHeading !== -1 && !/^\s*\S/m.test(englishBody)) {
    errors.push(`version ${heading.version} has an empty English section`);
  }
  if (russianHeading !== -1 && !/^\s*-\s+\S/m.test(russianBody)) {
    errors.push(`version ${heading.version} Russian section needs at least one bullet`);
  }
  if (englishHeading !== -1 && !/^\s*-\s+\S/m.test(englishBody)) {
    errors.push(`version ${heading.version} English section needs at least one bullet`);
  }
  if (containsPlaceholder(body)) {
    errors.push(`version ${heading.version} still contains placeholder text`);
  }
}

for (const version of releaseVersions) {
  if (!seenVersions.has(version)) {
    errors.push(`release-notes/${version}.json has no matching CHANGELOG.md section`);
  }
}

for (const version of seenVersions) {
  if (!releaseVersions.includes(version)) {
    errors.push(`CHANGELOG.md version ${version} has no matching release-notes/${version}.json`);
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `CHANGELOG.md: ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Validated CHANGELOG.md with ${headings.length} version section${headings.length === 1 ? "" : "s"}.`);
