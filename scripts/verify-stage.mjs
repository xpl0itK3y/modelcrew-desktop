#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const checks = [
  [npm, ["run", "build"]],
  [npm, ["test"]],
  ["cargo", ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml"]],
  ["cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"]],
  [
    "cargo",
    [
      "clippy",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
  ],
  ["git", ["diff", "--check"]],
];

for (const [command, args] of checks) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Failed to start ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
