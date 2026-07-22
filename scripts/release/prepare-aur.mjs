#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertNonEmptyFile,
  parseArgs,
  releaseAssetUrl,
  requireArg,
  sha256,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const version = requireArg(args, "version");
const repository = requireArg(args, "repository");
const dist = path.resolve(requireArg(args, "dist"));
const aurOutput = path.resolve(requireArg(args, "aur-output"));
if (aurOutput === dist) {
  throw new Error("--aur-output must be different from --dist");
}
const templatePath = path.resolve(
  typeof args.template === "string"
    ? args.template
    : "packaging/aur/PKGBUILD.template",
);
// x86_64 берём из нативно собранного на Arch пакета: бинарь из ubuntu-овского
// .deb запускается против более новых библиотек Arch и даёт чёрное окно.
// Для aarch64 нативной сборки не существует, поэтому там остаётся .deb.
const x86Name = `ModelCrew_${version}_linux_x86_64.pkg.tar.zst`;
const armName = `ModelCrew_${version}_linux_aarch64.deb`;
const x86Path = path.join(dist, x86Name);
const armPath = path.join(dist, armName);
await assertNonEmptyFile(x86Path);
await assertNonEmptyFile(armPath);
const x86Sha = await sha256(x86Path);
const armSha = await sha256(armPath);
const x86Url = releaseAssetUrl(repository, version, x86Name);
const armUrl = releaseAssetUrl(repository, version, armName);

let pkgbuild = await readFile(templatePath, "utf8");
for (const [token, value] of Object.entries({
  "@VERSION@": version,
  "@REPOSITORY_URL@": `https://github.com/${repository}`,
  "@X86_URL@": x86Url,
  "@X86_SHA256@": x86Sha,
  "@ARM64_URL@": armUrl,
  "@ARM64_SHA256@": armSha,
})) {
  pkgbuild = pkgbuild.replaceAll(token, value);
}
if (/@[A-Z0-9_]+@/u.test(pkgbuild)) {
  throw new Error("PKGBUILD template still contains unresolved tokens");
}
const srcinfo = `pkgbase = modelcrew-bin
\tpkgdesc = Desktop workspace for projects, sessions, and multiple terminals
\tpkgver = ${version}
\tpkgrel = 1
\turl = https://github.com/${repository}
\tarch = x86_64
\tarch = aarch64
\tlicense = MIT
\tdepends = cairo
\tdepends = desktop-file-utils
\tdepends = gdk-pixbuf2
\tdepends = git
\tdepends = glib2
\tdepends = gst-plugins-base
\tdepends = gst-plugins-good
\tdepends = gtk3
\tdepends = hicolor-icon-theme
\tdepends = libayatana-appindicator
\tdepends = libsoup3
\tdepends = openssl
\tdepends = pango
\tdepends = polkit
\tdepends = webkit2gtk-4.1
\tprovides = modelcrew
\tconflicts = modelcrew
\toptions = !strip
\tsource_x86_64 = modelcrew-bin-${version}-x86_64.pkg.tar.zst::${x86Url}
\tsha256sums_x86_64 = ${x86Sha}
\tsource_aarch64 = modelcrew-bin-${version}-aarch64.deb::${armUrl}
\tsha256sums_aarch64 = ${armSha}

pkgname = modelcrew-bin
`;
await rm(path.join(dist, ".SRCINFO"), { force: true });
await rm(path.join(dist, "default.SRCINFO"), { force: true });
await rm(aurOutput, { recursive: true, force: true });
await mkdir(aurOutput, { recursive: true });
await Promise.all([
  writeFile(path.join(dist, "PKGBUILD"), pkgbuild, "utf8"),
  writeFile(path.join(dist, "modelcrew-bin.SRCINFO"), srcinfo, "utf8"),
  writeFile(path.join(aurOutput, "PKGBUILD"), pkgbuild, "utf8"),
  writeFile(path.join(aurOutput, ".SRCINFO"), srcinfo, "utf8"),
]);
console.log(`Prepared AUR metadata for ${version}`);
