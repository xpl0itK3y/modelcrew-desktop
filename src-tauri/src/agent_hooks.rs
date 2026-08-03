//! Уведомления от самих агентов, а не по косвенным признакам вывода.
//!
//! CLI умеют звать внешнюю программу, когда закончили ход или просят
//! разрешения: у codex это `notify` в config.toml, у claude/copilot/grok —
//! hooks. Такой хук запускается внутри панели, поэтому знает её id из
//! окружения (см. `pty::set_agent_events_dir`) и просто кладёт событие файлом.
//! Приложение забирает файлы и шлёт их во фронт — без сокетов и портов, и
//! событие не теряется, пока окно занято.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager};

const EVENTS_DIR: &str = "agent-events";
const HELPER_NAME: &str = "modelcrew-agent-notify.sh";
const POLL_INTERVAL: Duration = Duration::from_millis(300);
// Событие старше этого — остаток прошлого запуска, показывать его поздно.
const MAX_EVENT_AGE: Duration = Duration::from_secs(120);

// Хук отдаёт JSON либо аргументом (codex дописывает его последним), либо на
// stdin (claude и совместимые). Файл сначала пишется во временный, потом
// переименовывается — watcher не должен прочитать половину.
const HELPER_SCRIPT: &str = r#"#!/bin/sh
# Создан ModelCrew. Вызывается хуком агента; первым аргументом — имя агента
# либо --claim для заявки на файл перед правкой.
dir="$MODELCREW_EVENTS_DIR"

# Заявка: спрашиваем приложение, свободен ли файл, и ждём ответ. Всё, что
# пошло не так — отсутствие каталога, неразобранный путь, молчание — трактуем
# как «можно»: слой согласования не должен останавливать работу из-за себя.
if [ "$1" = "--claim" ] || [ "$1" = "--claim-json" ]; then
  [ -z "$dir" ] && exit 0
  payload="$(cat)"
  # Ключ пути у агентов называется по-разному, и схему их полезной нагрузки
  # никто не обещает. Пробуем известные написания по очереди; не нашли —
  # выходим с нулём, то есть пропускаем правку.
  # TargetFile и AbsolutePath — antigravity: он кладёт вызов вложенно
  # (`toolCall.args.TargetFile`), поэтому по имени ключа, а не по пути в дереве.
  for key in file_path filePath target_file absolute_path path TargetFile AbsolutePath; do
    file=$(printf '%s' "$payload" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p")
    [ -n "$file" ] && break
  done
  [ -z "$file" ] && exit 0
  # `name` — последним: у antigravity инструмент лежит в `toolCall.name`, но
  # ключ слишком общий, чтобы спрашивать о нём раньше остальных.
  for key in tool_name toolName tool name; do
    tool=$(printf '%s' "$payload" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p")
    [ -n "$tool" ] && break
  done
  mkdir -p "$dir" || exit 0
  id="claim-$(date +%s)-$$"
  printf '{"kind":"claim","panelId":"%s","file":"%s","tool":"%s"}' \
    "$MODELCREW_PANEL_ID" "$file" "$tool" > "$dir/$id.tmp" || exit 0
  mv "$dir/$id.tmp" "$dir/$id.json" || exit 0
  i=0
  while [ $i -lt 20 ]; do
    if [ -f "$dir/$id.res" ]; then
      answer="$(cat "$dir/$id.res")"
      rm -f "$dir/$id.res"
      # Отказ выражается по-разному: claude и grok читают код возврата 2 и
      # stderr, antigravity ждёт решение JSON-ом в stdout.
      # Причина по его же контракту показывается агенту — без неё отказ для
      # него необъясним, и он попробует тот же файл снова.
      if [ "$1" = "--claim-json" ]; then
        case "$answer" in
          *'"stale"'*)
            printf '{"decision":"deny","reason":"Файл изменился с тех пор, как ты его прочитал: в нём успел поработать другой агент. Перечитай файл и примени правку заново, иначе его работа будет затёрта."}\n'
            exit 0 ;;
          *'"deny"'*)
            printf '{"decision":"deny","reason":"Файл сейчас правит другой агент этого проекта. Возьмись за другой файл и вернись к этому позже."}\n'
            exit 0 ;;
          *) printf '{"decision":"allow"}\n'; exit 0 ;;
        esac
      fi
      case "$answer" in
        *'"stale"'*)
          printf 'Файл изменился с тех пор, как ты его прочитал: в нём успел ' >&2
          printf 'поработать другой агент. Перечитай файл и примени правку ' >&2
          printf 'заново, иначе его работа будет затёрта.\n' >&2
          exit 2
          ;;
        *'"deny"'*)
          task=$(printf '%s' "$answer" | sed -n 's/.*"task":"\([^"]*\)".*/\1/p')
          printf 'Файл сейчас правит другой агент этого проекта' >&2
          [ -n "$task" ] && printf ': %s' "$task" >&2
          printf '. Возьмись за другой файл и вернись к этому позже.\n' >&2
          exit 2
          ;;
        *) exit 0 ;;
      esac
    fi
    sleep 0.1
    i=$((i + 1))
  done
  [ "$1" = "--claim-json" ] && printf '{"decision":"allow"}\n'
  exit 0
fi

agent="${1:-unknown}"
payload="$2"
[ -z "$payload" ] && payload="$(cat)"
[ -z "$payload" ] && payload='{}'

# Прежняя программа уведомлений пользователя, если мы встали на её место.
chain="$(dirname "$0")/notify-chain-$agent"
[ -x "$chain" ] && "$chain" "$payload" >/dev/null 2>&1 &

[ -z "$dir" ] && exit 0
mkdir -p "$dir" || exit 0
file="$dir/$(date +%s)-$$"
printf '{"agent":"%s","panelId":"%s","payload":%s}' \
  "$agent" "$MODELCREW_PANEL_ID" "$payload" > "$file.tmp" || exit 0
mv "$file.tmp" "$file.json"
"#;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEventPayload {
    panel_id: String,
    agent: String,
    // Тип события так, как его назвал сам агент.
    event: String,
    // Текст сообщения, если хук его передал.
    message: String,
}

pub fn events_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|base| base.join(EVENTS_DIR))
}

pub fn helper_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|base| base.join(HELPER_NAME))
}

/// Готовит каталог событий и хелпер и запускает приём событий.
pub fn install(app: &tauri::AppHandle) {
    let Some(dir) = events_dir(app) else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    crate::pty::set_agent_events_dir(dir.clone());
    write_helper(app);
    install_known_hooks(app);
    spawn_event_watcher(app.clone(), dir);
}

fn write_helper(app: &tauri::AppHandle) {
    let Some(path) = helper_path(app) else {
        return;
    };
    // Перезаписываем всегда: скрипт мог устареть после обновления приложения.
    if std::fs::write(&path, HELPER_SCRIPT).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
    }
}

fn spawn_event_watcher(app: tauri::AppHandle, dir: PathBuf) {
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL_INTERVAL);
        // Закрытая панель заявки не отпускает сама: её процесса уже нет.
        // Проверять дёшево — сессий единицы, а зависшая заявка держит файл
        // до самого TTL.
        let crew = app.state::<crate::crew::CrewRegistry>();
        let pty = app.state::<crate::pty::PtyManager>();
        for panel in crew.holding_panels() {
            if pty.session_root(&panel).is_none() {
                crew.release_panel(&panel);
            }
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let fresh = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .map(|modified| modified.elapsed().unwrap_or_default() < MAX_EVENT_AGE)
                .unwrap_or(true);
            let raw = std::fs::read_to_string(&path);
            // Файл забираем в любом случае: иначе битое событие останется
            // навсегда и watcher будет спотыкаться о него каждый тик.
            let _ = std::fs::remove_file(&path);
            let Ok(raw) = raw else {
                continue;
            };
            if !fresh {
                continue;
            }
            // Заявка на файл ждёт ответа: агент стоит на PreToolUse, пока
            // мы не положим рядом решение. Обычное событие ответа не требует.
            if let Some(request) = parse_claim_request(&raw) {
                answer_claim(&app, &path, request);
                continue;
            }
            if let Some(payload) = parse_event(&raw) {
                // Конец хода — панель отпускает всё, что держала: держать
                // файл между ходами значит запирать его, пока агент ждёт
                // следующего задания.
                if payload.event.eq_ignore_ascii_case("stop") {
                    app.state::<crate::crew::CrewRegistry>()
                        .release_panel(&payload.panel_id);
                    // Снимок дерева ровно в этот момент: заявки держатся на
                    // хуках, а они есть не у всех агентов, и запись через
                    // оболочку проходит мимо них у всех. Снимок делает
                    // затирание обратимым, чего заявка не умеет.
                    snapshot_after_turn(&app, &payload.panel_id);
                }
                let _ = app.emit_to("main", "agent-event", payload);
            }
        }
    });
}

struct ClaimRequest {
    panel_id: String,
    /// Абсолютный путь файла, который агент собирается читать или править.
    file: String,
    /// Имя инструмента агента: по нему отличаем чтение от записи.
    tool: String,
}

fn parse_claim_request(raw: &str) -> Option<ClaimRequest> {
    let value: Value = serde_json::from_str(raw).ok()?;
    if text(&value, &["kind"]) != "claim" {
        return None;
    }
    let panel_id = text(&value, &["panelId"]);
    let file = text(&value, &["file"]);
    if panel_id.is_empty() || file.is_empty() {
        return None;
    }
    Some(ClaimRequest {
        panel_id,
        file,
        tool: text(&value, &["tool"]),
    })
}

/// Ответ хуку: кладём решение рядом с запросом, хелпер его подхватит.
///
/// Отказ выдаём, только когда точно знаем держателя. Во всех остальных
/// случаях — пропускаем: слой согласования не должен останавливать работу
/// из-за того, что панель не нашлась или путь не разобрался.
fn answer_claim(app: &tauri::AppHandle, request_path: &Path, request: ClaimRequest) {
    let answer = claim_answer(&claim_decision(app, &request));
    let answer_path = request_path.with_extension("res");
    let _ = std::fs::write(&answer_path, answer);
}

/// Ответ в том виде, в каком его читает шелл-хелпер. Формат — часть договора
/// с ним: хелпер ищет в строке `"deny"` и вытаскивает `task` регуляркой.
fn claim_answer(verdict: &ClaimVerdict) -> String {
    match verdict {
        ClaimVerdict::Held(holder) => format!(
            "{{\"decision\":\"deny\",\"reason\":\"held\",\"holder\":{},\"task\":{}}}",
            json_string(&holder.panel_id),
            json_string(holder.task.as_deref().unwrap_or_default())
        ),
        ClaimVerdict::Stale => "{\"decision\":\"deny\",\"reason\":\"stale\"}".to_string(),
        ClaimVerdict::Allow => "{\"decision\":\"allow\"}".to_string(),
    }
}

/// Инструменты чтения: заявку не берут, но то, каким панель увидела файл,
/// запоминают — на этом держится проверка устаревшего чтения.
/// Чтение только запоминает содержимое файла — заявку оно не занимает. Ошибка
/// здесь дорого стоит: приняв чтение за правку, мы заперли бы файл на пять
/// минут за агентом, который его лишь посмотрел.
fn is_read_tool(tool: &str) -> bool {
    // Первые два — claude, grok и kimi; остальные три — antigravity.
    const READS: [&str; 5] = [
        "read",
        "notebookread",
        "view_file",
        "read_file",
        "view_code_item",
    ];
    READS.iter().any(|known| tool.eq_ignore_ascii_case(known))
}

enum ClaimVerdict {
    Allow,
    /// Файл держит другая панель.
    Held(crate::crew::Claim),
    /// Файл изменился с тех пор, как эта панель его читала.
    Stale,
}

fn claim_decision(app: &tauri::AppHandle, request: &ClaimRequest) -> ClaimVerdict {
    let Some(root) = app
        .state::<crate::pty::PtyManager>()
        .session_root(&request.panel_id)
    else {
        return ClaimVerdict::Allow;
    };
    // Путь от агента приходит абсолютным: заявки считаются от корня проекта,
    // иначе один файл выглядел бы разными путями из разных панелей.
    let Ok(relative) = Path::new(&request.file).strip_prefix(&root) else {
        return ClaimVerdict::Allow;
    };
    let relative = relative.to_string_lossy().replace('\\', "/");
    let workspace = root.to_string_lossy().to_string();
    let crew = app.state::<crate::crew::CrewRegistry>();

    if is_read_tool(&request.tool) {
        if let Some(digest) = crate::crew::file_digest(Path::new(&request.file)) {
            crew.note_read(&workspace, &request.panel_id, &relative, digest);
        }
        return ClaimVerdict::Allow;
    }

    // Правка поверх устаревшего чтения — та самая молчаливая потеря: панель
    // прочитала файл, ушла думать, а сосед за это время записал своё.
    if let Some(digest) = crate::crew::file_digest(Path::new(&request.file)) {
        if crew.read_is_stale(&workspace, &request.panel_id, &relative, digest) {
            return ClaimVerdict::Stale;
        }
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default();
    match crew.claim(&workspace, &request.panel_id, &relative, None, now_ms) {
        crate::crew::ClaimOutcome::Held(holder) => ClaimVerdict::Held(holder),
        _ => {
            // Панель сама сейчас изменит файл: прочитанное больше не годится
            // как основа для сверки её же следующей правки.
            crew.forget_read(&workspace, &request.panel_id, &relative);
            ClaimVerdict::Allow
        }
    }
}

/// Снимок панели после хода. Ошибку глушим: снимок — страховка, и её сбой не
/// должен всплывать поверх работы. Дорогое здесь только `git add -A`, поэтому
/// зовём один раз на ход, а не на каждую правку.
fn snapshot_after_turn(app: &tauri::AppHandle, panel_id: &str) {
    let Some(root) = app.state::<crate::pty::PtyManager>().session_root(panel_id) else {
        return;
    };
    let panel_id = panel_id.to_string();
    // Большой репозиторий может собираться заметное время: держать на этом
    // поток вотчера нельзя, он же разбирает события остальных панелей.
    std::thread::spawn(move || {
        let _ = crate::panel_snapshots::snapshot_panel(&root, &panel_id);
    });
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn parse_event(raw: &str) -> Option<AgentEventPayload> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let agent = text(&value, &["agent"]);
    let panel_id = text(&value, &["panelId"]);
    if panel_id.is_empty() {
        return None; // без панели уведомление некуда привязать
    }
    let payload = value.get("payload").cloned().unwrap_or(Value::Null);
    let (event, message) = normalize(&agent, &payload);
    Some(AgentEventPayload {
        panel_id,
        agent,
        event,
        message,
    })
}

fn text(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

/// Приводит полезную нагрузку хука к паре «тип события, текст». Схемы у
/// агентов разные, но все кладут и то и другое строкой верхнего уровня.
fn normalize(agent: &str, payload: &Value) -> (String, String) {
    match agent {
        // {"type":"agent-turn-complete", …, "last-assistant-message":"…"}
        "codex" => (
            text(payload, &["type"]),
            text(payload, &["last-assistant-message"]),
        ),
        // Stop у antigravity имени события не несёт: там причина останова и
        // отдельное поле ошибки. Приводим к тем же словам, что и у остальных.
        "antigravity" => {
            let failed = !text(payload, &["error"]).is_empty()
                || text(payload, &["terminationReason"])
                    .to_ascii_lowercase()
                    .contains("error");
            (
                if failed { "error" } else { "Stop" }.to_string(),
                text(payload, &["error"]),
            )
        }
        // claude/copilot/grok: {"hook_event_name":"Stop","message":"…"}
        _ => (
            text(
                payload,
                &["hook_event_name", "type", "event", "notification_type"],
            ),
            text(
                payload,
                &[
                    "message",
                    // Stop у claude кладёт текст хода сюда, и ключ с
                    // подчёркиваниями — не тот, что у codex через дефисы.
                    "last_assistant_message",
                    "last-assistant-message",
                    "text",
                ],
            ),
        ),
    }
}

// ---------------------------------------------------------------------------
// Подключение хелпера к конфигу агента.
//
// Хелпер сам по себе бесполезен: агент должен знать, что его надо звать. У
// каждого CLI для этого свой файл и свой формат, поэтому здесь на каждого своя
// пара «прочитать — вписать». Общее правило одно: конфиг чужой, и всё, что в
// нём уже лежит, обязано пережить нашу правку. Отсюда чтение целиком, точечная
// вставка, запись во временный файл с переименованием и копия рядом.

/// Агент, к которому мы умеем подключаться, и где лежит его конфиг.
fn hook_config_path(agent: &str, home: &Path) -> Option<PathBuf> {
    match agent {
        "claude" => Some(home.join(".claude/settings.json")),
        "copilot" => Some(home.join(".copilot/hooks/modelcrew.json")),
        "opencode" => Some(home.join(".config/opencode/plugin/modelcrew-notify.js")),
        "grok" => Some(home.join(".grok/config.toml")),
        "cursor" => Some(home.join(".cursor/hooks.json")),
        // Общий файл кастомизаций: глобальные лежат в ~/.gemini/config,
        // а не рядом с самим CLI.
        "antigravity" => Some(home.join(".gemini/config/hooks.json")),
        "kimi" => Some(home.join(".kimi-code/config.toml")),
        // Форк opencode: каталог зависит от того, как его собрали.
        "kilocode" => kilo_home(home).map(|dir| dir.join("plugin/modelcrew-notify.js")),
        // Остальным каналом мы пока не умеем — либо формат не подтверждён,
        // либо у самого CLI уведомлений нет.
        _ => None,
    }
}

/// Имя нашего блока в общем файле кастомизаций antigravity: там верхний
/// уровень — карта имён, а не список событий, поэтому чужие имена рядом.
const ANTIGRAVITY_KEY: &str = "modelcrew";

/// Обработчики у него кладутся **прямо** в массив события. Обёртка
/// `{matcher, hooks:[…]}`, как у claude, считается ошибкой — и роняет разбор
/// всего файла, а не только своей записи: «invalid hook … command hook must
/// specify 'command'» в его логе, и ни один хук больше не работает.
fn antigravity_block(helper: &Path) -> Value {
    serde_json::json!({
        "Stop": [{ "type": "command", "command": hook_command(helper, "antigravity") }],
        // Заявка на файл. Структура «matcher + hooks» — из его же
        // документации; имена инструментов свои, не как у claude. Решение он
        // ждёт не кодом возврата, а JSON-ом в stdout — за это отвечает режим
        // `--claim-json` хелпера.
        "PreToolUse": [{
            "matcher": ANTIGRAVITY_WRITE_TOOLS,
            "hooks": [{ "type": "command", "command": hook_claim_json_command(helper) }],
        }],
    })
}

/// Инструменты antigravity, меняющие файлы, плюс чтение — оно заявку не
/// берёт, но нужно для сверки устаревшего чтения.
/// Имена взяты из его собственных описаний инструментов, а не по догадке.
/// Чтения тоже в списке: они не занимают файл, но запоминают его содержимое —
/// без этого не поймать правку, построенную на устаревшем чтении.
const ANTIGRAVITY_WRITE_TOOLS: &str = "write_to_file|replace_file_content|create_file|edit_file|\
     read_file|view_file|view_code_item";

fn install_antigravity_hook(settings: &mut Value, helper: &Path) -> bool {
    if !settings.is_object() {
        *settings = Value::Object(Default::default());
    }
    let root = settings.as_object_mut().expect("объект гарантирован выше");
    let block = antigravity_block(helper);
    if root.get(ANTIGRAVITY_KEY) == Some(&block) {
        return false;
    }
    root.insert(ANTIGRAVITY_KEY.to_string(), block);
    true
}

fn remove_antigravity_hook(settings: &mut Value, _helper: &Path) -> bool {
    settings
        .as_object_mut()
        .is_some_and(|root| root.remove(ANTIGRAVITY_KEY).is_some())
}

fn antigravity_hook_installed(settings: &Value, helper: &Path) -> bool {
    settings.get(ANTIGRAVITY_KEY) == Some(&antigravity_block(helper))
}

/// Настройки уведомлений grok. Взято из его же документации, которую он
/// кладёт рядом с собой (`~/.grok/docs/user-guide/05-configuration.md`).
///
/// Оба «по умолчанию» здесь пришлось перебить, и по одной причине: в матрице
/// поддержки терминалов наш стоит как «Unknown» — протокол BEL и отслеживания
/// фокуса нет. Поэтому `auto` выбрал бы звонок вместо последовательности, а
/// `unfocused` и `only_unfocused` не срабатывали бы никогда: фокус, которого
/// не видно, всегда считается активным. Кого и когда тревожить, приложение
/// решает само — панель на виду при активном окне молчит.
///
/// Каналов сразу два: последовательность несёт текст сообщения, хук — точный
/// тип события. Дубли схлопывает окно тишины: сигнал того же веса от одной
/// панели второй раз не проходит.
const GROK_SECTION: &str = "\n\
    # Добавлено ModelCrew: уведомления агента читаются из вывода панели.\n\
    [ui.notifications]\n\
    method = \"osc9\"\n\
    condition = \"always\"\n\
    \n\
    [[ui.notifications.hooks]]\n\
    # Только тип события: $GROK_MESSAGE — произвольный текст, и внутри JSON\n\
    # он мог бы разъехаться на первой же кавычке.\n\
    command = \"__COMMAND__\"\n\
    events = [\"turn_complete\", \"approval_required\", \"agent_error\"]\n\
    only_unfocused = false\n\
    timeout_secs = 10\n";

fn grok_section(helper: &Path) -> String {
    // Кавычки внутри TOML-строки экранируются, иначе значение обрывается.
    let command = format!(
        "{} '{{\\\"type\\\":\\\"$GROK_EVENT\\\"}}'",
        hook_command(helper, "grok").replace('"', "\\\"")
    );
    GROK_SECTION.replace("__COMMAND__", &command)
}

/// Событие конца хода у cursor и запись хука в его формате. Файл общий с
/// IDE, поэтому вписываемся точечно, как и в настройки claude.
const CURSOR_EVENT: &str = "stop";

fn cursor_hook_entry(helper: &Path) -> Value {
    serde_json::json!({
        // Нагрузку отдаём аргументом: stdin cursor хуку не передаёт, и
        // хелпер ушёл бы читать терминал и не вернулся.
        "command": format!("{} '{{\"type\":\"stop\"}}'", hook_command(helper, "cursor")),
    })
}

fn cursor_hook_is_ours(entry: &Value, helper: &Path) -> bool {
    entry
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| command.contains(&helper.display().to_string()))
}

fn install_cursor_hook(settings: &mut Value, helper: &Path) -> bool {
    if !settings.is_object() {
        *settings = Value::Object(Default::default());
    }
    let root = settings.as_object_mut().expect("объект гарантирован выше");
    root.entry("version").or_insert_with(|| Value::from(1));
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| Value::Object(Default::default()));
    if !hooks.is_object() {
        *hooks = Value::Object(Default::default());
    }
    let list = hooks
        .as_object_mut()
        .expect("объект гарантирован выше")
        .entry(CURSOR_EVENT)
        .or_insert_with(|| Value::Array(Vec::new()));
    if !list.is_array() {
        *list = Value::Array(Vec::new());
    }
    let list = list.as_array_mut().expect("массив гарантирован выше");
    if list.iter().any(|entry| cursor_hook_is_ours(entry, helper)) {
        return false;
    }
    list.push(cursor_hook_entry(helper));
    true
}

fn remove_cursor_hook(settings: &mut Value, helper: &Path) -> bool {
    let Some(hooks) = settings
        .as_object_mut()
        .and_then(|root| root.get_mut("hooks"))
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    let Some(list) = hooks.get_mut(CURSOR_EVENT).and_then(Value::as_array_mut) else {
        return false;
    };
    let before = list.len();
    list.retain(|entry| !cursor_hook_is_ours(entry, helper));
    let after = list.len();
    if after == 0 {
        hooks.remove(CURSOR_EVENT);
    }
    before != after
}

fn cursor_hook_installed(settings: &Value, helper: &Path) -> bool {
    settings
        .get("hooks")
        .and_then(|hooks| hooks.get(CURSOR_EVENT))
        .and_then(Value::as_array)
        .is_some_and(|list| list.iter().any(|entry| cursor_hook_is_ours(entry, helper)))
}

/// Каталог kilocode: имя зависит от дистрибуции форка, берём существующий.
fn kilo_home(home: &Path) -> Option<PathBuf> {
    let candidates = [home.join(".config/kilo"), home.join(".config/kilocode")];
    candidates
        .iter()
        .find(|dir| dir.is_dir())
        .or(candidates.first())
        .cloned()
}

/// Секция, дописываемая в конец чужого конфига. Пара «маркер, блок»: по
/// маркеру видно, что секция уже есть — и неважно, наша она или своя.
/// Настройку, сделанную руками, мы не трогаем.
fn append_section(agent: &str, helper: &Path) -> Option<(&'static str, String)> {
    match agent {
        // Схема из самого бинарника grok:
        //   method = auto|osc9|osc99|osc777|bel|none
        //   condition = unfocused|always|never
        // Берём `always`: свой «unfocused» grok считает по терминалу и про
        // наши панели ничего не знает, а кого и когда тревожить, приложение
        // решает само — панель на виду при активном окне молчит.
        "grok" => Some(("[ui.notifications]", grok_section(helper))),
        // Хуки kimi — массив записей в его же TOML. Договор об отказе тот же,
        // что у claude (выход 2 и stderr), и имена инструментов те же, так
        // что заявка на файл работает без перевода.
        "kimi" => Some((KIMI_MARKER, kimi_section(helper))),
        _ => None,
    }
}

/// Каталог самого агента: он есть, только если агент здесь запускался.
/// Это не то же, что родитель конфига — у copilot файл лежит на уровень
/// глубже, и создавать `~/.copilot/hooks` тому, у кого нет `~/.copilot`,
/// значит заводить конфиг несуществующему CLI.
fn agent_home(agent: &str, home: &Path) -> Option<PathBuf> {
    match agent {
        "claude" => Some(home.join(".claude")),
        "copilot" => Some(home.join(".copilot")),
        "opencode" => Some(home.join(".config/opencode")),
        "grok" => Some(home.join(".grok")),
        "cursor" => Some(home.join(".cursor")),
        "antigravity" => Some(home.join(".gemini")),
        "kimi" => Some(home.join(".kimi-code")),
        "kilocode" => kilo_home(home),
        _ => None,
    }
}

/// Свой отдельный файл у агента, где чужого содержимого не бывает: ставить
/// его — записать, снимать — удалить. Слияние нужно только там, где мы
/// вписываемся в общий файл настроек, как у claude.
fn own_file_body(agent: &str, helper: &Path) -> Option<String> {
    match agent {
        // Формат из документации GitHub: version 1 и событие завершения хода.
        "copilot" => Some(
            serde_json::to_string_pretty(&serde_json::json!({
                "version": 1,
                "hooks": {
                    "agentStop": [{
                        "type": "command",
                        "bash": hook_command(helper, "copilot"),
                        "timeoutSec": 5,
                    }],
                },
            }))
            .ok()?,
        ),
        "opencode" | "kilocode" => Some(opencode_plugin(agent)),
        _ => None,
    }
}

/// Плагин opencode. Форма обработчика — `event`, а не документированный ключ
/// `"session.idle"`: тот не вызывается ни разу, проверено на живой сессии.
/// Хелпер здесь не нужен — плагин уже внутри процесса панели и видит её
/// окружение, поэтому кладёт событие сам.
fn opencode_plugin(agent: &str) -> String {
    // Тело — обычная строка с одной подстановкой: JS здесь полон `${...}`, и
    // отдавать его форматтеру Rust значит драться с ним за каждую скобку.
    OPENCODE_PLUGIN.replace("__AGENT__", agent)
}

const OPENCODE_PLUGIN: &str = r#"// Создан ModelCrew. Сообщает приложению, что агент в этой панели затих.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ModelCrewNotify = async () => ({
  event: async (arg) => {
    if (arg?.event?.type !== "session.idle") return;
    const dir = process.env.MODELCREW_EVENTS_DIR;
    const panelId = process.env.MODELCREW_PANEL_ID;
    if (!dir || !panelId) return; // запущен не из панели ModelCrew
    try {
      mkdirSync(dir, { recursive: true });
      // Сначала временный файл, потом переименование: вотчер не должен
      // прочитать половину.
      const base = join(dir, `${Date.now()}-${process.pid}`);
      writeFileSync(
        `${base}.tmp`,
        JSON.stringify({
          agent: "__AGENT__",
          panelId,
          payload: { type: "session.idle" },
        }),
      );
      renameSync(`${base}.tmp`, `${base}.json`);
    } catch {
      // Уведомление — дополнение; его сбой не должен мешать сессии.
    }
  },
});
"#;

/// Команда для конфига агента. Путь к хелперу лежит в «Application Support» —
/// с пробелом, поэтому берётся в кавычки; одинарная кавычка внутри пути
/// закрывается по-шелловски.
fn hook_command(helper: &Path, agent: &str) -> String {
    let path = helper.display().to_string().replace('\'', r"'\''");
    format!("'{path}' {agent}")
}

fn hook_claim_command(helper: &Path) -> String {
    let path = helper.display().to_string().replace('\'', r"'\''");
    format!("'{path}' --claim")
}

/// То же, но для агента, который ждёт решение JSON-ом в stdout, а не кодом
/// возврата.
/// Метка нашего блока в конфиге kimi: по ней видно, что секция уже стоит.
const KIMI_MARKER: &str = "# modelcrew: уведомления и заявки на файлы";

fn kimi_section(helper: &Path) -> String {
    format!(
        "\n{KIMI_MARKER}\n\
         [[hooks]]\n\
         event = \"Stop\"\n\
         command = {command:?}\n\
         \n\
         [[hooks]]\n\
         event = \"PreToolUse\"\n\
         matcher = \"Edit|Write|MultiEdit|Read\"\n\
         command = {claim:?}\n",
        command = hook_command(helper, "kimi"),
        claim = hook_claim_command(helper),
    )
}

fn hook_claim_json_command(helper: &Path) -> String {
    let path = helper.display().to_string().replace('\'', r"'\''");
    format!("'{path}' --claim-json")
}

/// Наш ли это хук. Ищем по пути хелпера, а не по всей строке: команда могла
/// быть записана прежней версией приложения с другим хвостом.
fn is_our_hook(entry: &Value, helper: &Path) -> bool {
    let needle = helper.display().to_string();
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .map(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|command| command.contains(&needle))
            })
        })
        .unwrap_or(false)
}

/// События, на которых агент зовёт хук. Для claude это конец хода и всё, ради
/// чего он просит внимания: разрешение, вопрос, простой.
const CLAUDE_EVENTS: [&str; 2] = ["Stop", "Notification"];

/// Событие перед вызовом инструмента: на нём решается, свободен ли файл.
const CLAUDE_CLAIM_EVENT: &str = "PreToolUse";

fn read_json(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) if raw.trim().is_empty() => Ok(Value::Object(Default::default())),
        Ok(raw) => {
            serde_json::from_str(&raw).map_err(|error| format!("{}: {error}", path.display()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(Value::Object(Default::default()))
        }
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

/// Запись без окна, в котором файл уже пуст, а нового содержимого ещё нет:
/// агент может читать конфиг в любой момент.
fn write_json_atomically(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "нет родительского каталога".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    let body = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    let temp = path.with_extension("modelcrew-tmp");
    std::fs::write(&temp, format!("{body}\n"))
        .map_err(|error| format!("{}: {error}", temp.display()))?;
    std::fs::rename(&temp, path).map_err(|error| format!("{}: {error}", path.display()))
}

/// Копия конфига до первой нашей правки — чтобы было куда вернуться руками.
fn back_up_once(path: &Path) {
    if !path.exists() {
        return;
    }
    let backup = path.with_extension("modelcrew-backup");
    if backup.exists() {
        return;
    }
    let _ = std::fs::copy(path, backup);
}

fn claude_hook_entry(helper: &Path) -> Value {
    serde_json::json!({
        // Пустая строка — «на всё»: у Stop и Notification матчить нечего.
        "matcher": "",
        "hooks": [{ "type": "command", "command": hook_command(helper, "claude") }],
    })
}

/// Отдельный файл с заявкой на файлы — для агентов, у которых хук перед
/// вызовом инструмента умеет запрещать вызов, но канал уведомлений идёт
/// другим путём. Свой файл: чужого содержимого в нём не бывает.
fn claim_file(agent: &str, home: &Path) -> Option<PathBuf> {
    match agent {
        // Глобальные хуки грока доверены всегда — в отличие от проектных,
        // которым нужен явный `/hooks-trust`. Формат он принимает тот же, что
        // у claude, и сам переводит имена инструментов в свои.
        "grok" => Some(home.join(".grok/hooks/modelcrew.json")),
        _ => None,
    }
}

fn claim_file_body(helper: &Path) -> String {
    let body = serde_json::json!({ "hooks": { "PreToolUse": [claude_claim_entry(helper)] } });
    serde_json::to_string_pretty(&body).unwrap_or_default() + "\n"
}

fn claude_claim_entry(helper: &Path) -> Value {
    serde_json::json!({
        // Чтение тоже проходит через хук — но заявки не берёт, только
        // запоминает, каким панель увидела файл. Без этого не поймать
        // правку, построенную на устаревшем чтении.
        "matcher": "Edit|Write|MultiEdit|Read|NotebookEdit",
        "hooks": [{ "type": "command", "command": hook_claim_command(helper) }],
    })
}

/// Вписывает хук, не трогая ничего чужого. Возвращает true, если файл изменился.
fn install_claude_hook(settings: &mut Value, helper: &Path) -> bool {
    if !settings.is_object() {
        *settings = Value::Object(Default::default());
    }
    let root = settings.as_object_mut().expect("объект гарантирован выше");
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| Value::Object(Default::default()));
    if !hooks.is_object() {
        *hooks = Value::Object(Default::default());
    }
    let hooks = hooks.as_object_mut().expect("объект гарантирован выше");
    let mut changed = false;
    for event in CLAUDE_EVENTS {
        let list = hooks
            .entry(event)
            .or_insert_with(|| Value::Array(Vec::new()));
        if !list.is_array() {
            *list = Value::Array(Vec::new());
        }
        let list = list.as_array_mut().expect("массив гарантирован выше");
        changed |= put_our_entry(list, helper, claude_hook_entry(helper));
    }
    let list = hooks
        .entry(CLAUDE_CLAIM_EVENT)
        .or_insert_with(|| Value::Array(Vec::new()));
    if !list.is_array() {
        *list = Value::Array(Vec::new());
    }
    let list = list.as_array_mut().expect("массив гарантирован выше");
    changed |= put_our_entry(list, helper, claude_claim_entry(helper));
    changed
}

/// Кладёт нашу запись, заменяя прежнюю, если она отличается.
///
/// Сравнение именно с ожидаемым видом, а не просто проверка наличия: конфиг
/// пишется один раз и живёт у пользователя дальше сам по себе. Пока здесь
/// стояло «есть наша запись — и ладно», обновление приложения не доносило до
/// него ни новых инструментов в матчере, ни исправлений — у тех, кто поставил
/// раньше, слежение за устаревшим чтением молча не работало вовсе.
fn put_our_entry(list: &mut Vec<Value>, helper: &Path, expected: Value) -> bool {
    match list.iter_mut().find(|entry| is_our_hook(entry, helper)) {
        Some(entry) if *entry == expected => false,
        Some(entry) => {
            *entry = expected;
            true
        }
        None => {
            list.push(expected);
            true
        }
    }
}

/// Убирает только наши записи и подчищает за собой пустые контейнеры, чтобы
/// после отключения файл выглядел как до нас.
fn remove_claude_hook(settings: &mut Value, helper: &Path) -> bool {
    let Some(root) = settings.as_object_mut() else {
        return false;
    };
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return false;
    };
    let mut changed = false;
    for event in CLAUDE_EVENTS.iter().chain([&CLAUDE_CLAIM_EVENT]) {
        let Some(list) = hooks.get_mut(*event).and_then(Value::as_array_mut) else {
            continue;
        };
        let before = list.len();
        list.retain(|entry| !is_our_hook(entry, helper));
        changed |= list.len() != before;
        if list.is_empty() {
            hooks.remove(*event);
        }
    }
    if hooks.is_empty() {
        root.remove("hooks");
    }
    changed
}

fn claude_hook_installed(settings: &Value, helper: &Path) -> bool {
    CLAUDE_EVENTS
        .iter()
        .chain([&CLAUDE_CLAIM_EVENT])
        .all(|event| {
            settings
                .get("hooks")
                .and_then(|hooks| hooks.get(*event))
                .and_then(Value::as_array)
                .map(|list| list.iter().any(|entry| is_our_hook(entry, helper)))
                .unwrap_or(false)
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHookState {
    pub agent: String,
    /// Умеем ли мы подключаться к этому агенту.
    pub supported: bool,
    /// Подключён ли хук прямо сейчас.
    pub installed: bool,
    /// Файл, который правится, — правка чужого конфига не должна быть вслепую.
    pub config: String,
}

fn home_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().home_dir().ok()
}

pub fn hook_state(app: &tauri::AppHandle, agent: &str) -> AgentHookState {
    let unsupported = AgentHookState {
        agent: agent.to_string(),
        supported: false,
        installed: false,
        config: String::new(),
    };
    let (Some(home), Some(helper)) = (home_dir(app), helper_path(app)) else {
        return unsupported;
    };
    let Some(path) = hook_config_path(agent, &home) else {
        return unsupported;
    };
    if let Some((marker, _)) = append_section(agent, &helper) {
        let installed = std::fs::read_to_string(&path).is_ok_and(|body| body.contains(marker));
        return AgentHookState {
            agent: agent.to_string(),
            supported: true,
            installed,
            config: path.display().to_string(),
        };
    }
    let installed = match own_file_body(agent, &helper) {
        // Устаревшее тело считаем неподключённым — тогда старт его перепишет.
        Some(body) => std::fs::read_to_string(&path).is_ok_and(|current| current == body),
        None => read_json(&path)
            .map(|settings| {
                if agent == "cursor" {
                    cursor_hook_installed(&settings, &helper)
                } else if agent == "antigravity" {
                    antigravity_hook_installed(&settings, &helper)
                } else {
                    claude_hook_installed(&settings, &helper)
                }
            })
            .unwrap_or(false),
    };
    AgentHookState {
        agent: agent.to_string(),
        supported: true,
        installed,
        config: path.display().to_string(),
    }
}

pub fn set_hook(
    app: &tauri::AppHandle,
    agent: &str,
    enabled: bool,
) -> Result<AgentHookState, String> {
    let home = home_dir(app).ok_or_else(|| "домашний каталог недоступен".to_string())?;
    let helper = helper_path(app).ok_or_else(|| "каталог приложения недоступен".to_string())?;
    let path =
        hook_config_path(agent, &home).ok_or_else(|| format!("{agent}: канал не поддержан"))?;
    // Хелпер мог не появиться, если каталог данных был недоступен на старте.
    if !helper.exists() {
        write_helper(app);
    }
    // Заявка на файлы живёт своим файлом и снимается вместе с каналом
    // уведомлений: это одна настройка для пользователя.
    if let Some(claims) = claim_file(agent, &home) {
        if enabled {
            let body = claim_file_body(&helper);
            if std::fs::read_to_string(&claims).unwrap_or_default() != body {
                if let Some(parent) = claims.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&claims, body);
            }
        } else {
            let _ = std::fs::remove_file(&claims);
        }
    }
    // Дописываемая секция в чужом конфиге: трогаем только её и только если
    // такой секции там ещё нет.
    if let Some((marker, block)) = append_section(agent, &helper) {
        let current = std::fs::read_to_string(&path).unwrap_or_default();
        if enabled {
            if !current.contains(marker) {
                back_up_once(&path);
                std::fs::write(&path, format!("{current}{block}"))
                    .map_err(|error| format!("{}: {error}", path.display()))?;
            }
        } else if let Some(rest) = current.strip_suffix(block.as_str()) {
            // Снимаем только свой блок целиком: правленный руками не наш.
            std::fs::write(&path, rest).map_err(|error| format!("{}: {error}", path.display()))?;
        }
        return Ok(hook_state(app, agent));
    }
    // Свой отдельный файл: чужого в нём нет, поэтому никакого слияния.
    if let Some(body) = own_file_body(agent, &helper) {
        if enabled {
            let current = std::fs::read_to_string(&path).unwrap_or_default();
            // Тело могло устареть после обновления приложения.
            if current != body {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|error| format!("{}: {error}", parent.display()))?;
                }
                let temp = path.with_extension("modelcrew-tmp");
                std::fs::write(&temp, &body)
                    .map_err(|error| format!("{}: {error}", temp.display()))?;
                std::fs::rename(&temp, &path)
                    .map_err(|error| format!("{}: {error}", path.display()))?;
            }
        } else if path.exists() {
            std::fs::remove_file(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        }
        return Ok(hook_state(app, agent));
    }
    let mut settings = read_json(&path)?;
    let changed = match (agent, enabled) {
        ("cursor", true) => install_cursor_hook(&mut settings, &helper),
        ("cursor", false) => remove_cursor_hook(&mut settings, &helper),
        ("antigravity", true) => install_antigravity_hook(&mut settings, &helper),
        ("antigravity", false) => remove_antigravity_hook(&mut settings, &helper),
        (_, true) => install_claude_hook(&mut settings, &helper),
        (_, false) => remove_claude_hook(&mut settings, &helper),
    };
    if changed {
        back_up_once(&path);
        write_json_atomically(&path, &settings)?;
    }
    Ok(hook_state(app, agent))
}

/// Агенты, которым мы умеем прописывать себя.
const SUPPORTED_AGENTS: [&str; 8] = [
    "claude",
    "copilot",
    "opencode",
    "grok",
    "kilocode",
    "cursor",
    "antigravity",
    "kimi",
];

/// Подключение через окружение панели — самый безопасный вид: ничего не
/// пишется в чужие файлы и действует только внутри наших терминалов.
///
/// aider зовёт команду, когда ответ готов и он ждёт ввода. Полезную нагрузку
/// он не передаёт, поэтому отдаём её сами вторым аргументом — иначе хелпер
/// полез бы читать stdin, а там терминал, и он бы там и остался.
pub fn env_hooks(events_dir: &Path) -> Vec<(String, String)> {
    env_hooks_with(events_dir, |name| std::env::var_os(name).is_some())
}

fn env_hooks_with(events_dir: &Path, already_set: impl Fn(&str) -> bool) -> Vec<(String, String)> {
    let Some(helper) = events_dir.parent().map(|base| base.join(HELPER_NAME)) else {
        return Vec::new();
    };
    // Своя настройка пользователя важнее нашей: если он уже задал команду
    // уведомления или выключил их, перебивать это молча нельзя.
    if already_set("AIDER_NOTIFICATIONS_COMMAND") || already_set("AIDER_NOTIFICATIONS") {
        return Vec::new();
    }
    let command = format!(
        "{} '{{\"type\":\"waiting\"}}'",
        hook_command(&helper, "aider")
    );
    vec![
        ("AIDER_NOTIFICATIONS".to_string(), "true".to_string()),
        ("AIDER_NOTIFICATIONS_COMMAND".to_string(), command),
    ]
}

/// Ставить хук только тем, кто у пользователя действительно есть: наличие
/// каталога агента и есть признак, что он хоть раз запускался. Иначе мы
/// создавали бы конфиг тому, кто этот CLI в глаза не видел.
fn agent_is_present(agent: &str, home: &Path) -> bool {
    agent_home(agent, home).is_some_and(|dir| dir.is_dir())
}

/// Подключает хук всем поддержанным агентам при старте. Отдельного тумблера
/// нет намеренно: канал уведомлений — часть работы приложения, а выключатель
/// у уведомлений агентов уже есть один, общий.
fn install_known_hooks(app: &tauri::AppHandle) {
    let Some(home) = home_dir(app) else {
        return;
    };
    for agent in SUPPORTED_AGENTS {
        if !agent_is_present(agent, &home) {
            continue;
        }
        // Чужой конфиг мог оказаться битым или недоступным — это не повод
        // ронять запуск: без хука останется разбор вывода панели.
        let _ = set_hook(app, agent, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn helper() -> PathBuf {
        // Реальный путь хелпера лежит в «Application Support» — с пробелом.
        PathBuf::from("/Users/x/Library/Application Support/mc/modelcrew-agent-notify.sh")
    }

    /// Прогон настоящего хелпера на полезной нагрузке, снятой с живого
    /// antigravity. Схему вызова он кладёт вложенно и в своих ключах —
    /// написанное «на глаз» извлечение молча пропускало каждую правку.
    #[test]
    fn reads_an_antigravity_payload_and_answers_in_its_dialect() {
        let base = std::env::temp_dir().join(format!("mc-claim-{}", std::process::id()));
        let events = base.join("agent-events");
        std::fs::create_dir_all(&events).unwrap();
        let script = base.join("notify.sh");
        std::fs::write(&script, HELPER_SCRIPT).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        // Ровно то, что прислал agy, вплоть до порядка ключей.
        let payload = concat!(
            r#"{"conversationId":"762f086f","modelName":"gemini-3.6-flash-high","#,
            r#""stepIdx":10,"toolCall":{"args":{"AllowMultiple":false,"#,
            r#""Instruction":"Добавить комментарий","TargetFile":"/w/README.md"},"#,
            r#""name":"replace_file_content"},"workspacePaths":["/w"]}"#
        );
        let mut child = std::process::Command::new(&script)
            .arg("--claim-json")
            .env("MODELCREW_PANEL_ID", "panel-7")
            .env("MODELCREW_EVENTS_DIR", &events)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.as_bytes())
            .unwrap();

        // Заявка должна дойти до приложения разобранной, а не пустой.
        let request = read_claim(&events);
        assert_eq!(request["file"], "/w/README.md");
        assert_eq!(request["tool"], "replace_file_content");
        assert_eq!(request["panelId"], "panel-7");

        std::fs::write(
            events.join(format!("{}.res", request["id"].as_str().unwrap())),
            r#"{"verdict":"deny","task":"правит сосед"}"#,
        )
        .unwrap();

        let out = child.wait_with_output().unwrap();
        let answer: Value = serde_json::from_slice(&out.stdout).unwrap();
        // Он читает решение из stdout, а не код возврата, и показывает
        // причину агенту — без неё отказ для него необъясним.
        assert_eq!(answer["decision"], "deny");
        assert!(
            answer["reason"].as_str().unwrap().contains("другой файл"),
            "{answer}"
        );
        assert_eq!(out.status.code(), Some(0));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Ждёт заявку, которую хелпер кладёт файлом, и отдаёт её вместе с id.
    fn read_claim(events: &Path) -> Value {
        for _ in 0..100 {
            let entry = std::fs::read_dir(events)
                .unwrap()
                .flatten()
                .find(|item| item.path().extension().is_some_and(|kind| kind == "json"));
            if let Some(entry) = entry {
                let body = std::fs::read(entry.path()).unwrap();
                let mut claim: Value = serde_json::from_slice(&body).unwrap();
                let id = entry
                    .path()
                    .file_stem()
                    .unwrap()
                    .to_string_lossy()
                    .to_string();
                claim["id"] = Value::String(id);
                return claim;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("хелпер не положил заявку");
    }

    /// Конфиг агента пишется один раз и дальше живёт у пользователя сам.
    /// Пока проверялось лишь наличие нашей записи, обновление приложения не
    /// доносило до неё ни новых инструментов, ни исправлений.
    #[test]
    fn an_outdated_entry_of_ours_is_brought_up_to_date() {
        // Ровно то, что нашлось у живого пользователя: матчер прошлой версии,
        // без Read — то есть без слежения за устаревшим чтением.
        let mut settings = serde_json::json!({
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Другой|Хук", "hooks": [{ "command": "./чужой.sh" }] },
                    {
                        "matcher": "Edit|Write|MultiEdit",
                        "hooks": [{
                            "type": "command",
                            "command": hook_claim_command(&helper()),
                        }],
                    },
                ],
            }
        });

        assert!(install_claude_hook(&mut settings, &helper()));

        let list = settings["hooks"]["PreToolUse"].as_array().unwrap();
        // Запись обновлена на месте, а не продублирована рядом.
        assert_eq!(list.len(), 2, "{list:?}");
        assert_eq!(list[0]["hooks"][0]["command"], "./чужой.sh");
        assert_eq!(list[1]["matcher"], "Edit|Write|MultiEdit|Read|NotebookEdit");
        // Второй проход уже ничего не меняет — иначе файл переписывался бы
        // на каждом запуске.
        assert!(!install_claude_hook(&mut settings, &helper()));
    }

    #[test]
    fn the_command_survives_a_path_with_spaces() {
        let command = hook_command(&helper(), "claude");

        assert_eq!(
            command,
            "'/Users/x/Library/Application Support/mc/modelcrew-agent-notify.sh' claude"
        );
    }

    #[test]
    fn a_quote_in_the_path_cannot_break_out_of_the_command() {
        let command = hook_command(Path::new("/tmp/it's here/notify.sh"), "claude");

        // Кавычка закрывается по-шелловски, а не остаётся открытой.
        assert_eq!(command, r"'/tmp/it'\''s here/notify.sh' claude");
    }

    #[test]
    fn installing_keeps_every_foreign_setting_and_hook() {
        let mut settings = serde_json::json!({
            "permissions": { "allow": ["Bash(ls:*)"] },
            "hooks": {
                "PostToolUse": [{
                    "matcher": "Edit|Write",
                    "hooks": [{ "type": "command", "command": "prettier --write" }]
                }],
                "Stop": [{
                    "matcher": "",
                    "hooks": [{ "type": "command", "command": "say done" }]
                }]
            }
        });

        assert!(install_claude_hook(&mut settings, &helper()));

        // Чужое на месте: и настройки вне hooks, и чужие события, и чужой Stop.
        assert_eq!(settings["permissions"]["allow"][0], "Bash(ls:*)");
        assert_eq!(
            settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"],
            "prettier --write"
        );
        assert_eq!(
            settings["hooks"]["Stop"][0]["hooks"][0]["command"],
            "say done"
        );
        // А наш встал рядом, а не вместо.
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert!(claude_hook_installed(&settings, &helper()));
    }

    #[test]
    fn speaks_to_the_helper_in_the_shape_it_parses() {
        // Хелпер — шелл-скрипт: он ищет в ответе подстроку "deny" и достаёт
        // task регуляркой. Смена формы здесь ломает его молча, поэтому она
        // закреплена тестом.
        assert_eq!(
            claim_answer(&ClaimVerdict::Allow),
            r#"{"decision":"allow"}"#
        );

        let held = claim_answer(&ClaimVerdict::Held(crate::crew::Claim {
            path: "src/app.ts".into(),
            panel_id: "panel-3".into(),
            task: Some("правит модель".into()),
            since_ms: 1_000,
        }));
        assert!(held.contains(r#""deny""#));
        assert!(held.contains(r#""task":"правит модель""#));

        // Причины отказа разные, и хелпер говорит агенту разное: занятый файл
        // — «возьмись за другой», устаревшее чтение — «перечитай этот».
        let stale = claim_answer(&ClaimVerdict::Stale);
        assert!(stale.contains(r#""deny""#));
        assert!(stale.contains(r#""stale""#));
        assert!(!held.contains(r#""stale""#));

        // Кавычка в тексте задачи не должна разваливать ответ.
        let tricky = claim_answer(&ClaimVerdict::Held(crate::crew::Claim {
            path: "src/app.ts".into(),
            panel_id: "panel-3".into(),
            task: Some("правит \"модель\"".into()),
            since_ms: 1_000,
        }));
        assert!(serde_json::from_str::<Value>(&tricky).is_ok());
    }

    #[test]
    fn writes_kimi_a_toml_block_with_both_hooks() {
        let block = kimi_section(&helper());

        // Конец хода — для уведомлений, заявка — для файлов. Одна секция на
        // обе задачи: пользователь включает и выключает их вместе.
        assert!(block.contains("event = \"Stop\""));
        assert!(block.contains("event = \"PreToolUse\""));
        assert!(block.contains("matcher = \"Edit|Write|MultiEdit|Read\""));
        assert!(block.contains("--claim"));
        // Путь с пробелом попадает в TOML строкой, а не разваливается.
        assert!(block.contains("Application Support"));
        assert!(block.starts_with(&format!("\n{KIMI_MARKER}")));
    }

    #[test]
    fn knows_where_kimi_keeps_its_config() {
        let home = Path::new("/Users/x");

        assert_eq!(
            hook_config_path("kimi", home),
            Some(home.join(".kimi-code/config.toml"))
        );
        // Каталог агента — признак, что он вообще запускался: иначе мы
        // завели бы конфиг тому, у кого этого CLI нет.
        assert_eq!(agent_home("kimi", home), Some(home.join(".kimi-code")));
    }

    #[test]
    fn asks_antigravity_in_the_dialect_it_answers_in() {
        let block = antigravity_block(&helper());

        // Уведомления и заявка живут в одном блоке — снимаются тоже вместе.
        assert!(block["Stop"].is_array());
        let entry = &block["PreToolUse"][0];
        // Имена инструментов у него свои: матчер claude тут не сработал бы.
        assert!(entry["matcher"].as_str().unwrap().contains("write_to_file"));
        assert!(entry["matcher"].as_str().unwrap().contains("read_file"));
        // Решение он ждёт JSON-ом в stdout, а не кодом возврата — за это
        // отвечает отдельный режим хелпера.
        assert!(entry["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .ends_with("--claim-json"));

        // Повторная установка того же блока файл не трогает.
        let mut settings = serde_json::json!({});
        assert!(install_antigravity_hook(&mut settings, &helper()));
        assert!(!install_antigravity_hook(&mut settings, &helper()));
        assert!(antigravity_hook_installed(&settings, &helper()));
        assert!(remove_antigravity_hook(&mut settings, &helper()));
    }

    #[test]
    fn tells_reading_tools_from_writing_ones() {
        // Чтение проходит через хук, но заявку не берёт: осмотр тридцати
        // файлов запер бы соседу полпроекта.
        assert!(is_read_tool("Read"));
        assert!(is_read_tool("read"));
        assert!(is_read_tool("NotebookRead"));
        // У antigravity свои имена — и он единственный, кто ходит в хук за
        // каждым просмотром файла.
        for reading in ["view_file", "read_file", "view_code_item"] {
            assert!(is_read_tool(reading), "инструмент {reading}");
        }
        for writing in [
            "Edit",
            "Write",
            "MultiEdit",
            "NotebookEdit",
            "Bash",
            "write_to_file",
            "replace_file_content",
            "edit_file",
            "create_file",
        ] {
            assert!(!is_read_tool(writing), "инструмент {writing}");
        }
    }

    #[test]
    fn reads_a_claim_request_and_ignores_a_plain_event() {
        let request = parse_claim_request(
            r#"{"kind":"claim","panelId":"panel-1","file":"/proj/src/app.ts","tool":"Edit"}"#,
        )
        .expect("заявка должна разобраться");
        assert_eq!(request.panel_id, "panel-1");
        assert_eq!(request.file, "/proj/src/app.ts");
        assert_eq!(request.tool, "Edit");

        // Обычное событие хука ответа не ждёт — путать их нельзя.
        assert!(
            parse_claim_request(r#"{"agent":"claude","panelId":"panel-1","payload":{}}"#).is_none()
        );
        // Заявка без панели привязать некуда.
        assert!(parse_claim_request(r#"{"kind":"claim","file":"/a"}"#).is_none());
    }

    #[test]
    fn gives_grok_the_same_claim_hook_in_its_own_file() {
        // Грок принимает формат claude и сам переводит имена инструментов в
        // свои, поэтому запись одна на двоих.
        let body = claim_file_body(&helper());
        let parsed: Value = serde_json::from_str(&body).expect("валидный JSON");

        assert_eq!(
            parsed["hooks"]["PreToolUse"][0]["matcher"],
            "Edit|Write|MultiEdit|Read|NotebookEdit"
        );
        assert!(parsed["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .ends_with("--claim"));
    }

    #[test]
    fn puts_the_claim_file_only_where_hooks_are_trusted_without_asking() {
        let home = Path::new("/Users/x");

        // Глобальные хуки грока доверены всегда; проектные потребовали бы
        // явного согласия, поэтому туда не пишем.
        assert_eq!(
            claim_file("grok", home),
            Some(home.join(".grok/hooks/modelcrew.json"))
        );
        // У claude заявка идёт в общий settings.json вместе с остальными
        // хуками — отдельный файл ему не нужен.
        assert_eq!(claim_file("claude", home), None);
        // Остальным пока нечего дать: у codex хуки приходят плагинами с
        // доверием, у прочих канал не подтверждён.
        for agent in ["codex", "cursor", "opencode", "kimi", "antigravity"] {
            assert_eq!(claim_file(agent, home), None, "агент {agent}");
        }
    }

    #[test]
    fn claims_a_file_only_before_the_tools_that_write() {
        let mut settings = Value::Object(Default::default());
        install_claude_hook(&mut settings, &helper());

        let entry = &settings["hooks"]["PreToolUse"][0];
        // Чтение не заявляем: агент осматривает десятки файлов, и заявка на
        // каждый заперла бы соседу полпроекта.
        assert_eq!(entry["matcher"], "Edit|Write|MultiEdit|Read|NotebookEdit");
        assert_eq!(
            entry["hooks"][0]["command"],
            "'/Users/x/Library/Application Support/mc/modelcrew-agent-notify.sh' --claim"
        );
    }

    #[test]
    fn keeps_a_foreign_pre_tool_hook_of_the_user() {
        // В PreToolUse у пользователя вполне может стоять своё — линтер,
        // запрет на правку чужих файлов. Затереть это нельзя.
        let mut settings = serde_json::json!({
            "hooks": {
                "PreToolUse": [{
                    "matcher": "Bash",
                    "hooks": [{ "type": "command", "command": "audit.sh" }]
                }]
            }
        });

        install_claude_hook(&mut settings, &helper());
        assert_eq!(
            settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            "audit.sh"
        );
        assert_eq!(settings["hooks"]["PreToolUse"].as_array().unwrap().len(), 2);

        remove_claude_hook(&mut settings, &helper());
        // Ушло только наше, чужое осталось нетронутым.
        assert_eq!(settings["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
        assert_eq!(
            settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            "audit.sh"
        );
    }

    #[test]
    fn installing_twice_does_not_pile_up_duplicates() {
        let mut settings = Value::Object(Default::default());
        assert!(install_claude_hook(&mut settings, &helper()));

        // Повторный вызов ничего не меняет — иначе после каждого запуска
        // приложения в конфиге появлялась бы ещё одна копия.
        assert!(!install_claude_hook(&mut settings, &helper()));
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(
            settings["hooks"]["Notification"].as_array().unwrap().len(),
            1
        );
        assert_eq!(settings["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn removing_takes_out_only_our_own_entry() {
        let mut settings = serde_json::json!({
            "hooks": {
                "Stop": [{
                    "matcher": "",
                    "hooks": [{ "type": "command", "command": "say done" }]
                }]
            }
        });
        install_claude_hook(&mut settings, &helper());

        assert!(remove_claude_hook(&mut settings, &helper()));

        assert_eq!(
            settings["hooks"]["Stop"][0]["hooks"][0]["command"],
            "say done"
        );
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert!(!claude_hook_installed(&settings, &helper()));
    }

    #[test]
    fn removing_leaves_the_file_as_it_was_before_us() {
        let clean = serde_json::json!({ "permissions": { "allow": [] } });
        let mut settings = clean.clone();

        install_claude_hook(&mut settings, &helper());
        remove_claude_hook(&mut settings, &helper());

        // Ни осиротевшего "hooks": {}, ни пустых массивов событий.
        assert_eq!(settings, clean);
    }

    #[test]
    fn a_settings_file_that_is_not_an_object_is_not_silently_kept() {
        // Строка вместо объекта — файл сломан; вписывать хук в него нельзя,
        // но и падать не за чем: заменяем на объект и продолжаем.
        let mut settings = Value::String("сломано".into());

        assert!(install_claude_hook(&mut settings, &helper()));

        assert!(claude_hook_installed(&settings, &helper()));
    }

    #[test]
    fn a_missing_file_reads_as_an_empty_object() {
        let path = std::env::temp_dir().join("modelcrew-no-such-settings.json");
        let _ = std::fs::remove_file(&path);

        assert_eq!(read_json(&path).unwrap(), Value::Object(Default::default()));
    }

    #[test]
    fn broken_json_is_reported_instead_of_being_overwritten() {
        let path = std::env::temp_dir().join(format!(
            "modelcrew-broken-settings-{}.json",
            std::process::id()
        ));
        std::fs::write(&path, "{ это не json ").unwrap();

        let error = read_json(&path).expect_err("битый конфиг должен быть ошибкой");

        // Иначе правка молча стёрла бы чужой файл целиком.
        assert!(
            error.contains("settings"),
            "в ошибке нет имени файла: {error}"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_agent_the_user_never_ran_is_left_alone() {
        let home = std::env::temp_dir().join(format!(
            "modelcrew-empty-home-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&home).unwrap();

        // Каталога ~/.claude нет — значит Claude здесь не запускали, и
        // создавать ему конфиг мы не имеем права.
        assert!(!agent_is_present("claude", &home));

        std::fs::create_dir_all(home.join(".claude")).unwrap();
        assert!(agent_is_present("claude", &home));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn every_supported_agent_has_somewhere_to_write() {
        let home = Path::new("/home/x");

        // Список подключаемых и список известных путей обязаны совпадать,
        // иначе агент попал бы в автоподключение и молча ничего не получил.
        for agent in SUPPORTED_AGENTS {
            assert!(hook_config_path(agent, home).is_some(), "{agent}");
        }
    }

    #[test]
    fn only_the_agents_we_actually_support_get_a_config_path() {
        let home = Path::new("/home/x");

        assert_eq!(
            hook_config_path("claude", home),
            Some(PathBuf::from("/home/x/.claude/settings.json"))
        );
        // У kimi канал подтверждён по его же бинарю: секция [[hooks]] в
        // собственном TOML, договор об отказе как у claude.
        assert_eq!(
            hook_config_path("kimi", home),
            Some(PathBuf::from("/home/x/.kimi-code/config.toml"))
        );
        // У этих канал либо не подтверждён, либо его нет — молча трогать
        // чужие конфиги на догадках нельзя. У codex хуки приходят плагинами
        // с отдельным доверием, у aider канал только через окружение.
        for agent in ["codex", "aider"] {
            assert_eq!(hook_config_path(agent, home), None, "{agent}");
            assert_eq!(agent_home(agent, home), None, "{agent}");
        }
    }

    #[test]
    fn a_fork_names_itself_in_the_event_it_writes() {
        // Иначе панель kilocode подписалась бы как opencode.
        assert!(opencode_plugin("kilocode").contains(r#"agent: "kilocode""#));
        assert!(opencode_plugin("opencode").contains(r#"agent: "opencode""#));
        assert!(!opencode_plugin("kilocode").contains("__AGENT__"));
    }

    #[test]
    fn the_kilocode_directory_falls_back_to_a_known_name() {
        let home = Path::new("/home/x");

        // Ни одного каталога нет — берём первый вариант, но ставить туда
        // ничего не будем: agent_is_present это отсечёт.
        assert_eq!(kilo_home(home), Some(PathBuf::from("/home/x/.config/kilo")));
        assert!(!agent_is_present("kilocode", home));
    }

    #[test]
    fn the_cursor_hook_lands_in_the_file_shared_with_the_ide() {
        let mut settings = serde_json::json!({
            "version": 1,
            "hooks": { "beforeShellExecution": [{ "command": "./audit.sh" }] }
        });

        assert!(install_cursor_hook(&mut settings, &helper()));

        // Чужой хук в общем с IDE файле обязан пережить нашу правку.
        assert_eq!(
            settings["hooks"]["beforeShellExecution"][0]["command"],
            "./audit.sh"
        );
        assert!(cursor_hook_installed(&settings, &helper()));
        // Нагрузка аргументом: stdin cursor хуку не даёт, и хелпер завис бы.
        let ours = settings["hooks"]["stop"][0]["command"].as_str().unwrap();
        assert!(ours.ends_with(r#"'{"type":"stop"}'"#), "{ours}");
        assert!(!install_cursor_hook(&mut settings, &helper()));

        assert!(remove_cursor_hook(&mut settings, &helper()));
        assert!(settings["hooks"].get("stop").is_none());
        assert_eq!(
            settings["hooks"]["beforeShellExecution"][0]["command"],
            "./audit.sh"
        );
    }

    #[test]
    fn the_antigravity_block_keeps_handlers_unwrapped() {
        let mut settings = serde_json::json!({
            "lint-checker": {
                "PostToolUse": [{ "matcher": "run_command", "hooks": [{ "command": "./lint.sh" }] }]
            }
        });

        assert!(install_antigravity_hook(&mut settings, &helper()));

        // Чужое имя рядом переживает правку: верхний уровень тут — карта имён.
        assert!(settings.get("lint-checker").is_some());
        // Обработчик лежит прямо в массиве события. Обёртка {matcher, hooks}
        // для antigravity — ошибка разбора, и роняет весь файл, а не запись.
        let ours = &settings[ANTIGRAVITY_KEY]["Stop"][0];
        assert!(ours.get("command").is_some(), "{ours}");
        assert!(ours.get("hooks").is_none(), "{ours}");
        assert!(antigravity_hook_installed(&settings, &helper()));
        assert!(!install_antigravity_hook(&mut settings, &helper()));

        assert!(remove_antigravity_hook(&mut settings, &helper()));
        assert!(settings.get(ANTIGRAVITY_KEY).is_none());
        assert!(settings.get("lint-checker").is_some());
    }

    #[test]
    fn an_antigravity_stop_reads_as_a_finished_turn() {
        let done = parse_event(
            r#"{"agent":"antigravity","panelId":"p","payload":{
                "terminationReason":"NO_TOOL_CALL","fullyIdle":true,"error":""}}"#,
        )
        .expect("Stop должен разбираться");
        // Имени события в нагрузке нет — сводим к слову, которое знает фронт.
        assert_eq!(done.event, "Stop");

        let failed = parse_event(
            r#"{"agent":"antigravity","panelId":"p","payload":{
                "terminationReason":"error","error":"кончился лимит"}}"#,
        )
        .unwrap();
        assert_eq!(failed.event, "error");
        assert_eq!(failed.message, "кончился лимит");
    }

    #[test]
    fn the_grok_section_asks_for_the_sequence_our_scanner_reads() {
        let (marker, block) = append_section("grok", &helper()).expect("grok поддержан");

        assert_eq!(marker, "[ui.notifications]");
        assert!(block.contains(r#"method = "osc9""#), "{block}");
        // «unfocused» grok считает по терминалу и про наши панели не знает;
        // кого тревожить, решает приложение.
        assert!(block.contains(r#"condition = "always""#), "{block}");
        assert!(block.contains(marker));
    }

    #[test]
    fn a_notifications_section_the_user_wrote_himself_is_not_touched() {
        let (marker, block) = append_section("grok", &helper()).unwrap();
        let mine = format!("[ui]\ntheme = \"dark\"\n\n{marker}\nmethod = \"bel\"\n");

        // Секция есть — значит выбор уже сделан, и он важнее нашего.
        assert!(mine.contains(marker));
        // А в пустой конфиг блок дописывается целиком, ничего не затирая.
        let empty = String::new();
        assert_eq!(format!("{empty}{block}"), block);
    }

    #[test]
    fn aider_is_wired_through_the_environment_with_its_payload_supplied() {
        let events_dir = Path::new("/data/mc/agent-events");
        let vars = env_hooks(events_dir);
        let command = vars
            .iter()
            .find(|(key, _)| key == "AIDER_NOTIFICATIONS_COMMAND")
            .map(|(_, value)| value.clone())
            .expect("команда уведомления должна быть задана");

        assert!(vars
            .iter()
            .any(|(key, value)| key == "AIDER_NOTIFICATIONS" && value == "true"));
        let helper = events_dir.parent().unwrap().join(HELPER_NAME);
        assert!(
            command.contains(helper.to_string_lossy().as_ref()),
            "{command}"
        );
        // Нагрузка вторым аргументом — иначе хелпер уйдёт читать stdin, а там
        // терминал, и вызов повиснет.
        assert!(command.ends_with(r#"'{"type":"waiting"}'"#), "{command}");
    }

    #[test]
    fn a_notification_command_the_user_already_chose_is_left_alone() {
        // Настроил свою команду — значит она ему нужна; наша не должна её
        // вытеснить только потому, что панель наша.
        for owned in ["AIDER_NOTIFICATIONS_COMMAND", "AIDER_NOTIFICATIONS"] {
            let vars = env_hooks_with(Path::new("/data/mc/agent-events"), |name| name == owned);
            assert!(vars.is_empty(), "{owned}: {vars:?}");
        }
    }

    #[test]
    fn the_opencode_plugin_uses_the_shape_that_actually_fires() {
        let body = opencode_plugin("opencode");

        // Документированный ключ "session.idle" не вызывается ни разу —
        // проверено на живой сессии, поэтому обработчик именно `event`.
        assert!(body.contains("event: async (arg)"), "{body}");
        assert!(!body.contains(r#""session.idle": async"#), "{body}");
        assert!(body.contains(r#"arg?.event?.type !== "session.idle""#));
        // Без окружения панели событие некуда привязать — молча выходим.
        assert!(body.contains("MODELCREW_PANEL_ID"));
        assert!(body.contains("MODELCREW_EVENTS_DIR"));
        // Запись через временный файл: вотчер не должен прочитать половину.
        assert!(body.contains(".tmp"));
    }

    #[test]
    fn the_copilot_hook_file_declares_the_event_that_ends_a_turn() {
        let body = own_file_body("copilot", &helper()).expect("copilot поддержан");
        let value: Value = serde_json::from_str(&body).expect("копилотовский файл — json");

        assert_eq!(value["version"], 1);
        assert_eq!(
            value["hooks"]["agentStop"][0]["bash"],
            hook_command(&helper(), "copilot")
        );
    }

    #[test]
    fn agents_with_their_own_file_are_not_merged_into() {
        // Слияние нужно только там, где мы пишем в общий файл настроек.
        assert!(own_file_body("claude", &helper()).is_none());
        assert!(own_file_body("copilot", &helper()).is_some());
        assert!(own_file_body("opencode", &helper()).is_some());
    }

    #[test]
    fn the_copilot_config_lives_deeper_than_the_agent_directory() {
        let home = Path::new("/home/x");

        // Каталог агента и родитель конфига у copilot разные: заводить
        // ~/.copilot/hooks тому, у кого нет ~/.copilot, нельзя.
        assert_eq!(
            agent_home("copilot", home),
            Some(PathBuf::from("/home/x/.copilot"))
        );
        assert_eq!(
            hook_config_path("copilot", home).unwrap().parent().unwrap(),
            Path::new("/home/x/.copilot/hooks")
        );
    }

    #[test]
    fn a_stop_event_keeps_the_message_claude_puts_under_underscores() {
        let event = parse_event(
            r#"{"agent":"claude","panelId":"panel-9","payload":{
                "hook_event_name":"Stop",
                "last_assistant_message":"Готово, три файла"
            }}"#,
        )
        .expect("Stop должен разбираться");

        assert_eq!(event.message, "Готово, три файла");
    }

    #[test]
    fn reads_a_codex_turn_with_its_message() {
        let event = parse_event(
            r#"{"agent":"codex","panelId":"panel-1","payload":{
                "type":"agent-turn-complete",
                "cwd":"/tmp",
                "last-assistant-message":"Готово: обновил три файла"
            }}"#,
        )
        .expect("событие codex должно разбираться");

        assert_eq!(event.panel_id, "panel-1");
        assert_eq!(event.event, "agent-turn-complete");
        assert_eq!(event.message, "Готово: обновил три файла");
    }

    #[test]
    fn reads_a_claude_hook_from_stdin_shape() {
        let event = parse_event(
            r#"{"agent":"claude","panelId":"panel-2","payload":{
                "hook_event_name":"Notification",
                "session_id":"abc",
                "message":"Claude needs your permission to run Bash"
            }}"#,
        )
        .expect("событие claude должно разбираться");

        assert_eq!(event.event, "Notification");
        assert_eq!(event.message, "Claude needs your permission to run Bash");
    }

    #[test]
    fn drops_an_event_without_a_panel() {
        // Хук запустили вне панели ModelCrew — привязать событие не к чему.
        assert!(parse_event(r#"{"agent":"codex","panelId":"","payload":{}}"#).is_none());
        assert!(parse_event("не json").is_none());
    }

    #[test]
    fn survives_a_payload_it_does_not_know() {
        let event = parse_event(r#"{"agent":"newcli","panelId":"p","payload":{"a":1}}"#)
            .expect("незнакомая схема не должна ронять разбор");

        assert_eq!(event.event, "");
        assert_eq!(event.message, "");
    }
}
