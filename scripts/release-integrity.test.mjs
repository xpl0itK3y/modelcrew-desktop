// Проверка релиза — последний рубеж перед тем, как файлы уедут на машины
// пользователей. Опаснее всего здесь не «ошибочно не пропустили», а
// «молча пропустили»: нет minisign, пустая подпись, отсутствующий ключ. Все
// такие случаи обязаны заканчиваться ненулевым кодом выхода, а не успехом.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertNonEmptyFile,
  readJson,
  releaseAssetUrl,
  validateReleaseNotes,
} from "./release/lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const verifySignatures = path.join(root, "scripts", "release", "verify-signatures.mjs");
const checksums = path.join(root, "scripts", "release", "checksums.mjs");

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modelcrew-integrity-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Полный запуск сценария: важен именно код выхода, поэтому node зовём по
// абсолютному пути и не полагаемся на PATH ребёнка.
function run(script, args, { withoutPath = false } = {}) {
  const env = { ...process.env };
  if (withoutPath) {
    env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), "modelcrew-nopath-"));
    delete env.Path;
  }
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
}

// Минимальный набор файлов, который verify-signatures ожидает увидеть.
function signatureFixture(overrides = {}) {
  const dir = workspace();
  const dist = path.join(dir, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "app.tar.gz"), overrides.artifact ?? "artifact bytes");
  fs.writeFileSync(
    path.join(dist, "app.tar.gz.sig"),
    overrides.signature ?? Buffer.from("untrusted comment: x\nnot-a-real-signature\n").toString("base64"),
  );
  const manifest = path.join(dir, "latest.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      platforms: {
        "darwin-aarch64": {
          file: overrides.file ?? "app.tar.gz",
          signatureFile: overrides.signatureFile ?? "app.tar.gz.sig",
        },
      },
    }),
  );
  const config = path.join(dir, "tauri.conf.json");
  const real = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  if ("pubkey" in overrides) real.plugins.updater.pubkey = overrides.pubkey;
  fs.writeFileSync(config, JSON.stringify(real));
  return { dist, manifest, config };
}

function verify(overrides, options) {
  const fixture = signatureFixture(overrides);
  return run(
    verifySignatures,
    ["--dist", fixture.dist, "--manifest", fixture.manifest, "--config", fixture.config],
    options,
  );
}

test("signature verification fails when the verifier itself is unavailable", () => {
  // Самый коварный отказ: minisign не установлен, spawnSync возвращает
  // status: null — и «!== 0» обязано отправить релиз в отказ, а не мимо.
  const result = verify({}, { withoutPath: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /updater signature/u);
});

test("signature verification fails on a signature that is not the real one", () => {
  const result = verify({});
  assert.notEqual(result.status, 0);
});

test("signature verification refuses a release with no updater public key", () => {
  for (const pubkey of [undefined, "", "   "]) {
    const result = verify({ pubkey });
    assert.notEqual(result.status, 0, `pubkey ${JSON.stringify(pubkey)} was accepted`);
    assert.match(result.stderr, /pubkey is missing|is empty/u);
  }
});

test("signature verification refuses an empty artifact or an empty signature", () => {
  const empty = verify({ artifact: "" });
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /missing or empty/u);

  const unsigned = verify({ signature: "" });
  assert.notEqual(unsigned.status, 0);
  assert.match(unsigned.stderr, /missing or empty/u);
});

test("signature verification refuses a manifest entry whose files are not there", () => {
  const missingArtifact = verify({ file: "does-not-exist.tar.gz" });
  assert.notEqual(missingArtifact.status, 0);

  const missingSignature = verify({ signatureFile: "does-not-exist.sig" });
  assert.notEqual(missingSignature.status, 0);
});

test("a manifest that points at a file outside the release directory still fails", () => {
  // Манифест генерируем мы сами, но подменённая запись не должна привести к
  // «проверено» про посторонний файл. Сам путь скрипт не ограничивает —
  // отказ даёт подпись, поэтому берём существующий файл рядом, чтобы отказ
  // случился именно на проверке, а не на «файла нет».
  const dir = workspace();
  const dist = path.join(dir, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dir, "outsider.bin"), "not the artifact");
  fs.writeFileSync(
    path.join(dist, "app.tar.gz.sig"),
    Buffer.from("untrusted comment: x\nnot-a-real-signature\n").toString("base64"),
  );
  const manifest = path.join(dir, "latest.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      platforms: {
        "darwin-aarch64": {
          file: path.join("..", "outsider.bin"),
          signatureFile: "app.tar.gz.sig",
        },
      },
    }),
  );
  const result = run(verifySignatures, [
    "--dist",
    dist,
    "--manifest",
    manifest,
    "--config",
    path.join(root, "src-tauri", "tauri.conf.json"),
  ]);
  assert.notEqual(result.status, 0);
});

test("checksums cover every published file in a format shasum can check", () => {
  const dir = workspace();
  const names = ["ModelCrew_0.0.1_amd64.deb", "ModelCrew 0.0.1.dmg", "ModelCrew-Ünïcode.AppImage"];
  const contents = new Map();
  for (const [index, name] of names.entries()) {
    const body = `payload-${index}`;
    contents.set(name, body);
    fs.writeFileSync(path.join(dir, name), body);
  }

  const result = run(checksums, ["--dist", dir]);
  assert.equal(result.status, 0, result.stderr);

  const text = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8");
  assert.ok(text.endsWith("\n"), "SHA256SUMS must end with a newline");
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, names.length);
  const listed = new Map();
  for (const line of lines) {
    // Ровно два пробела между суммой и именем — иначе `shasum -c` не разберёт.
    const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
    assert.ok(match, `unparsable checksum line: ${line}`);
    listed.set(match[2], match[1]);
  }
  assert.deepEqual([...listed.keys()].sort(), [...names].sort());
  for (const [name, body] of contents) {
    assert.equal(listed.get(name), createHash("sha256").update(body).digest("hex"));
  }
  // Сам файл сумм в список не попадает — иначе его нельзя было бы проверить.
  assert.ok(!listed.has("SHA256SUMS"));
});

test("a single changed byte changes the recorded checksum", () => {
  const dir = workspace();
  const file = path.join(dir, "artifact.bin");
  fs.writeFileSync(file, "original");
  assert.equal(run(checksums, ["--dist", dir]).status, 0);
  const before = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8");

  fs.writeFileSync(file, "originaL");
  assert.equal(run(checksums, ["--dist", dir]).status, 0);
  const after = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8");

  assert.notEqual(before, after);
});

test("checksums refuses to run without a directory", () => {
  const result = run(checksums, []);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required argument --dist/u);
});

test("an asset name cannot break out of the download URL path", () => {
  assert.equal(
    releaseAssetUrl("owner/repo", "1.2.3", "ModelCrew 1.2.3.dmg"),
    "https://github.com/owner/repo/releases/download/v1.2.3/ModelCrew%201.2.3.dmg",
  );
  for (const hostile of ["../../evil.sh", "a/b", "x?y=1", "x#y", "x&y", "a\nb"]) {
    const url = releaseAssetUrl("owner/repo", "1.2.3", hostile);
    const tail = url.slice("https://github.com/owner/repo/releases/download/v1.2.3/".length);
    assert.doesNotMatch(tail, /[/?#&\n]/u, `${hostile} survived into the URL as ${tail}`);
    assert.equal(new URL(url).origin, "https://github.com");
  }
});

test("an empty, missing or non-regular file never passes as an artifact", async () => {
  const dir = workspace();
  const empty = path.join(dir, "empty.bin");
  fs.writeFileSync(empty, "");
  await assert.rejects(() => assertNonEmptyFile(empty), /missing or empty/u);
  await assert.rejects(() => assertNonEmptyFile(path.join(dir, "absent.bin")));
  await assert.rejects(() => assertNonEmptyFile(dir), /missing or empty/u);
});

test("malformed release metadata is reported with the file that broke", async () => {
  const dir = workspace();
  const broken = path.join(dir, "latest.json");
  fs.writeFileSync(broken, "{ not json");
  await assert.rejects(() => readJson(broken), new RegExp(`Cannot read JSON ${broken.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
});

test("release notes cannot smuggle markup into the update popover", () => {
  // Заметки уезжают в latest.json и показываются в окне приложения, поэтому
  // угловые скобки запрещены во всех полях, а не только в заголовке.
  const valid = () => ({
    version: "1.2.3",
    ru: { title: "Заголовок", summary: "Описание", highlights: ["Пункт"] },
    en: { title: "Title", summary: "Summary", highlights: ["Item"] },
  });
  assert.doesNotThrow(() => validateReleaseNotes(valid(), "1.2.3"));

  const withMarkup = "<img src=x onerror=alert(1)>";
  for (const mutate of [
    (notes) => { notes.en.title = withMarkup; },
    (notes) => { notes.en.summary = withMarkup; },
    (notes) => { notes.en.highlights = [withMarkup]; },
    (notes) => { notes.ru.title = withMarkup; },
    (notes) => { notes.ru.summary = withMarkup; },
    (notes) => { notes.ru.highlights = ["ок", withMarkup]; },
  ]) {
    const notes = valid();
    mutate(notes);
    assert.throws(() => validateReleaseNotes(notes, "1.2.3"), /HTML brackets/u);
  }
});

test("release notes must match the version being built and stay complete", () => {
  const base = () => ({
    version: "1.2.3",
    ru: { title: "Заголовок", summary: "Описание", highlights: ["Пункт"] },
    en: { title: "Title", summary: "Summary", highlights: ["Item"] },
  });
  assert.throws(() => validateReleaseNotes(base(), "1.2.4"), /does not match/u);
  assert.throws(() => validateReleaseNotes(null, "1.2.3"), /must be a JSON object/u);
  assert.throws(() => validateReleaseNotes([base()], "1.2.3"), /must be a JSON object/u);

  const noRussian = base();
  delete noRussian.ru;
  assert.throws(() => validateReleaseNotes(noRussian, "1.2.3"), /locale ru is required/u);

  const empty = base();
  empty.en.highlights = [];
  assert.throws(() => validateReleaseNotes(empty, "1.2.3"), /between 1 and 5/u);

  const flooded = base();
  flooded.en.highlights = ["a", "b", "c", "d", "e", "f"];
  assert.throws(() => validateReleaseNotes(flooded, "1.2.3"), /between 1 and 5/u);

  const oversized = base();
  oversized.en.summary = "x".repeat(201);
  assert.throws(() => validateReleaseNotes(oversized, "1.2.3"), /at most 200 characters/u);

  const placeholder = base();
  placeholder.ru.title = "ЗАПОЛНИТЬ";
  assert.throws(() => validateReleaseNotes(placeholder, "1.2.3"), /placeholder text/u);
});
