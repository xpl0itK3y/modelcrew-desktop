//! Уведомления от самих агентов, а не по косвенным признакам вывода.
//!
//! CLI умеют звать внешнюю программу, когда закончили ход или просят
//! разрешения: у codex это `notify` в config.toml, у claude и copilot —
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
if [ "$1" = "--claim" ] || [ "$1" = "--claim-copilot" ] || [ "$1" = "--claim-codex" ]; then
  [ -z "$dir" ] && exit 0
  payload="$(cat)"
  for key in tool_name toolName tool; do
    tool=$(printf '%s' "$payload" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p")
    [ -n "$tool" ] && break
  done
  if [ "$1" = "--claim-codex" ]; then
    # У codex правка идёт патчем: пути лежат внутри его текста, а не отдельным
    # ключом, и за один вызов он трогает сколько угодно файлов.
    files=$(printf '%s' "$payload" \
      | grep -oE '\*\*\* (Update|Add|Delete) File: [^\\"]+' \
      | sed 's/^.*File: //')
  else
    # Ключ пути у агентов называется по-разному, и схему их полезной нагрузки
    # никто не обещает. Пробуем известные написания по очереди; не нашли —
    # выходим с нулём, то есть пропускаем правку.
    for key in file_path filePath target_file absolute_path path; do
      files=$(printf '%s' "$payload" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p")
      [ -n "$files" ] && break
    done
  fi
  [ -z "$files" ] && exit 0
  mkdir -p "$dir" || exit 0

  # Один круг вопроса-ответа. Печатает ответ приложения; пусто — молчание.
  ask() {
    id="claim-$(date +%s)-$$-$2"
    printf '{"kind":"claim","panelId":"%s","file":"%s","tool":"%s"}' \
      "$MODELCREW_PANEL_ID" "$1" "$tool" > "$dir/$id.tmp" || return 0
    mv "$dir/$id.tmp" "$dir/$id.json" || return 0
    i=0
    while [ $i -lt 20 ]; do
      if [ -f "$dir/$id.res" ]; then
        cat "$dir/$id.res"
        rm -f "$dir/$id.res"
        return 0
      fi
      # Доля секунды — не по POSIX. Там, где sleep её не принимает, цикл без
      # запасного хода пролетел бы мгновенно, ответа не дождался и молча
      # пропустил правку занятого файла.
      sleep 0.1 2>/dev/null || { sleep 1; i=$((i + 9)); }
      i=$((i + 1))
    done
  }

  # Спрашиваем про каждый файл вызова: занят хотя бы один — правку целиком
  # пропускать нельзя, патч применяется весь или никак.
  verdict=allow
  task=''
  n=0
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    n=$((n + 1))
    answer=$(ask "$file" "$n")
    case "$answer" in
      *'"stale"'*) verdict=stale; break ;;
      *'"deny"'*)
        verdict=deny
        task=$(printf '%s' "$answer" | sed -n 's/.*"task":"\([^"]*\)".*/\1/p')
        break
        ;;
    esac
  done <<CLAIM_FILES
$files
CLAIM_FILES

  # Отказ выражается по-разному: claude и codex читают код возврата 2 и stderr,
  # copilot ждёт `permissionDecision` JSON-ом в stdout. Причина нужна всем
  # одинаково: без неё агент не понимает, что делать дальше, и берётся за тот
  # же файл снова.
  case "$verdict" in
    stale)
      reason='Файл изменился с тех пор, как ты его прочитал: в нём успел поработать другой агент. Перечитай файл и примени правку заново, иначе его работа будет затёрта.'
      ;;
    deny)
      reason='Файл сейчас правит другой агент этого проекта'
      [ -n "$task" ] && reason="$reason: $task"
      # Про оболочку сказано нарочно: агент, которому отказали в правке файла,
      # охотно пробует переписать его через `printf >` — это видно на живых
      # copilot и opencode, и такая запись проходит мимо всех заявок.
      reason="$reason. Возьмись за другой файл и вернись к этому позже; переписывать его через оболочку тоже не нужно."
      ;;
    *) reason='' ;;
  esac
  case "$1" in
    --claim-copilot)
      [ -z "$reason" ] && exit 0
      printf '{"permissionDecision":"deny","permissionDecisionReason":"%s"}\n' "$reason"
      exit 0 ;;
  esac
  [ -z "$reason" ] && exit 0
  printf '%s\n' "$reason" >&2
  exit 2
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

/// Чем звать нас на этой платформе: скриптом или самим приложением.
///
/// Путь к себе спрашиваем у системы, а не складываем из каталога данных: у
/// установленного приложения они лежат в разных местах, и на Windows это
/// вообще разные диски.
fn native_helper(app: &tauri::AppHandle) -> Option<Helper> {
    helper_path(app).map(native_helper_at)
}

/// То же решение там, где ручки приложения нет: путь к скрипту известен, а
/// путь к себе спрашиваем у системы.
fn native_helper_at(script: PathBuf) -> Helper {
    if cfg!(windows) {
        // Не нашли себя — остаётся скрипт: он хотя бы сработает у тех, у кого
        // стоит Git Bash. Молчать в такой ситуации хуже.
        return std::env::current_exe()
            .map(Helper::program)
            .unwrap_or_else(|_| Helper::script(script));
    }
    Helper::script(script)
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
    // Через временный файл: панель прошлого запуска или второе окно могут
    // исполнять хелпер прямо сейчас, а усечённый скрипт оболочка выполнит
    // молча — и оборванная ветка ответит «можно» на занятый файл.
    let temp = path.with_extension("tmp");
    if std::fs::write(&temp, HELPER_SCRIPT).is_err() {
        return;
    }
    // Права ставим до подмены: иначе есть миг, когда скрипт уже на месте, но
    // ещё не исполняемый.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o755));
    }
    let _ = std::fs::rename(&temp, &path);
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
            let age = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .map(|modified| modified.elapsed().unwrap_or_default())
                .unwrap_or_default();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                // Ответ на заявку и временные файлы убирает за собой хелпер,
                // но он мог не дождаться ответа или погибнуть вместе с
                // панелью. Без уборки каталог растёт без конца, и его обход
                // дорожает с каждым тиком.
                if age > MAX_EVENT_AGE {
                    let _ = std::fs::remove_file(&path);
                }
                continue;
            }
            let fresh = age < MAX_EVENT_AGE;
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
    // Через временный файл: хелпер ждёт появления `.res` и читает его сразу,
    // а в половине ответа не будет ни «deny», ни «stale» — то есть правка
    // занятого файла прошла бы.
    let temp = request_path.with_extension("res-tmp");
    if std::fs::write(&temp, answer).is_err() {
        return;
    }
    let _ = std::fs::rename(&temp, request_path.with_extension("res"));
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
    const READS: [&str; 2] = ["read", "notebookread"];
    READS.iter().any(|known| tool.eq_ignore_ascii_case(known))
}

enum ClaimVerdict {
    Allow,
    /// Файл держит другая панель.
    Held(crate::crew::Claim),
    /// Файл изменился с тех пор, как эта панель его читала.
    Stale,
}

/// Приводит путь от агента к виду «от корня проекта».
///
/// Сначала напрямую, а если не сошлось — разворачивая ссылки. На macOS `/tmp`
/// — ссылка на `/private/tmp`, и агент присылает то один путь, то другой: на
/// живом opencode оба варианта пришли за один ход. Несовпадение означало бы,
/// что заявка на файл просто не находится, и сосед спокойно его перезапишет.
fn relative_to_root(file: &Path, root: &Path) -> Option<String> {
    let relative = match file.strip_prefix(root) {
        Ok(relative) => relative.to_path_buf(),
        Err(_) => {
            let root = std::fs::canonicalize(root).ok()?;
            resolve_links(file)?.strip_prefix(&root).ok()?.to_path_buf()
        }
    };
    Some(relative.to_string_lossy().replace('\\', "/"))
}

/// Файла может ещё не быть — тогда разворачиваем ту часть пути, что есть.
fn resolve_links(file: &Path) -> Option<PathBuf> {
    // Разворачиваем ближайшего существующего предка и дописываем остаток:
    // canonicalize требует, чтобы путь существовал, а заявка приходит как раз
    // перед созданием файла. Предок может быть далеко — агент создаёт файл
    // сразу вместе с каталогом, которого ещё нет; на одном шаге вверх такая
    // правка оставалась без заявки.
    let mut tail = Vec::new();
    let mut current = file;
    loop {
        if let Ok(resolved) = std::fs::canonicalize(current) {
            let mut path = resolved;
            for name in tail.iter().rev() {
                path.push(name);
            }
            return Some(path);
        }
        tail.push(current.file_name()?);
        current = current.parent()?;
    }
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
    let Some(relative) = relative_to_root(Path::new(&request.file), &root) else {
        return ClaimVerdict::Allow;
    };
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
        // claude/copilot: {"hook_event_name":"Stop","message":"…"}
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
        // Остальным каналом мы пока не умеем — либо формат не подтверждён,
        // либо у самого CLI уведомлений нет.
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
        "codex" => Some(home.join(".codex")),
        _ => None,
    }
}

/// Свой отдельный файл у агента, где чужого содержимого не бывает: ставить
/// его — записать, снимать — удалить. Слияние нужно только там, где мы
/// вписываемся в общий файл настроек, как у claude.
fn own_file_body(agent: &str, helper: &Helper) -> Option<String> {
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
                    // Именно PascalCase: под этим именем copilot присылает
                    // нагрузку в точности как claude — `tool_name` и
                    // `tool_input.path`, — и хелпер разбирает её без правок.
                    // Отбирать инструменты нечем, поля matcher у него нет:
                    // вызовы без пути хелпер пропускает сам.
                    "PreToolUse": [{
                        "type": "command",
                        "bash": hook_claim_copilot_command(helper),
                        "timeoutSec": 10,
                    }],
                },
            }))
            .ok()?,
        ),
        "opencode" => Some(opencode_plugin()),
        _ => None,
    }
}

/// Плагин opencode. Форма обработчика — `event`, а не документированный ключ
/// `"session.idle"`: тот не вызывается ни разу, проверено на живой сессии.
/// Хелпер здесь не нужен — плагин уже внутри процесса панели и видит её
/// окружение, поэтому кладёт событие сам.
fn opencode_plugin() -> String {
    // Тело — обычная строка с одной подстановкой: JS здесь полон `${...}`, и
    // отдавать его форматтеру Rust значит драться с ним за каждую скобку.
    OPENCODE_PLUGIN.replace("__AGENT__", "opencode")
}

const OPENCODE_PLUGIN: &str = r#"// Создан ModelCrew: заявки на файлы и сообщение о том, что агент затих.
import { mkdirSync, renameSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = () => process.env.MODELCREW_EVENTS_DIR;
const panel = () => process.env.MODELCREW_PANEL_ID;

function put(body) {
  // Сначала временный файл, потом переименование: вотчер не должен прочитать
  // половину.
  const base = join(dir(), `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(`${base}.tmp`, JSON.stringify(body));
  renameSync(`${base}.tmp`, `${base}.json`);
  return base;
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export const ModelCrewNotify = async () => ({
  // Заявка на файл. Всё, что пошло не так — нет каталога, молчание в ответ —
  // трактуем как «можно»: слой согласования не должен останавливать работу
  // из-за собственной поломки.
  "tool.execute.before": async (input, output) => {
    if (!dir() || !panel()) return; // запущен не из панели ModelCrew
    const file = output?.args?.filePath;
    if (typeof file !== "string" || !file) return;
    let base;
    try {
      mkdirSync(dir(), { recursive: true });
      base = put({ kind: "claim", panelId: panel(), file, tool: input?.tool ?? "" });
    } catch {
      return;
    }
    for (let i = 0; i < 20; i++) {
      let answer;
      try {
        if (!existsSync(`${base}.res`)) {
          await pause(100);
          continue;
        }
        answer = readFileSync(`${base}.res`, "utf8");
        rmSync(`${base}.res`, { force: true });
      } catch {
        return;
      }
      // Отказ выражается броском: opencode показывает его текст агенту, и тот
      // берётся за другой файл.
      if (answer.includes('"stale"')) {
        throw new Error(
          "Файл изменился с тех пор, как ты его прочитал: в нём успел поработать другой агент. Перечитай файл и примени правку заново, иначе его работа будет затёрта.",
        );
      }
      if (answer.includes('"deny"')) {
        throw new Error(
          "Файл сейчас правит другой агент этого проекта. Возьмись за другой файл и вернись к этому позже; переписывать его через оболочку тоже не нужно.",
        );
      }
      return;
    }
  },
  event: async (arg) => {
    if (arg?.event?.type !== "session.idle") return;
    if (!dir() || !panel()) return;
    try {
      mkdirSync(dir(), { recursive: true });
      put({ agent: "__AGENT__", panelId: panel(), payload: { type: "session.idle" } });
    } catch {
      // Уведомление — дополнение; его сбой не должен мешать сессии.
    }
  },
});
"#;

/// Чем именно агент нас позовёт.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Launch {
    /// POSIX: отдельный скрипт рядом с данными приложения. Проверен живьём на
    /// восьми агентах, менять там нечего.
    Script,
    /// Windows: само приложение. `.sh` там не программа вовсе, а bash есть не
    /// у всех — мы его лишь предлагаем поставить. Exe же запускает любая
    /// оболочка: и cmd, и PowerShell, и bash.
    Program,
}

/// Путь вместе со способом запуска: порознь они разъезжались бы по дороге
/// через дюжину функций, а команда, собранная не для той платформы, молча не
/// запускалась бы.
#[derive(Clone, PartialEq, Eq, Debug)]
struct Helper {
    path: PathBuf,
    launch: Launch,
}

impl Helper {
    fn script(path: PathBuf) -> Self {
        Self {
            path,
            launch: Launch::Script,
        }
    }

    fn program(path: PathBuf) -> Self {
        Self {
            path,
            launch: Launch::Program,
        }
    }

    /// Строка, по которой мы узнаём свой хук в чужом конфиге.
    fn needle(&self) -> String {
        self.path.display().to_string()
    }

    /// Команда с нашими аргументами.
    ///
    /// Кавычки разные не для красоты: путь лежит в каталоге с пробелом, и
    /// одинарные кавычки cmd не понимает вовсе — он передал бы их программе
    /// как часть имени файла.
    fn command(&self, args: &str) -> String {
        match self.launch {
            Launch::Script => {
                let path = self.needle().replace('\'', r"'\''");
                format!("'{path}' {args}")
            }
            Launch::Program => {
                let path = self.needle();
                format!("\"{path}\" {} {args}", crate::agent_hook_cli::HOOK_FLAG)
            }
        }
    }
}

/// Команда для конфига агента.
fn hook_command(helper: &Helper, agent: &str) -> String {
    helper.command(agent)
}

fn hook_claim_command(helper: &Helper) -> String {
    helper.command(crate::agent_hook_cli::ClaimFlag::Plain.arg())
}

/// У codex путь лежит внутри текста патча, а не отдельным ключом — разбор
/// у хелпера отдельный.
fn hook_claim_codex_command(helper: &Helper) -> String {
    helper.command(crate::agent_hook_cli::ClaimFlag::Codex.arg())
}

fn hook_claim_copilot_command(helper: &Helper) -> String {
    helper.command(crate::agent_hook_cli::ClaimFlag::Copilot.arg())
}

/// Наш ли это хук. Ищем по пути хелпера, а не по всей строке: команда могла
/// быть записана прежней версией приложения с другим хвостом.
fn is_our_hook(entry: &Value, helper: &Helper) -> bool {
    let needle = helper.needle();
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

fn claude_hook_entry(helper: &Helper) -> Value {
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
        // У codex глобальные хуки лежат тут же, но запускает он их только
        // после разового одобрения человеком: `/hooks` в его же сессии. Пока
        // одобрения нет, файл просто лежит и ничего не делает.
        "codex" => Some(home.join(".codex/hooks.json")),
        _ => None,
    }
}

/// Заявка для codex: событие как у claude, но без matcher.
///
/// Инструменты у него зовутся по-своему — `write`, `edit`, `read`,
/// `apply_patch`, — и матчер из claude не совпадал ни с одним: хук молчал, а
/// заявки не работали вовсе, никак этого не показывая. Отбирать вызовы здесь
/// нечем и незачем: хелпер сам пропускает всё, в чём не нашёл пути, так что
/// незнакомый или новый инструмент ничего не ломает.
fn claim_file_body(helper: &Helper) -> String {
    let command = hook_claim_codex_command(helper);
    let entry = serde_json::json!({
        "hooks": [{ "type": "command", "command": command }],
    });
    let body = serde_json::json!({ "hooks": { "PreToolUse": [entry] } });
    serde_json::to_string_pretty(&body).unwrap_or_default() + "\n"
}

fn claude_claim_entry(helper: &Helper) -> Value {
    serde_json::json!({
        // Чтение тоже проходит через хук — но заявки не берёт, только
        // запоминает, каким панель увидела файл. Без этого не поймать
        // правку, построенную на устаревшем чтении.
        "matcher": "Edit|Write|MultiEdit|Read|NotebookEdit",
        "hooks": [{ "type": "command", "command": hook_claim_command(helper) }],
    })
}

/// Вписывает хук, не трогая ничего чужого. Возвращает true, если файл изменился.
fn install_claude_hook(settings: &mut Value, helper: &Helper) -> bool {
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
fn put_our_entry(list: &mut Vec<Value>, helper: &Helper, expected: Value) -> bool {
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
fn remove_claude_hook(settings: &mut Value, helper: &Helper) -> bool {
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

fn claude_hook_installed(settings: &Value, helper: &Helper) -> bool {
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
    let (Some(home), Some(helper)) = (home_dir(app), native_helper(app)) else {
        return unsupported;
    };
    let Some(path) = hook_config_path(agent, &home) else {
        return unsupported;
    };
    let installed = match own_file_body(agent, &helper) {
        // Устаревшее тело считаем неподключённым — тогда старт его перепишет.
        Some(body) => std::fs::read_to_string(&path).is_ok_and(|current| current == body),
        None => read_json(&path)
            .map(|settings| claude_hook_installed(&settings, &helper))
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
    let helper = native_helper(app).ok_or_else(|| "каталог приложения недоступен".to_string())?;
    let path =
        hook_config_path(agent, &home).ok_or_else(|| format!("{agent}: канал не поддержан"))?;
    // Скрипт мог не появиться, если каталог данных был недоступен на старте.
    // Приложение же на месте по определению — иначе этот код бы не выполнялся.
    if helper.launch == Launch::Script && !helper.path.exists() {
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
    let changed = if enabled {
        install_claude_hook(&mut settings, &helper)
    } else {
        remove_claude_hook(&mut settings, &helper)
    };
    if changed {
        back_up_once(&path);
        write_json_atomically(&path, &settings)?;
    }
    Ok(hook_state(app, agent))
}

/// Агенты, которым мы умеем прописывать себя.
const SUPPORTED_AGENTS: [&str; 4] = [
    "claude",
    // Уведомления у codex читаются из вывода панели, а вот заявка на файлы
    // идёт хуком — ради неё он и в списке.
    "codex",
    "copilot",
    "opencode",
];

/// Агенты, чей хук сообщает не только о конце хода, но и о том, что агент
/// чего-то ждёт: разрешения, ответа на вопрос.
///
/// Такой список нужен отдельно от списка установленных, потому что хуки у
/// агентов покрывают разное. Claude Code присылает `Notification` — и на
/// вопрос, и на запрос разрешения. У copilot мы ставим `agentStop` (конец
/// хода) и `PreToolUse` (заявка на файл, это про другое), у opencode —
/// только `session.idle`. Их запрос разрешения хук не заметит вовсе, и
/// единственный сигнал о нём — звонок BEL из вывода панели.
const PROMPT_CHANNEL_AGENTS: [&str; 1] = ["claude"];

/// Агенты, чей канал уведомлений подключён прямо сейчас.
///
/// Такой агент рассказывает о себе сам — раньше и точнее, чем догадки по
/// выводу панели, — поэтому фронтенд по этому списку придерживает догадки для
/// его панелей. Спрашиваем состояние на диске, а не список поддержанных:
/// хук мог не встать (битый конфиг, недоступный каталог), и тогда догадки
/// обязаны остаться единственным источником сигналов.
pub fn notification_channels(app: &tauri::AppHandle) -> AgentHookChannels {
    let installed: Vec<String> = SUPPORTED_AGENTS
        .iter()
        .filter(|agent| hook_state(app, agent).installed)
        .map(|agent| (*agent).to_string())
        .collect();
    let prompts = installed
        .iter()
        .filter(|agent| PROMPT_CHANNEL_AGENTS.contains(&agent.as_str()))
        .cloned()
        .collect();
    AgentHookChannels { installed, prompts }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHookChannels {
    /// Хук стоит: догадка по тишине уступает ему первое слово.
    pub installed: Vec<String>,
    /// Хук говорит и о запросах: звонок от такого агента ничего не добавит.
    pub prompts: Vec<String>,
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

    fn helper() -> Helper {
        // Реальный путь хелпера лежит в «Application Support» — с пробелом.
        Helper::script(PathBuf::from(
            "/Users/x/Library/Application Support/mc/modelcrew-agent-notify.sh",
        ))
    }

    /// То же, но так, как это выглядит на Windows: зовут само приложение, и
    /// путь тоже с пробелом — «Program Files».
    fn windows_helper() -> Helper {
        Helper::program(PathBuf::from(r"C:\Program Files\ModelCrew\ModelCrew.exe"))
    }

    /// Кладёт настоящий хелпер под свежим именем и делает его исполняемым.
    ///
    /// Зовут её только те проверки, что поднимают сам хелпер, — а он POSIX.
    /// Без этой пометки на Windows она осталась бы никем не вызванной, и
    /// clippy справедливо назвал бы её мёртвой.
    #[cfg(unix)]
    fn executable_helper(base: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = base.join("notify.sh");
        std::fs::write(&script, HELPER_SCRIPT).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    /// Ждёт заявку, которую хелпер кладёт файлом, и отдаёт её вместе с id.
    ///
    /// Тоже только для POSIX — по той же причине, что и хелпер выше.
    #[cfg(unix)]
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
                // Приложение забирает заявку с диска; без этого следующий
                // вызов нашёл бы ту же самую.
                std::fs::remove_file(entry.path()).unwrap();
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

    /// Copilot присылает под именем `PreToolUse` ровно то же, что claude, —
    /// проверено на живом запуске, — но решение читает своими ключами.
    ///
    /// Запускает настоящий хелпер, поэтому только на POSIX-оболочке.
    #[cfg(unix)]
    #[test]
    fn answers_copilot_in_the_keys_it_reads() {
        let base = std::env::temp_dir().join(format!("mc-copilot-{}", std::process::id()));
        let events = base.join("agent-events");
        std::fs::create_dir_all(&events).unwrap();
        let script = executable_helper(&base);

        let payload = concat!(
            r#"{"hook_event_name":"PreToolUse","session_id":"s1","#,
            r#""cwd":"/w","tool_name":"Edit","#,
            r#""tool_input":{"path":"/w/note.txt","old_str":"а","new_str":"б"}}"#
        );
        let mut child = std::process::Command::new(&script)
            .arg("--claim-copilot")
            .env("MODELCREW_PANEL_ID", "panel-9")
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

        let request = read_claim(&events);
        assert_eq!(request["file"], "/w/note.txt");
        assert_eq!(request["tool"], "Edit");

        std::fs::write(
            events.join(format!("{}.res", request["id"].as_str().unwrap())),
            r#"{"verdict":"deny","task":"чинит сборку"}"#,
        )
        .unwrap();

        let out = child.wait_with_output().unwrap();
        let answer: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(answer["permissionDecision"], "deny");
        let reason = answer["permissionDecisionReason"].as_str().unwrap();
        // Чужая задача попадает в текст: «занято» без объяснения агент
        // трактует как поломку конфигурации, а не как очередь.
        assert!(reason.contains("чинит сборку"), "{reason}");
        // На живом copilot видно: получив отказ на правку файла, агент тут же
        // пробует переписать его через оболочку мимо всяких заявок.
        assert!(reason.contains("оболочку"), "{reason}");
        // Код возврата у него тоже означал бы отказ, но тогда агент увидит
        // лишь «hook exited with code 2» — без причины.
        assert_eq!(out.status.code(), Some(0));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Живой opencode за один ход прислал и `/private/tmp/…`, и `/tmp/…` —
    /// две строки для одного файла. Считая их разными, заявку на файл мы бы
    /// не нашли, и сосед спокойно его перезаписал бы.
    ///
    /// Ссылку заводим только там, где на это не нужны права администратора:
    /// на Windows вызов отказывает, и проверка падала бы на том, что ссылки
    /// нет, а не на разборе пути. Отдельной проверкой, а не веткой внутри
    /// общей, — чтобы пропуск был виден в списке, а не прятался под зелёным.
    #[cfg(unix)]
    #[test]
    fn the_same_file_through_a_symlink_is_the_same_file() {
        let base = std::env::temp_dir().join(format!("mc-links-{}", std::process::id()));
        let root = base.join("проект");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let link = base.join("ссылка");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&root, &link).unwrap();

        // Через ссылку — и для файла, которого ещё нет.
        assert_eq!(
            relative_to_root(&link.join("src/новый.rs"), &root).as_deref(),
            Some("src/новый.rs")
        );
        // И для файла в каталоге, которого ещё нет: агент создаёт модуль
        // целиком, а заявка приходит до того, как на диске появится хоть что-то.
        assert_eq!(
            relative_to_root(&link.join("src/новый/модуль.rs"), &root).as_deref(),
            Some("src/новый/модуль.rs")
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Разбор пути без ссылок — он одинаков на всех платформах.
    #[test]
    fn a_path_under_the_root_is_counted_from_it() {
        let base = std::env::temp_dir().join(format!("mc-paths-{}", std::process::id()));
        let root = base.join("проект");
        std::fs::create_dir_all(root.join("src")).unwrap();

        assert_eq!(
            relative_to_root(&root.join("src/есть.rs"), &root).as_deref(),
            Some("src/есть.rs")
        );
        // Чужой файл остаётся чужим — иначе заявки текли бы между проектами.
        assert_eq!(relative_to_root(Path::new("/иной/файл.rs"), &root), None);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// У codex правка идёт патчем: пути лежат внутри его текста, а не
    /// отдельным ключом, и за один вызов он трогает сколько угодно файлов.
    /// Образец снят с живого запуска.
    ///
    /// Запускает настоящий хелпер, поэтому только на POSIX-оболочке.
    #[cfg(unix)]
    #[test]
    fn reads_every_file_out_of_a_codex_patch() {
        let base = std::env::temp_dir().join(format!("mc-codex-{}", std::process::id()));
        let events = base.join("agent-events");
        std::fs::create_dir_all(&events).unwrap();
        let script = executable_helper(&base);

        let payload = concat!(
            r#"{"hook_event_name":"PreToolUse","tool_name":"apply_patch","tool_input":"#,
            r#"{"command":"*** Begin Patch
*** Update File: /w/первый.rs
@@
-было
+стало
"#,
            r#"*** Add File: /w/второй.rs
+новый
*** End Patch
"}}"#
        );
        let mut child = std::process::Command::new(&script)
            .arg("--claim-codex")
            .env("MODELCREW_PANEL_ID", "panel-3")
            .env("MODELCREW_EVENTS_DIR", &events)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.as_bytes())
            .unwrap();

        // Первый файл свободен — заявка на него проходит, и хелпер идёт
        // спрашивать про второй.
        let first = read_claim(&events);
        assert_eq!(first["file"], "/w/первый.rs");
        assert_eq!(first["tool"], "apply_patch");
        std::fs::write(
            events.join(format!("{}.res", first["id"].as_str().unwrap())),
            r#"{"verdict":"allow"}"#,
        )
        .unwrap();

        let second = read_claim(&events);
        assert_eq!(second["file"], "/w/второй.rs");
        std::fs::write(
            events.join(format!("{}.res", second["id"].as_str().unwrap())),
            r#"{"verdict":"deny","task":"правит сосед"}"#,
        )
        .unwrap();

        let out = child.wait_with_output().unwrap();
        // Занят хотя бы один файл — отказ на весь вызов: патч применяется
        // целиком или никак.
        assert_eq!(out.status.code(), Some(2));
        let text = String::from_utf8_lossy(&out.stderr);
        assert!(text.contains("правит сосед"), "{text}");
        let _ = std::fs::remove_dir_all(&base);
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
        let command = hook_command(
            &Helper::script(PathBuf::from("/tmp/it's here/notify.sh")),
            "claude",
        );

        // Кавычка закрывается по-шелловски, а не остаётся открытой.
        assert_eq!(command, r"'/tmp/it'\''s here/notify.sh' claude");
    }

    /// На Windows хук зовёт само приложение. Одинарных кавычек там нельзя:
    /// cmd их не раскрывает и передал бы программе как часть имени файла —
    /// а «Program Files» без кавычек распалось бы на два аргумента.
    #[test]
    fn on_windows_the_agent_calls_the_application_itself() {
        assert_eq!(
            hook_command(&windows_helper(), "claude"),
            r#""C:\Program Files\ModelCrew\ModelCrew.exe" --agent-hook claude"#
        );
        assert_eq!(
            hook_claim_command(&windows_helper()),
            r#""C:\Program Files\ModelCrew\ModelCrew.exe" --agent-hook --claim"#
        );
    }

    /// Каждое наречие отказа должно доехать и до Windows: заявку у codex и
    /// copilot мы просим теми же флагами, разбор которых проверен отдельно.
    #[test]
    fn every_dialect_survives_the_move_to_windows() {
        for (command, expected) in [
            (hook_claim_codex_command(&windows_helper()), "--claim-codex"),
            (
                hook_claim_copilot_command(&windows_helper()),
                "--claim-copilot",
            ),
        ] {
            assert_eq!(
                command,
                format!(r#""C:\Program Files\ModelCrew\ModelCrew.exe" --agent-hook {expected}"#)
            );
            // И приложение обязано разобрать ровно то, что мы записали:
            // строка в чужом конфиге и разбор аргументов — один договор.
            let args: Vec<String> = vec![
                "ModelCrew.exe".to_string(),
                crate::agent_hook_cli::HOOK_FLAG.to_string(),
                expected.to_string(),
            ];
            assert!(matches!(
                crate::agent_hook_cli::mode_from_args(&args),
                Some(crate::agent_hook_cli::Mode::Claim(_))
            ));
        }
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

    /// Отказ до агента доходит двумя разными путями — шелл-хелпером и самим
    /// приложением, — но услышать он должен одно и то же. Тексты живут в двух
    /// файлах, и без этой сверки они разъехались бы молча: правку внесли бы в
    /// один канал, а второй продолжил бы говорить по-старому.
    #[test]
    fn both_ways_of_refusing_say_the_same_words() {
        use crate::agent_hook_cli::{HELD_ADVICE, HELD_REASON, STALE_REASON};

        for text in [STALE_REASON, HELD_REASON, HELD_ADVICE] {
            assert!(
                HELPER_SCRIPT.contains(text),
                "шелл-хелпер не говорит: {text}"
            );
        }
    }

    #[test]
    fn tells_reading_tools_from_writing_ones() {
        // Чтение проходит через хук, но заявку не берёт: осмотр тридцати
        // файлов запер бы соседу полпроекта.
        assert!(is_read_tool("Read"));
        assert!(is_read_tool("read"));
        assert!(is_read_tool("NotebookRead"));
        for writing in ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"] {
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
    fn puts_the_claim_file_only_where_hooks_are_trusted_without_asking() {
        let home = Path::new("/Users/x");

        // У claude заявка идёт в общий settings.json вместе с остальными
        // хуками — отдельный файл ему не нужен.
        assert_eq!(claim_file("claude", home), None);
        // У codex тоже свой файл: хуки он оттуда читает и отказ по коду
        // возврата 2 соблюдает — проверено на живом запуске. Запускает он их
        // только после разового `/hooks` в его же сессии, но это согласие
        // человека, а не догадка с нашей стороны.
        assert_eq!(
            claim_file("codex", home),
            Some(home.join(".codex/hooks.json"))
        );
        // Остальные получают заявку иначе: copilot — своим файлом хуков,
        // opencode — плагином.
        for agent in ["copilot", "opencode"] {
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

        // Попав в автоподключение, агент обязан получить хоть что-то: общий
        // конфиг, свой файл или заявку на файлы. Иначе он числился бы
        // подключённым и молча ничего не получал.
        for agent in SUPPORTED_AGENTS {
            let somewhere = hook_config_path(agent, home).is_some()
                || own_file_body(agent, &helper()).is_some()
                || claim_file(agent, home).is_some();
            assert!(somewhere, "{agent}");
        }
        // И он должен опознаваться на диске — иначе автоподключение обойдёт
        // его стороной, сколько бы путей мы для него ни знали.
        for agent in SUPPORTED_AGENTS {
            assert!(agent_home(agent, home).is_some(), "{agent}");
        }
    }

    #[test]
    fn only_the_agents_we_actually_support_get_a_config_path() {
        let home = Path::new("/home/x");

        assert_eq!(
            hook_config_path("claude", home),
            Some(PathBuf::from("/home/x/.claude/settings.json"))
        );
        // У codex уведомления идут разбором вывода панели — общий конфиг ему
        // писать незачем. Каталог у него при этом свой: по нему видно, что
        // агент вообще установлен, и туда же ложится заявка на файлы.
        assert_eq!(hook_config_path("codex", home), None);
        assert_eq!(
            agent_home("codex", home),
            Some(PathBuf::from("/home/x/.codex"))
        );
        // Снятые с поддержки не должны получить ни конфига, ни каталога: иначе
        // установка хуков нашла бы их на диске и полезла бы писать.
        for gone in ["aider", "kimi", "kilocode", "grok", "cursor", "antigravity"] {
            assert_eq!(hook_config_path(gone, home), None, "{gone}");
            assert_eq!(agent_home(gone, home), None, "{gone}");
        }
    }

    #[test]
    fn the_opencode_plugin_uses_the_shape_that_actually_fires() {
        let body = opencode_plugin();

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
        // Заявка на файл: проверено на живом opencode — блокирующий обработчик
        // называется так, путь лежит в args.filePath, а отказ выражается
        // броском, текст которого доходит до агента дословно.
        assert!(body.contains(r#""tool.execute.before": async"#), "{body}");
        assert!(body.contains("output?.args?.filePath"), "{body}");
        assert!(body.contains("throw new Error"), "{body}");
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
