#!/usr/bin/env node
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fail, parseArgs, readJson, requireArg } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const dist = path.resolve(requireArg(args, "dist"));
const remote = await readJson(path.resolve(requireArg(args, "remote")));
if (!Array.isArray(remote)) fail("Remote assets response must be an array");
const local = new Map();
for (const entry of await readdir(dist, { withFileTypes: true })) {
  if (entry.isFile()) {
    local.set(entry.name, (await stat(path.join(dist, entry.name))).size);
  }
}
const remoteByName = new Map(remote.map((asset) => [asset.name, asset]));
for (const name of local.keys()) {
  const asset = remoteByName.get(name);
  if (!asset) fail(`Release is missing uploaded asset ${name}`);
  if (!Number.isFinite(asset.size) || asset.size !== local.get(name)) {
    fail(`Remote asset ${name} size ${asset.size} does not match local ${local.get(name)}`);
  }
  if (asset.state !== "uploaded") fail(`Remote asset ${name} is not uploaded (${asset.state})`);
}
for (const name of remoteByName.keys()) {
  if (!local.has(name)) fail(`Release contains unexpected asset ${name}`);
}
console.log(`Remote release has exactly ${local.size} non-empty assets`);
