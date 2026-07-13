#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  parseArgs,
  readJson,
  requireArg,
  validateReleaseNotes,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const version = requireArg(args, "version");
const output = path.resolve(requireArg(args, "output"));
const notes = validateReleaseNotes(
  await readJson(`release-notes/${version}.json`),
  version,
);
const bullets = (items) => items.map((item) => `- ${item}`).join("\n");
const aurEnabled = String(args["aur-enabled"] ?? "false") === "true";
const archLine = aurEnabled
  ? "- Arch Linux: `yay -S modelcrew-bin`"
  : "- Arch Linux: use the attached `PKGBUILD` (automatic AUR publishing is not enabled yet)";

const body = `## Что нового

${notes.ru.summary}

${bullets(notes.ru.highlights)}

## What's new

${notes.en.summary}

${bullets(notes.en.highlights)}

## Что скачать / Downloads

- Windows x64: \`ModelCrew_${version}_windows_x64-setup.exe\`
- macOS Apple Silicon: \`ModelCrew_${version}_macos_aarch64.dmg\`
- macOS Intel: \`ModelCrew_${version}_macos_x86_64.dmg\`
- Ubuntu/Debian x64: \`ModelCrew_${version}_linux_x86_64.deb\`
- Ubuntu/Debian ARM64: \`ModelCrew_${version}_linux_aarch64.deb\`
- Fedora/RHEL: the matching \`.rpm\`
- Other Linux: \`ModelCrew_${version}_linux_x86_64.AppImage\` or \`ModelCrew_${version}_linux_aarch64.AppImage\`
${archLine}

> Файлы \`.sig\`, \`.app.tar.gz\` и \`latest.json\` используются системой обновлений. Обычному пользователю скачивать их не нужно.

> Files ending in \`.sig\`, \`.app.tar.gz\`, and \`latest.json\` are used by the updater and are not normal installers.

## Early release signing notice

This 0.0.x release is not yet signed with Apple Developer ID or a Windows Authenticode certificate. macOS Gatekeeper and Windows SmartScreen can therefore display a warning. Updater artifacts are still signed with the dedicated Tauri updater key.
`;

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, body, "utf8");
console.log(`Wrote ${output}`);
