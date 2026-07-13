#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertNonEmptyFile,
  parseArgs,
  readJson,
  releaseAssetUrl,
  requireArg,
  validateReleaseNotes,
  writeJson,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const version = requireArg(args, "version");
const repository = requireArg(args, "repository");
const dist = path.resolve(requireArg(args, "dist"));
const manifest = await readJson(path.resolve(requireArg(args, "manifest")));
const notes = validateReleaseNotes(
  await readJson(`release-notes/${version}.json`),
  version,
);
const expectedPlatforms = [
  "windows-x86_64",
  "windows-x86_64-nsis",
  "windows-x86_64-msi",
  "darwin-x86_64",
  "darwin-aarch64",
  ...["x86_64", "aarch64"].flatMap((arch) => [
    `linux-${arch}`,
    `linux-${arch}-appimage`,
    `linux-${arch}-deb`,
    `linux-${arch}-rpm`,
    `linux-${arch}-pacman`,
  ]),
];

const platforms = {};
for (const key of expectedPlatforms) {
  const artifact = manifest.platforms?.[key];
  if (!artifact) throw new Error(`Asset manifest has no ${key}`);
  const file = path.join(dist, artifact.file);
  const signatureFile = path.join(dist, artifact.signatureFile);
  await assertNonEmptyFile(file);
  await assertNonEmptyFile(signatureFile);
  const signature = (await readFile(signatureFile, "utf8")).trim();
  if (!signature) throw new Error(`Empty signature for ${artifact.file}`);
  platforms[key] = {
    signature,
    url: releaseAssetUrl(repository, version, artifact.file),
  };
}

const latest = {
  version,
  notes: notes.en.summary,
  pub_date: typeof args["pub-date"] === "string" ? args["pub-date"] : new Date().toISOString(),
  platforms,
  modelcrew: {
    releaseUrl: `https://github.com/${repository}/releases/tag/v${version}`,
    releaseNotes: {
      ru: notes.ru,
      en: notes.en,
    },
  },
};

await writeJson(path.join(dist, "latest.json"), latest);
console.log(`Generated latest.json for ${version}`);
