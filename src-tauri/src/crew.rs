//! Кто из панелей какие файлы правит прямо сейчас.
//!
//! Все панели одного проекта работают в одной папке, поэтому два агента могут
//! взяться за один файл и затереть работу друг друга. Реестр держит заявки
//! «панель P правит файл F» и отвечает на вопрос «свободен ли файл» — ответ
//! уходит агенту отказом с объяснением, и он идёт работать в другие файлы.
//!
//! Заявка берётся только на запись: если брать её и при чтении, агент,
//! осматривающий тридцать файлов, заблокировал бы соседу полпроекта.
//!
//! Реестр рантаймовый — на диск не пишется. Заявка, пережившая процесс,
//! который её сделал, хуже отсутствующей: она держит файл, за которым уже
//! никого нет.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

use crate::command_error::CommandResult;
use crate::git_changes::is_safe_repo_path;
use crate::workspace_roots::WorkspaceRoots;

/// Заявка протухает, если панель молчит дольше этого срока. Ход агента редко
/// длится больше пары минут, а зависшая заявка блокирует соседей вслепую,
/// поэтому лучше отпустить рано: столкновение увидит следующая проверка.
pub const CLAIM_TTL_MS: u64 = 5 * 60 * 1000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub path: String,
    pub panel_id: String,
    /// Чем занята панель — последнее сообщение агента, если оно известно.
    pub task: Option<String>,
    pub since_ms: u64,
}

/// Ответ на попытку занять файл.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaimOutcome {
    /// Файл свободен (или уже за этой панелью) — можно писать.
    Granted,
    /// Файл держит другая панель. Отказ несёт с собой, кто и чем занят: без
    /// этого агенту нечего сказать пользователю и не на что опереться,
    /// выбирая, за что взяться вместо этого.
    Held(Claim),
    /// Путь не годится: пустой, абсолютный или уводит за корень проекта.
    Rejected,
}

#[derive(Default)]
pub struct CrewRegistry {
    // Проект → путь → заявка. Ключ по проекту, а не глобальный: у панелей
    // разных проектов общих файлов нет по построению.
    claims: Mutex<HashMap<String, HashMap<String, Claim>>>,
    // Проект → путь → панели, которым файл нужен и которые получили отказ.
    // Нужно, чтобы держатель видел, что его ждут.
    waiting: Mutex<HashMap<String, HashMap<String, Vec<String>>>>,
}

impl CrewRegistry {
    /// Занять файл под панель. Повторная заявка той же панели продлевает
    /// срок — ход агента длиннее одной правки.
    pub fn claim(
        &self,
        workspace_id: &str,
        panel_id: &str,
        path: &str,
        task: Option<String>,
        now_ms: u64,
    ) -> ClaimOutcome {
        if !is_safe_repo_path(path) {
            return ClaimOutcome::Rejected;
        }
        let mut claims = self.claims.lock().unwrap();
        let project = claims.entry(workspace_id.to_string()).or_default();
        if let Some(existing) = project.get(path) {
            if existing.panel_id != panel_id && !expired(existing.since_ms, now_ms) {
                drop(claims);
                self.note_waiting(workspace_id, path, panel_id);
                // Держателя перечитываем после снятия замка: за это время он
                // мог отпустить файл, но для ответа это уже неважно —
                // повторная попытка агента пройдёт.
                let claims = self.claims.lock().unwrap();
                if let Some(holder) = claims
                    .get(workspace_id)
                    .and_then(|project| project.get(path))
                {
                    if holder.panel_id != panel_id {
                        return ClaimOutcome::Held(holder.clone());
                    }
                }
                return ClaimOutcome::Granted;
            }
        }
        project.insert(
            path.to_string(),
            Claim {
                path: path.to_string(),
                panel_id: panel_id.to_string(),
                task,
                since_ms: now_ms,
            },
        );
        drop(claims);
        self.forget_waiting(workspace_id, path, panel_id);
        ClaimOutcome::Granted
    }

    /// Отпустить всё, что держит панель: конец хода, смерть панели, закрытие.
    pub fn release_panel(&self, panel_id: &str) {
        let mut claims = self.claims.lock().unwrap();
        for project in claims.values_mut() {
            project.retain(|_, claim| claim.panel_id != panel_id);
        }
        drop(claims);
        let mut waiting = self.waiting.lock().unwrap();
        for project in waiting.values_mut() {
            for panels in project.values_mut() {
                panels.retain(|id| id != panel_id);
            }
            project.retain(|_, panels| !panels.is_empty());
        }
    }

    /// Действующие заявки проекта. Протухшие снимаются на месте — так реестр
    /// чистится сам, без отдельного таймера.
    pub fn list(&self, workspace_id: &str, now_ms: u64) -> Vec<Claim> {
        let mut claims = self.claims.lock().unwrap();
        let Some(project) = claims.get_mut(workspace_id) else {
            return Vec::new();
        };
        project.retain(|_, claim| !expired(claim.since_ms, now_ms));
        let mut live: Vec<Claim> = project.values().cloned().collect();
        live.sort_by(|a, b| a.path.cmp(&b.path));
        live
    }

    /// Панели, за которыми что-то числится: по ним подчищаются заявки
    /// закрытых панелей.
    pub fn holding_panels(&self) -> Vec<String> {
        let claims = self.claims.lock().unwrap();
        let mut panels: Vec<String> = claims
            .values()
            .flat_map(|project| project.values().map(|claim| claim.panel_id.clone()))
            .collect();
        panels.sort();
        panels.dedup();
        panels
    }

    /// Панели, ждущие этот файл: держателю показываем, что его ждут.
    pub fn waiting_for(&self, workspace_id: &str, path: &str) -> Vec<String> {
        self.waiting
            .lock()
            .unwrap()
            .get(workspace_id)
            .and_then(|project| project.get(path))
            .cloned()
            .unwrap_or_default()
    }

    fn note_waiting(&self, workspace_id: &str, path: &str, panel_id: &str) {
        let mut waiting = self.waiting.lock().unwrap();
        let panels = waiting
            .entry(workspace_id.to_string())
            .or_default()
            .entry(path.to_string())
            .or_default();
        if !panels.iter().any(|id| id == panel_id) {
            panels.push(panel_id.to_string());
        }
    }

    fn forget_waiting(&self, workspace_id: &str, path: &str, panel_id: &str) {
        let mut waiting = self.waiting.lock().unwrap();
        let Some(project) = waiting.get_mut(workspace_id) else {
            return;
        };
        if let Some(panels) = project.get_mut(path) {
            panels.retain(|id| id != panel_id);
            if panels.is_empty() {
                project.remove(path);
            }
        }
    }
}

/// Заявка в виде, пригодном для показа: с тем, кто её ждёт.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrewClaimView {
    pub path: String,
    pub panel_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    pub since_ms: u64,
    /// Панели, которым этот файл нужен и которые получили отказ.
    pub waiting: Vec<String>,
}

/// Кто из панелей проекта какие файлы держит. Ответ ограничен своим проектом:
/// корень берётся из реестра по id воркспейса, а не из аргументов.
#[tauri::command]
pub async fn crew_claims(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    crew: tauri::State<'_, CrewRegistry>,
    workspace_id: String,
) -> CommandResult<Vec<CrewClaimView>> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    let key = root.to_string_lossy().to_string();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default();
    Ok(crew
        .list(&key, now_ms)
        .into_iter()
        .map(|claim| CrewClaimView {
            waiting: crew.waiting_for(&key, &claim.path),
            path: claim.path,
            panel_id: claim.panel_id,
            task: claim.task,
            since_ms: claim.since_ms,
        })
        .collect())
}

fn expired(since_ms: u64, now_ms: u64) -> bool {
    now_ms.saturating_sub(since_ms) >= CLAIM_TTL_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    const WS: &str = "ws-1";

    fn registry() -> CrewRegistry {
        CrewRegistry::default()
    }

    #[test]
    fn gives_a_free_file_to_the_first_panel_that_asks() {
        let crew = registry();

        assert_eq!(
            crew.claim(WS, "panel-a", "src/app.ts", None, 1_000),
            ClaimOutcome::Granted
        );
        assert_eq!(crew.list(WS, 1_000).len(), 1);
    }

    #[test]
    fn tells_the_second_panel_who_holds_the_file_and_why() {
        let crew = registry();
        crew.claim(
            WS,
            "panel-a",
            "src/app.ts",
            Some("правит модель сессий".into()),
            1_000,
        );

        // Отказ без имени держателя бесполезен: агенту нечего сказать
        // пользователю и не на что опереться, выбирая другой файл.
        let outcome = crew.claim(WS, "panel-b", "src/app.ts", None, 2_000);

        match outcome {
            ClaimOutcome::Held(holder) => {
                assert_eq!(holder.panel_id, "panel-a");
                assert_eq!(holder.task.as_deref(), Some("правит модель сессий"));
                assert_eq!(holder.since_ms, 1_000);
            }
            other => panic!("ожидался отказ с держателем, получено {other:?}"),
        }
    }

    #[test]
    fn lets_the_holder_keep_writing_to_its_own_file() {
        let crew = registry();
        crew.claim(WS, "panel-a", "src/app.ts", None, 1_000);

        // Ход агента — это серия правок одного файла, а не одна.
        assert_eq!(
            crew.claim(WS, "panel-a", "src/app.ts", None, 2_000),
            ClaimOutcome::Granted
        );
        // Повторная заявка продлевает срок, иначе длинный ход упрётся в TTL.
        assert_eq!(crew.list(WS, 2_000)[0].since_ms, 2_000);
    }

    #[test]
    fn hands_the_file_over_once_the_claim_goes_stale() {
        let crew = registry();
        crew.claim(WS, "panel-a", "src/app.ts", None, 1_000);

        // Панель замолчала: заявка, пережившая работу, держит файл вслепую.
        assert_eq!(
            crew.claim(WS, "panel-b", "src/app.ts", None, 1_000 + CLAIM_TTL_MS),
            ClaimOutcome::Granted
        );
        assert_eq!(crew.list(WS, 1_000 + CLAIM_TTL_MS)[0].panel_id, "panel-b");
    }

    #[test]
    fn frees_everything_a_panel_held() {
        let crew = registry();
        crew.claim(WS, "panel-a", "src/app.ts", None, 1_000);
        crew.claim(WS, "panel-a", "src/other.ts", None, 1_000);
        crew.claim(WS, "panel-b", "src/kept.ts", None, 1_000);

        crew.release_panel("panel-a");

        let live = crew.list(WS, 1_000);
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].path, "src/kept.ts");
    }

    #[test]
    fn keeps_projects_apart() {
        let crew = registry();
        crew.claim("ws-1", "panel-a", "src/app.ts", None, 1_000);

        // Тот же путь в другом проекте — другой файл на диске.
        assert_eq!(
            crew.claim("ws-2", "panel-b", "src/app.ts", None, 1_000),
            ClaimOutcome::Granted
        );
        assert_eq!(crew.list("ws-1", 1_000)[0].panel_id, "panel-a");
        assert_eq!(crew.list("ws-2", 1_000)[0].panel_id, "panel-b");
    }

    #[test]
    fn refuses_a_path_that_leaves_the_project() {
        let crew = registry();

        // Путь приходит от агента: за корень проекта он уводить не должен.
        for hostile in ["../secrets.env", "/etc/passwd", "", "nested/../../out"] {
            assert_eq!(
                crew.claim(WS, "panel-a", hostile, None, 1_000),
                ClaimOutcome::Rejected,
                "путь {hostile:?}"
            );
        }
        assert!(crew.list(WS, 1_000).is_empty());
    }

    #[test]
    fn shows_the_holder_that_someone_is_waiting() {
        let crew = registry();
        crew.claim(WS, "panel-a", "src/app.ts", None, 1_000);
        crew.claim(WS, "panel-b", "src/app.ts", None, 2_000);

        // Держатель видит, что файл нужен ещё кому-то, и не бросает его
        // захваченным до самого TTL.
        assert_eq!(crew.waiting_for(WS, "src/app.ts"), vec!["panel-b"]);

        // Ожидание снимается, когда ждавший наконец получил файл.
        crew.release_panel("panel-a");
        crew.claim(WS, "panel-b", "src/app.ts", None, 3_000);
        assert!(crew.waiting_for(WS, "src/app.ts").is_empty());
    }
}
