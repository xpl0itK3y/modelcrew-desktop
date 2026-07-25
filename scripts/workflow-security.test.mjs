// Конвейер подписывает и публикует то, что попадёт на машины пользователей,
// поэтому его настройки — часть защищаемого периметра, а не «просто CI».
// Здесь проверяются инварианты, которые легко потерять одной строкой в YAML:
// закреплённые версии действий, минимальные права, секреты только через env,
// отсутствие подстановки чужого текста в скрипты и порядок «сначала проверить,
// потом опубликовать».
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = path.join(root, ".github", "workflows");

const workflows = readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml"))
  .sort()
  .map((name) => {
    const text = readFileSync(path.join(workflowsDir, name), "utf8");
    return { name, text, lines: text.split("\n") };
  });

// Полноценный парсер YAML сюда тянуть нельзя (новых зависимостей не заводим),
// да и не нужен: все проверки ниже — про отступы и текст, а файлы конвейера
// отформатированы единообразно.
function indentOf(line) {
  return line.search(/\S/);
}

// Блок = строка index и всё, что вложено в неё по отступу.
function block(lines, index) {
  const base = indentOf(lines[index]);
  let end = index + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() !== "" && indentOf(line) <= base) break;
    end += 1;
  }
  return lines.slice(index, end);
}

function jobsOf(workflow) {
  const start = workflow.lines.indexOf("jobs:");
  if (start < 0) return [];
  const jobsBlock = block(workflow.lines, start);
  const jobs = [];
  for (let i = 1; i < jobsBlock.length; i += 1) {
    const match = /^ {2}([A-Za-z][\w-]*):\s*$/u.exec(jobsBlock[i]);
    if (match) jobs.push({ name: match[1], lines: block(jobsBlock, i) });
  }
  return jobs;
}

function jobNameAt(workflow, index) {
  for (let i = index; i >= 0; i -= 1) {
    const match = /^ {2}([A-Za-z][\w-]*):\s*$/u.exec(workflow.lines[i]);
    if (match) return match[1];
  }
  return "<top level>";
}

// Тело `run:` — и однострочное, и блочное (`|`, `>-`).
function runBodies(workflow) {
  const bodies = [];
  for (let i = 0; i < workflow.lines.length; i += 1) {
    const match = /^\s*run:\s?(.*)$/u.exec(workflow.lines[i]);
    if (!match) continue;
    bodies.push({
      line: i + 1,
      job: jobNameAt(workflow, i),
      text: [match[1], ...block(workflow.lines, i).slice(1)].join("\n"),
    });
  }
  return bodies;
}

// Шаг, внутри которого лежит строка index (ближайший «- » вверх по файлу).
function stepAt(workflow, index) {
  for (let i = index; i >= 0; i -= 1) {
    if (/^\s*-\s\S/u.test(workflow.lines[i])) return block(workflow.lines, i);
  }
  return [];
}

test("every workflow declares least-privilege permissions at the top level", () => {
  const declared = workflows.map((workflow) => {
    const index = workflow.lines.indexOf("permissions:");
    if (index < 0) return `${workflow.name}: <missing>`;
    const body = block(workflow.lines, index)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(", ");
    return `${workflow.name}: ${body}`;
  });
  assert.deepEqual(
    declared,
    workflows.map((workflow) => `${workflow.name}: contents: read`),
  );
});

test("only the publishing jobs may write, and only to contents", () => {
  const elevated = [];
  for (const workflow of workflows) {
    for (const job of jobsOf(workflow)) {
      const index = job.lines.findIndex((line) => /^\s+permissions:\s*$/u.test(line));
      if (index < 0) continue;
      for (const line of block(job.lines, index).slice(1)) {
        const scope = line.trim();
        if (!scope || scope.startsWith("#")) continue;
        assert.match(
          scope,
          /^contents: (read|write)$/u,
          `${workflow.name}#${job.name} grants a scope outside contents: ${scope}`,
        );
        if (scope === "contents: write") elevated.push(`${workflow.name}#${job.name}`);
      }
    }
  }
  // Черновик релиза создаёт prepare, публикует finalize. Больше право на
  // запись не нужно никому — ни сборкам, ни публикации в AUR (та ходит по SSH).
  assert.deepEqual(elevated.sort(), [
    "release-finalize.yml#finalize",
    "release-prepare.yml#prepare",
    "release.yml#finalize",
    "release.yml#prepare",
  ]);
});

test("every third-party action is pinned to a full commit sha", () => {
  const unpinned = [];
  for (const workflow of workflows) {
    workflow.lines.forEach((line, index) => {
      const match = /^\s*uses:\s*(\S+)/u.exec(line);
      if (!match) return;
      const reference = match[1];
      // Свои переиспользуемые workflow берутся из этого же коммита.
      if (reference.startsWith("./")) return;
      if (!/@[0-9a-f]{40}$/u.test(reference)) {
        unpinned.push(`${workflow.name}:${index + 1} ${reference}`);
      }
    });
  }
  assert.deepEqual(unpinned, []);
});

test("no workflow runs on a trigger that hands secrets to untrusted code", () => {
  for (const workflow of workflows) {
    assert.doesNotMatch(
      workflow.text,
      /^\s*pull_request_target:/mu,
      `${workflow.name} uses pull_request_target`,
    );
    assert.doesNotMatch(
      workflow.text,
      /^\s*workflow_run:/mu,
      `${workflow.name} uses workflow_run`,
    );
  }
  // CI — единственный конвейер, который запускается на pull request, в том
  // числе из форка. Он не должен видеть ни одного секрета.
  const ci = workflows.find((workflow) => workflow.name === "ci.yml");
  assert.match(ci.text, /^\s*pull_request:/mu);
  assert.doesNotMatch(ci.text, /secrets\./u);
});

test("secrets reach a step only through env or with, never inline in a script", () => {
  const inline = [];
  for (const workflow of workflows) {
    for (const body of runBodies(workflow)) {
      if (/secrets\./u.test(body.text)) {
        inline.push(`${workflow.name}:${body.line}`);
      }
    }
    workflow.lines.forEach((line, index) => {
      if (!line.includes("secrets.")) return;
      assert.match(
        line,
        /^\s*[A-Za-z_][\w-]*:\s*\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}\s*$/u,
        `${workflow.name}:${index + 1} references a secret outside a plain mapping`,
      );
    });
  }
  assert.deepEqual(inline, []);
});

test("no script interpolates a context an outsider can shape", () => {
  const interpolations = [];
  for (const workflow of workflows) {
    for (const body of runBodies(workflow)) {
      for (const found of body.text.match(/\$\{\{[^}]*\}\}/gu) ?? []) {
        const expression = found.replace(/^\$\{\{\s*|\s*\}\}$/gu, "");
        assert.doesNotMatch(
          expression,
          /^(github\.event|github\.head_ref|github\.actor|github\.triggering_actor|inputs\.)/u,
          `${workflow.name}:${body.line} splices attacker-shaped text into a shell: ${found}`,
        );
        interpolations.push(`${workflow.name}: ${expression}`);
      }
    }
  }
  // Всё, что вообще подставляется в скрипты, перечислено здесь: matrix и
  // vars пишет сам репозиторий, steps.* — вывод предыдущего шага, а
  // github.ref_name — имя тега, который может поставить только мейнтейнер
  // (и validate-release.mjs всё равно требует от него вид vX.Y.Z).
  const contexts = [...new Set(interpolations.map((entry) => entry.split(": ")[1].split(".")[0]))];
  assert.deepEqual(contexts.sort(), ["github", "matrix", "steps", "vars"]);
  const githubContexts = [
    ...new Set(interpolations.filter((entry) => entry.includes(": github.")).map((entry) => entry.split(": ")[1])),
  ];
  assert.deepEqual(githubContexts, ["github.ref_name"]);
});

test("a checkout in the release chain does not leave the workflow token on disk", () => {
  const persisting = [];
  for (const workflow of workflows) {
    workflow.lines.forEach((line, index) => {
      if (!/^\s*uses:\s*actions\/checkout@/u.test(line)) return;
      const step = stepAt(workflow, index).join("\n");
      if (!/persist-credentials:\s*false/u.test(step)) {
        persisting.push(`${workflow.name}#${jobNameAt(workflow, index)}`);
      }
    });
  }
  // Каждое место, где токен остаётся в .git/config, должно быть осознанным.
  // Эти задания ничего не пушат — они только читают исходники (публикация в
  // AUR идёт по отдельному SSH-ключу). Список может сокращаться, но не расти.
  const known = new Set([
    "ci.yml#verify",
    "ci.yml#backend",
    "nightly.yml#preflight",
    "nightly.yml#build",
    "release-publish-aur.yml#publish",
  ]);
  const unexpected = persisting.filter((entry) => !known.has(entry));
  assert.deepEqual(unexpected, []);
});

test("every job that occupies a runner has a timeout", () => {
  const untimed = [];
  for (const workflow of workflows) {
    for (const job of jobsOf(workflow)) {
      const body = job.lines.join("\n");
      // Задания-обёртки (`uses:` над своим же workflow) времени не задают —
      // ограничение действует внутри вызванного конвейера.
      if (!/^\s+runs-on:/mu.test(body)) continue;
      if (!/^\s+timeout-minutes:\s*\d+/mu.test(body)) {
        untimed.push(`${workflow.name}#${job.name}`);
      }
    }
  }
  assert.deepEqual(untimed, []);
});

test("the AUR publish pins the host key and keeps the private key to itself", () => {
  const aur = workflows.find((workflow) => workflow.name === "release-publish-aur.yml");
  assert.ok(aur, "release-publish-aur.yml is missing");
  for (const required of [
    "StrictHostKeyChecking yes",
    "IdentitiesOnly yes",
    "GlobalKnownHostsFile /dev/null",
    "install -d -m 700 ~/.ssh",
    "chmod 600 ~/.ssh/aur",
    "expected_host_fingerprint=",
  ]) {
    assert.ok(aur.text.includes(required), `AUR publish no longer does: ${required}`);
  }
  // Отпечаток сверяется с файлом, лежащим в репозитории, а не с тем, что
  // ответит сервер: подменённый хост тогда не пройдёт.
  const knownHosts = path.join(root, "packaging", "aur", "aur.archlinux.org_known_hosts");
  assert.ok(existsSync(knownHosts), "the checked-in AUR known_hosts is gone");
  assert.ok(aur.text.includes("packaging/aur/aur.archlinux.org_known_hosts"));
  assert.doesNotMatch(aur.text, /StrictHostKeyChecking\s+(no|accept-new)/u);
});

test("no build produces artifacts without the updater signing key", () => {
  let builds = 0;
  for (const workflow of workflows) {
    for (const body of runBodies(workflow)) {
      if (!body.text.includes("tauri build")) continue;
      builds += 1;
      const index = workflow.lines.findIndex(
        (line, at) => at + 1 === body.line && /^\s*run:/u.test(line),
      );
      const step = stepAt(workflow, index).join("\n");
      assert.match(
        step,
        /TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{\s*secrets\./u,
        `${workflow.name}:${body.line} builds bundles without the signing key`,
      );
      assert.match(
        step,
        /TAURI_SIGNING_PRIVATE_KEY_PASSWORD:\s*\$\{\{\s*secrets\./u,
        `${workflow.name}:${body.line} builds bundles without the signing key password`,
      );
    }
  }
  assert.ok(builds >= 5, `expected every platform build to be checked, saw ${builds}`);
  // И релиз, и nightly отдельно падают заранее, если ключа в секретах нет.
  for (const name of ["release-prepare.yml", "nightly.yml"]) {
    const workflow = workflows.find((entry) => entry.name === name);
    assert.match(workflow.text, /test -n "\$TAURI_SIGNING_PRIVATE_KEY"/u);
  }
});

test("no workflow or CI script fetches code and runs it", () => {
  const scriptsDir = path.join(root, "scripts", "ci");
  const shellScripts = readdirSync(scriptsDir)
    .filter((name) => name.endsWith(".sh"))
    .map((name) => ({
      name: `scripts/ci/${name}`,
      text: readFileSync(path.join(scriptsDir, name), "utf8"),
    }));
  const piped = /(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z|d)?sh\b/u;
  for (const source of [...workflows, ...shellScripts]) {
    assert.doesNotMatch(source.text, piped, `${source.name} pipes a download into a shell`);
    assert.doesNotMatch(source.text, /Invoke-Expression|iex\s*\(/u, `${source.name} evaluates fetched text`);
  }
  // И сами скрипты обязаны падать на первой же ошибке: молча пропущенная
  // проверка подписи хуже, чем её отсутствие.
  for (const script of shellScripts) {
    assert.match(script.text, /^set -euo pipefail$/mu, `${script.name} does not abort on failure`);
  }
});

test("the release is verified before it is promoted to latest", () => {
  const finalize = workflows.find((workflow) => workflow.name === "release-finalize.yml");
  const stepNames = finalize.lines
    .map((line) => /^\s*-\s+name:\s*(.+)$/u.exec(line)?.[1])
    .filter(Boolean);
  const at = (name) => stepNames.indexOf(name);
  const verifyFiles = at("Normalize and verify release files");
  const verifyInventory = at("Verify uploaded asset inventory");
  const verifyDownloads = at("Verify anonymous direct downloads or restore draft");
  const promote = at("Promote verified release to stable latest");
  for (const [label, index] of [
    ["file verification", verifyFiles],
    ["inventory verification", verifyInventory],
    ["anonymous download verification", verifyDownloads],
    ["promotion", promote],
  ]) {
    assert.notEqual(index, -1, `release-finalize.yml lost its ${label} step`);
  }
  assert.ok(verifyFiles < verifyInventory, "assets are uploaded before they are verified");
  assert.ok(verifyInventory < verifyDownloads, "downloads are checked before the inventory");
  assert.ok(verifyDownloads < promote, "the release is promoted before it is verified");
});
