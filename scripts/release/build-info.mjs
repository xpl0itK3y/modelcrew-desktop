#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs, requireArg, readJson, writeJson } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const output = path.resolve(requireArg(args, "output"));
const packageJson = await readJson("package.json");
const sha = process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const subject = execFileSync("git", ["log", "-1", "--pretty=%s"], { encoding: "utf8" }).trim();

await mkdir(path.dirname(output), { recursive: true });
await writeJson(output, {
  version: packageJson.version,
  commit: sha,
  shortCommit: sha.slice(0, 7),
  builtAt: new Date().toISOString(),
  subject,
  ref: process.env.GITHUB_REF ?? null,
  platform: requireArg(args, "platform"),
  architecture: requireArg(args, "arch"),
});
