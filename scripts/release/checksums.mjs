#!/usr/bin/env node
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, requireArg, sha256 } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const dist = path.resolve(requireArg(args, "dist"));
const names = (await readdir(dist, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name !== "SHA256SUMS")
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));
const lines = [];
for (const name of names) {
  lines.push(`${await sha256(path.join(dist, name))}  ${name}`);
}
await writeFile(path.join(dist, "SHA256SUMS"), `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote ${lines.length} checksums`);
