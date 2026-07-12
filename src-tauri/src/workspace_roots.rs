use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Clone, Debug)]
struct WorkspaceRoot {
    canonical_path: PathBuf,
    identity_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRootBinding {
    pub workspace_id: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BindOutcome {
    Bound(WorkspaceRootBinding),
    AlreadyOpen(WorkspaceRootBinding),
}

/// Единственный доверенный источник cwd терминалов.
/// Frontend знает путь только для отображения и восстановления связи, но PTY
/// всегда получает каталог через workspace_id из этого реестра.
#[derive(Default)]
pub struct WorkspaceRoots {
    roots: Mutex<HashMap<String, WorkspaceRoot>>,
}

impl WorkspaceRoots {
    pub fn bind(&self, workspace_id: &str, selected_path: &Path) -> Result<BindOutcome, String> {
        validate_workspace_id(workspace_id)?;
        let canonical_path = validate_root(selected_path)?;
        let identity_key = identity_key(&canonical_path)?;

        let mut roots = self.roots.lock().unwrap();
        if let Some(existing) = roots.get(workspace_id) {
            if existing.identity_key == identity_key {
                return Ok(BindOutcome::Bound(binding(workspace_id, existing)?));
            }
            return Err(format!(
                "воркспейс {workspace_id} уже связан с другой папкой"
            ));
        }

        if let Some((existing_id, existing)) = roots
            .iter()
            .find(|(_, root)| root.identity_key == identity_key)
        {
            return Ok(BindOutcome::AlreadyOpen(binding(existing_id, existing)?));
        }

        let root = WorkspaceRoot {
            canonical_path,
            identity_key,
        };
        let result = binding(workspace_id, &root)?;
        roots.insert(workspace_id.to_owned(), root);
        Ok(BindOutcome::Bound(result))
    }

    /// Явная смена папки разрешена только после нативного picker: это
    /// отдельный путь от восстановления, которое не может молча перепривязать
    /// существующий workspace_id к данным из frontend-хранилища.
    pub fn bind_user_selected(
        &self,
        workspace_id: &str,
        selected_path: &Path,
    ) -> Result<BindOutcome, String> {
        validate_workspace_id(workspace_id)?;
        let canonical_path = validate_root(selected_path)?;
        let identity_key = identity_key(&canonical_path)?;
        let mut roots = self.roots.lock().unwrap();

        if let Some((existing_id, existing)) = roots
            .iter()
            .find(|(id, root)| id.as_str() != workspace_id && root.identity_key == identity_key)
        {
            return Ok(BindOutcome::AlreadyOpen(binding(existing_id, existing)?));
        }

        let root = WorkspaceRoot {
            canonical_path,
            identity_key,
        };
        let result = binding(workspace_id, &root)?;
        roots.insert(workspace_id.to_owned(), root);
        Ok(BindOutcome::Bound(result))
    }

    pub fn resolve(&self, workspace_id: &str) -> Result<PathBuf, String> {
        validate_workspace_id(workspace_id)?;
        let root = self
            .roots
            .lock()
            .unwrap()
            .get(workspace_id)
            .cloned()
            .ok_or_else(|| format!("папка воркспейса {workspace_id} не зарегистрирована"))?;

        // Проверяем ещё раз непосредственно перед spawn: папку могли удалить,
        // заменить или отключить вместе с внешним диском после регистрации.
        let canonical_path = validate_root(&root.canonical_path)?;
        let current_identity = identity_key(&canonical_path)?;
        if current_identity != root.identity_key {
            return Err(format!(
                "папка воркспейса {workspace_id} была заменена; выберите её заново"
            ));
        }
        Ok(canonical_path)
    }

    pub fn unbind(&self, workspace_id: &str) -> Result<(), String> {
        validate_workspace_id(workspace_id)?;
        self.roots.lock().unwrap().remove(workspace_id);
        Ok(())
    }

    /// Frontend может перезагрузиться отдельно от Rust во время разработки.
    /// Удаляем связи с workspace_id, которых больше нет в восстановленном
    /// состоянии, иначе неуспешное создание навсегда «занимает» папку.
    pub fn retain_only(&self, workspace_ids: &[String]) -> Result<(), String> {
        for workspace_id in workspace_ids {
            validate_workspace_id(workspace_id)?;
        }
        self.roots
            .lock()
            .unwrap()
            .retain(|workspace_id, _| workspace_ids.iter().any(|id| id == workspace_id));
        Ok(())
    }
}

fn validate_workspace_id(workspace_id: &str) -> Result<(), String> {
    if workspace_id.is_empty()
        || workspace_id.len() > 128
        || !workspace_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("некорректный идентификатор воркспейса".into());
    }
    Ok(())
}

fn validate_root(path: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("папка проекта недоступна: {error}"))?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("не удалось проверить папку проекта: {error}"))?;
    if !metadata.is_dir() {
        return Err(format!("путь не является папкой: {}", path.display()));
    }
    if canonical.to_str().is_none() {
        return Err("путь проекта содержит неподдерживаемые символы".into());
    }
    Ok(canonical)
}

#[cfg(unix)]
fn identity_key(path: &Path) -> Result<String, String> {
    use std::os::unix::fs::MetadataExt;

    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("не удалось определить папку проекта: {error}"))?;
    Ok(format!("unix:{}:{}", metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn identity_key(path: &Path) -> Result<String, String> {
    Ok(format!(
        "path:{}",
        path.to_string_lossy().to_lowercase()
    ))
}

fn binding(workspace_id: &str, root: &WorkspaceRoot) -> Result<WorkspaceRootBinding, String> {
    let path = root
        .canonical_path
        .to_str()
        .ok_or_else(|| "путь проекта содержит неподдерживаемые символы".to_string())?;
    Ok(WorkspaceRootBinding {
        workspace_id: workspace_id.to_owned(),
        path: path.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "modelcrew-workspace-roots-{label}-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn bind_resolve_and_unbind() {
        let path = temp_dir("resolve");
        let roots = WorkspaceRoots::default();

        let outcome = roots.bind("workspace-1", &path).unwrap();
        let BindOutcome::Bound(binding) = outcome else {
            panic!("новая папка должна зарегистрироваться")
        };
        assert_eq!(binding.workspace_id, "workspace-1");
        assert_eq!(roots.resolve("workspace-1").unwrap(), path.canonicalize().unwrap());

        roots.unbind("workspace-1").unwrap();
        assert!(roots.resolve("workspace-1").is_err());
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn one_root_cannot_belong_to_two_workspaces() {
        let path = temp_dir("duplicate");
        let roots = WorkspaceRoots::default();
        roots.bind("workspace-a", &path).unwrap();

        let outcome = roots.bind("workspace-b", &path).unwrap();
        let BindOutcome::AlreadyOpen(binding) = outcome else {
            panic!("дубликат должен вернуть существующий воркспейс")
        };
        assert_eq!(binding.workspace_id, "workspace-a");
        assert!(roots.resolve("workspace-b").is_err());
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn workspace_cannot_silently_change_root() {
        let first = temp_dir("first");
        let second = temp_dir("second");
        let roots = WorkspaceRoots::default();
        roots.bind("workspace", &first).unwrap();

        let error = roots.bind("workspace", &second).unwrap_err();
        assert!(error.contains("уже связан"), "ошибка: {error}");
        assert_eq!(roots.resolve("workspace").unwrap(), first.canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(first);
        let _ = std::fs::remove_dir_all(second);
    }

    #[test]
    fn native_selection_can_explicitly_change_root() {
        let first = temp_dir("selected-first");
        let second = temp_dir("selected-second");
        let roots = WorkspaceRoots::default();
        roots.bind("workspace", &first).unwrap();

        let outcome = roots.bind_user_selected("workspace", &second).unwrap();
        assert!(matches!(outcome, BindOutcome::Bound(_)));
        assert_eq!(
            roots.resolve("workspace").unwrap(),
            second.canonicalize().unwrap()
        );
        let _ = std::fs::remove_dir_all(first);
        let _ = std::fs::remove_dir_all(second);
    }

    #[test]
    fn missing_root_fails_closed() {
        let path = temp_dir("missing");
        let roots = WorkspaceRoots::default();
        roots.bind("workspace", &path).unwrap();
        std::fs::remove_dir_all(&path).unwrap();

        let error = roots.resolve("workspace").unwrap_err();
        assert!(error.contains("недоступна"), "ошибка: {error}");
    }

    #[test]
    fn reconcile_removes_stale_workspace_bindings() {
        let first = temp_dir("retain-first");
        let second = temp_dir("retain-second");
        let roots = WorkspaceRoots::default();
        roots.bind("workspace-a", &first).unwrap();
        roots.bind("workspace-b", &second).unwrap();

        roots.retain_only(&["workspace-b".into()]).unwrap();
        assert!(roots.resolve("workspace-a").is_err());
        assert_eq!(
            roots.resolve("workspace-b").unwrap(),
            second.canonicalize().unwrap()
        );
        assert!(matches!(
            roots.bind("workspace-c", &first).unwrap(),
            BindOutcome::Bound(_)
        ));
        let _ = std::fs::remove_dir_all(first);
        let _ = std::fs::remove_dir_all(second);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_alias_is_the_same_root() {
        use std::os::unix::fs::symlink;

        let path = temp_dir("symlink");
        let alias = path.with_extension("alias");
        symlink(&path, &alias).unwrap();
        let roots = WorkspaceRoots::default();
        roots.bind("workspace-a", &path).unwrap();

        let outcome = roots.bind("workspace-b", &alias).unwrap();
        let BindOutcome::AlreadyOpen(binding) = outcome else {
            panic!("симлинк должен распознаться как та же папка")
        };
        assert_eq!(binding.workspace_id, "workspace-a");
        let _ = std::fs::remove_file(alias);
        let _ = std::fs::remove_dir_all(path);
    }
}
