#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertNonEmptyFile,
  fail,
  parseArgs,
  readJson,
  requireArg,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const dist = path.resolve(requireArg(args, "dist"));
const manifest = await readJson(path.resolve(requireArg(args, "manifest")));
const config = await readJson(
  path.resolve(typeof args.config === "string" ? args.config : "src-tauri/tauri.conf.json"),
);
const encodedPublicKey = config.plugins?.updater?.pubkey;
if (typeof encodedPublicKey !== "string" || !encodedPublicKey.trim()) {
  fail("tauri.conf.json plugins.updater.pubkey is missing");
}

function decodeBase64(value, label) {
  try {
    const decoded = Buffer.from(value.trim(), "base64");
    if (decoded.length === 0) fail(`${label} is empty`);
    return decoded;
  } catch (error) {
    fail(`${label} is not valid base64: ${error.message}`);
  }
}

const temp = await mkdtemp(path.join(os.tmpdir(), "modelcrew-signatures-"));
try {
  const publicKeyPath = path.join(temp, "updater.pub");
  await writeFile(publicKeyPath, decodeBase64(encodedPublicKey, "Updater public key"));
  for (const [platform, artifact] of Object.entries(manifest.platforms ?? {})) {
    const file = path.join(dist, artifact.file);
    const encodedSignaturePath = path.join(dist, artifact.signatureFile);
    await assertNonEmptyFile(file);
    await assertNonEmptyFile(encodedSignaturePath);
    const signaturePath = path.join(temp, `${platform}.sig`);
    await writeFile(
      signaturePath,
      decodeBase64(await readFile(encodedSignaturePath, "utf8"), `${platform} signature`),
    );
    const verification = spawnSync(
      "minisign",
      ["-Vm", file, "-p", publicKeyPath, "-x", signaturePath],
      { encoding: "utf8" },
    );
    if (verification.status !== 0) {
      fail(
        `Invalid ${platform} updater signature:\n${verification.stdout}\n${verification.stderr}`,
      );
    }
    console.log(`Verified ${platform}: ${artifact.file}`);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
