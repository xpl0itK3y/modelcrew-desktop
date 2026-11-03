import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Плагин opencode живёт строкой в agent_hooks.rs, а исполняется в чужом
// процессе — внутри opencode. Тесты Rust видят в нём только текст, и когда v2
// перестал его грузить, ни один из них этого не заметил. Здесь он запускается
// по-настоящему: тот же файл, что ляжет в ~/.config/opencode/plugin, против
// поддельных хозяев v1 и v2 в той форме, что описана у opencode.

const root = fileURLToPath(new URL("..", import.meta.url));
const source = fs.readFileSync(path.join(root, "src-tauri", "src", "agent_hooks.rs"), "utf8");
const opening = 'const OPENCODE_PLUGIN: &str = r#"';
const start = source.indexOf(opening) + opening.length;
const body = source.slice(start, source.indexOf('"#;', start)).replaceAll("__AGENT__", "opencode");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "modelcrew-opencode-plugin-"));
const events = path.join(scratch, "events");
fs.writeFileSync(path.join(scratch, "modelcrew-notify.mjs"), body);
process.env.MODELCREW_EVENTS_DIR = events;
process.env.MODELCREW_PANEL_ID = "panel-7";
const plugin = (await import(pathToFileURL(path.join(scratch, "modelcrew-notify.mjs")).href)).default;

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// Порядок файлов внутри одной миллисекунды решает случайный хвост имени,
// поэтому сравниваем наборы.
const sorted = (list) => list.map((entry) => JSON.stringify(entry)).sort();

function drain() {
  if (!fs.existsSync(events)) return [];
  const out = [];
  for (const name of fs.readdirSync(events)) {
    if (!name.endsWith(".json")) continue;
    const event = JSON.parse(fs.readFileSync(path.join(events, name), "utf8"));
    fs.rmSync(path.join(events, name));
    out.push([event.payload.type, event.payload.message, event.payload.session_id]);
  }
  return sorted(out);
}

// Заявка ждёт ответа рядом с собой: кладём его так, как кладёт вотчер.
async function answerClaim(decision) {
  for (let i = 0; i < 50; i++) {
    const name = fs.existsSync(events)
      ? fs.readdirSync(events).find((entry) => entry.endsWith(".json"))
      : undefined;
    if (name) {
      const request = JSON.parse(fs.readFileSync(path.join(events, name), "utf8"));
      fs.rmSync(path.join(events, name));
      fs.writeFileSync(path.join(events, name.replace(/\.json$/, ".res")), JSON.stringify({ decision }));
      return request;
    }
    await pause(10);
  }
  assert.fail("заявка так и не появилась");
}

test("one default export serves both opencode lines", () => {
  assert.equal(plugin.id, "modelcrew-notify");
  assert.equal(typeof plugin.server, "function");
  assert.equal(typeof plugin.setup, "function");
  // Вторая, именованная форма загрузилась бы у v1 рядом с этой, и каждое
  // событие пришло бы дважды.
  assert.doesNotMatch(body, /export (const|function|async function) /u);
});

test("v1 binds the main session early and ignores subagents", async () => {
  const asked = [];
  const hooks = await plugin.server({
    client: {
      session: {
        get: async ({ path: { id } }) => {
          asked.push(id);
          return { data: id === "ses_oldkid" ? { parentID: "ses_root" } : {} };
        },
      },
    },
  });
  const emit = (type, properties) => hooks.event({ event: { type, properties } });

  await emit("session.created", { info: { id: "ses_root" } });
  await emit("session.status", { sessionID: "ses_root", status: { type: "busy" } });
  await emit("session.status", { sessionID: "ses_root", status: { type: "busy" } });
  await emit("session.created", { info: { id: "ses_kid", parentID: "ses_root" } });
  await emit("session.status", { sessionID: "ses_kid", status: { type: "busy" } });
  await emit("permission.asked", { sessionID: "ses_kid", permission: "bash", patterns: ["ls", "pwd"] });
  await emit("session.idle", { sessionID: "ses_kid" });
  await emit("question.asked", { sessionID: "ses_root", questions: [{ question: "Which one?" }] });
  await emit("session.idle", { sessionID: "ses_root" });
  // Подагент, чьё создание плагин не застал, узнаётся вопросом к opencode.
  await emit("session.idle", { sessionID: "ses_oldkid" });
  await emit("session.idle", { sessionID: "not-a-session" });

  assert.deepEqual(
    drain(),
    sorted([
      ["modelcrew.session", "", "ses_root"],
      ["permission.asked", "bash: ls pwd", "ses_root"],
      ["question.asked", "Which one?", "ses_root"],
      ["session.idle", "", "ses_root"],
      ["session.idle", "", ""],
    ]),
  );
  assert.deepEqual(asked, ["ses_oldkid"]);
});

test("v1 claims the file from args.filePath and blocks on a refusal", async () => {
  const hooks = await plugin.server({});
  const call = hooks["tool.execute.before"]({ tool: "edit" }, { args: { filePath: "/p/a.txt" } });
  const request = await answerClaim("deny");
  assert.deepEqual(request, { kind: "claim", panelId: "panel-7", file: "/p/a.txt", tool: "edit" });
  await assert.rejects(call, /другой агент/u);
  // Вызов без пути не ждёт ничего.
  await hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "ls" } });
  assert.deepEqual(drain(), []);
});

function v2Host(parents = {}) {
  const queue = [];
  let wake = () => {};
  const host = {
    hook: undefined,
    types: undefined,
    push(type, data) {
      queue.push({ type, data });
      wake();
    },
    ctx: {
      session: { get: async ({ sessionID }) => ({ id: sessionID, parentID: parents[sessionID] }) },
      tool: {
        hook: async (name, callback) => {
          assert.equal(name, "execute.before");
          host.hook = callback;
          return {};
        },
      },
      event: {
        subscribe({ types, signal }) {
          host.types = types;
          return (async function* () {
            while (!signal.aborted) {
              if (queue.length) {
                yield queue.shift();
                continue;
              }
              await new Promise((done) => {
                wake = done;
                setTimeout(done, 10);
              });
            }
          })();
        },
      },
    },
  };
  return host;
}

test("v2 reads statuses and forms, and sends subagents to their parent", async () => {
  const host = v2Host({ ses_v2oldkid: "ses_v2" });
  const cleanup = await plugin.setup(host.ctx);
  assert.equal(typeof cleanup, "function");
  assert.deepEqual(host.types, ["session.created", "session.status", "permission.asked", "form.created"]);

  // Диалог открыли, но хода не было: «закончил» тут не к месту.
  host.push("session.status", { sessionID: "ses_v2", status: { type: "idle" } });
  host.push("session.created", { sessionID: "ses_v2" });
  host.push("session.status", { sessionID: "ses_v2", status: { type: "busy" } });
  host.push("session.created", { sessionID: "ses_v2kid", parentID: "ses_v2" });
  host.push("session.status", { sessionID: "ses_v2kid", status: { type: "busy" } });
  host.push("session.status", { sessionID: "ses_v2kid", status: { type: "idle" } });
  host.push("permission.asked", { id: "per_1", sessionID: "ses_v2kid", action: "bash", resources: ["git status"] });
  host.push("permission.asked", { id: "per_2", sessionID: "ses_v2", action: "edit", resources: ["a.txt"], message: "Edit a.txt?" });
  // Вопрос MCP-сервера приходит без сессии — «global».
  host.push("form.created", { form: { id: "frm_1", sessionID: "global", title: "Token?", fields: [] } });
  host.push("form.created", { form: { id: "frm_2", sessionID: "ses_v2oldkid", fields: [{ label: "Pick a color" }] } });
  host.push("session.status", { sessionID: "ses_v2", status: { type: "idle" } });
  host.push("session.status", { sessionID: "ses_v2", status: { type: "idle" } });
  await pause(200);
  cleanup();

  assert.deepEqual(
    drain(),
    sorted([
      ["modelcrew.session", "", "ses_v2"],
      ["permission.asked", "bash: git status", "ses_v2"],
      ["permission.asked", "Edit a.txt?", "ses_v2"],
      ["question.asked", "Token?", ""],
      ["question.asked", "Pick a color", "ses_v2"],
      ["session.idle", "", "ses_v2"],
    ]),
  );
});

test("v2 claims the file from input.path and blocks on a stale read", async () => {
  const host = v2Host();
  const cleanup = await plugin.setup(host.ctx);
  const call = host.hook({ tool: "write", sessionID: "ses_v2", input: { path: "/p/b.txt" } });
  const request = await answerClaim("stale");
  cleanup();
  assert.equal(request.file, "/p/b.txt");
  assert.equal(request.tool, "write");
  await assert.rejects(call, /Перечитай файл/u);
});

test("stays silent in the shared v2 service and outside a panel", async () => {
  // Общий сервер v2 живёт с окружением той панели, что его подняла.
  process.argv.push("--service");
  try {
    const host = v2Host();
    assert.equal(await plugin.setup(host.ctx), undefined);
    assert.equal(host.hook, undefined);
  } finally {
    process.argv.pop();
  }

  const panel = process.env.MODELCREW_PANEL_ID;
  delete process.env.MODELCREW_PANEL_ID;
  try {
    assert.deepEqual(await plugin.server({}), {});
    const host = v2Host();
    assert.equal(await plugin.setup(host.ctx), undefined);
    assert.equal(host.hook, undefined);
  } finally {
    process.env.MODELCREW_PANEL_ID = panel;
  }
});
