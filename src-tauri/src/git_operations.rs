use crate::command_error::{CommandError, CommandResult, ErrorCode};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};

pub(crate) fn git_command() -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.env("LC_ALL", "C").env("LANG", "C");
    command
}

pub(crate) fn run_git(root: &Path, args: &[&str]) -> CommandResult<Vec<u8>> {
    run_git_with_env(root, args, &[])
}

pub(crate) fn run_git_with_env(
    root: &Path,
    args: &[&str],
    environment: &[(&str, &str)],
) -> CommandResult<Vec<u8>> {
    let mut command = git_command();
    for (name, value) in environment {
        command.env(name, value);
    }
    let output = command
        .arg("-c")
        .arg("core.quotepath=false")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|error| CommandError::new(ErrorCode::GitUnavailable).with_debug(error))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not a git repository") {
            return Err(CommandError::new(ErrorCode::GitNotARepository));
        }
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context(
                "exitCode",
                output
                    .status
                    .code()
                    .map_or_else(|| "signal".to_string(), |code| code.to_string()),
            )
            .with_debug(stderr.chars().take(4096).collect::<String>()));
    }
    Ok(output.stdout)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Access {
    Shared,
    Exclusive,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Waiter {
    id: u64,
    access: Access,
}

#[derive(Default)]
struct QueueState {
    next_id: u64,
    readers: usize,
    writer: bool,
    waiting: VecDeque<Waiter>,
}

#[derive(Default)]
struct FairQueue {
    state: Mutex<QueueState>,
    changed: Condvar,
}

impl FairQueue {
    fn acquire(self: &Arc<Self>, access: Access) -> QueueGuard {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let id = state.next_id;
        state.next_id = state.next_id.wrapping_add(1);
        state.waiting.push_back(Waiter { id, access });

        loop {
            let position = state
                .waiting
                .iter()
                .position(|waiter| waiter.id == id)
                .expect("queued Git operation disappeared");
            let can_enter = match access {
                Access::Shared => {
                    !state.writer
                        && !state
                            .waiting
                            .iter()
                            .take(position)
                            .any(|waiter| waiter.access == Access::Exclusive)
                }
                Access::Exclusive => !state.writer && state.readers == 0 && position == 0,
            };
            if can_enter {
                state.waiting.remove(position);
                match access {
                    Access::Shared => state.readers += 1,
                    Access::Exclusive => state.writer = true,
                }
                self.changed.notify_all();
                return QueueGuard {
                    queue: Arc::clone(self),
                    access,
                };
            }
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

struct QueueGuard {
    queue: Arc<FairQueue>,
    access: Access,
}

impl Drop for QueueGuard {
    fn drop(&mut self) {
        let mut state = self
            .queue
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match self.access {
            Access::Shared => state.readers = state.readers.saturating_sub(1),
            Access::Exclusive => state.writer = false,
        }
        self.queue.changed.notify_all();
    }
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
enum ScopeKind {
    CommonGitDir,
    Worktree,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
struct ScopeKey {
    kind: ScopeKind,
    path: PathBuf,
}

#[derive(Clone, Debug)]
struct OperationScope {
    common_git_dir: PathBuf,
    worktree: PathBuf,
}

fn resolve_git_path(root: &Path, raw: &[u8]) -> Option<PathBuf> {
    let value = String::from_utf8_lossy(raw).trim().to_owned();
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    let absolute = if path.is_absolute() {
        path
    } else {
        root.join(path)
    };
    Some(std::fs::canonicalize(&absolute).unwrap_or(absolute))
}

fn operation_scope(root: &Path) -> OperationScope {
    let fallback = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let common_git_dir = run_git(root, &["rev-parse", "--git-common-dir"])
        .ok()
        .and_then(|raw| resolve_git_path(root, &raw))
        .unwrap_or_else(|| fallback.clone());
    let worktree = run_git(root, &["rev-parse", "--show-toplevel"])
        .ok()
        .and_then(|raw| resolve_git_path(root, &raw))
        .unwrap_or(fallback);
    OperationScope {
        common_git_dir,
        worktree,
    }
}

#[derive(Clone, Default)]
pub(crate) struct GitOperationCoordinator {
    queues: Arc<Mutex<HashMap<ScopeKey, Weak<FairQueue>>>>,
}

impl GitOperationCoordinator {
    fn queue(&self, key: ScopeKey) -> Arc<FairQueue> {
        let mut queues = self
            .queues
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        queues.retain(|_, queue| queue.strong_count() > 0);
        if let Some(queue) = queues.get(&key).and_then(Weak::upgrade) {
            return queue;
        }
        let queue = Arc::new(FairQueue::default());
        queues.insert(key, Arc::downgrade(&queue));
        queue
    }

    fn acquire(&self, root: &Path, access: Access) -> Vec<QueueGuard> {
        let scope = operation_scope(root);
        let mut queues = [
            ScopeKey {
                kind: ScopeKind::CommonGitDir,
                path: scope.common_git_dir,
            },
            ScopeKey {
                kind: ScopeKind::Worktree,
                path: scope.worktree,
            },
        ];
        queues.sort();
        queues
            .into_iter()
            .map(|key| self.queue(key).acquire(access))
            .collect()
    }

    pub(crate) fn run_shared<T>(
        &self,
        root: &Path,
        task: impl FnOnce() -> CommandResult<T>,
    ) -> CommandResult<T> {
        let _guards = self.acquire(root, Access::Shared);
        task()
    }

    pub(crate) fn run_exclusive<T>(
        &self,
        root: &Path,
        task: impl FnOnce() -> CommandResult<T>,
    ) -> CommandResult<T> {
        let _guards = self.acquire(root, Access::Exclusive);
        task()
    }
}

fn global_coordinator() -> &'static GitOperationCoordinator {
    static COORDINATOR: OnceLock<GitOperationCoordinator> = OnceLock::new();
    COORDINATOR.get_or_init(GitOperationCoordinator::default)
}

pub(crate) fn run_shared<T>(
    root: &Path,
    task: impl FnOnce() -> CommandResult<T>,
) -> CommandResult<T> {
    global_coordinator().run_shared(root, task)
}

pub(crate) fn run_exclusive<T>(
    root: &Path,
    task: impl FnOnce() -> CommandResult<T>,
) -> CommandResult<T> {
    global_coordinator().run_exclusive(root, task)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    fn init_repo(root: &Path) {
        let output = Command::new("git")
            .args(["init", "--quiet", "--initial-branch=main"])
            .current_dir(root)
            .output()
            .unwrap();
        assert!(output.status.success());
    }

    #[test]
    fn exclusive_operations_are_queued_in_order() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let coordinator = GitOperationCoordinator::default();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        let first_root = dir.path().to_path_buf();
        let first_coordinator = coordinator.clone();
        let first = thread::spawn(move || {
            first_coordinator
                .run_exclusive(&first_root, || {
                    entered_tx.send("first").unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
                .unwrap();
        });
        assert_eq!(
            entered_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            "first"
        );

        let (second_tx, second_rx) = mpsc::channel();
        let second_root = dir.path().to_path_buf();
        let second_coordinator = coordinator.clone();
        let second = thread::spawn(move || {
            second_coordinator
                .run_exclusive(&second_root, || {
                    second_tx.send(()).unwrap();
                    Ok(())
                })
                .unwrap();
        });
        assert!(second_rx.recv_timeout(Duration::from_millis(100)).is_err());
        release_tx.send(()).unwrap();
        second_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        first.join().unwrap();
        second.join().unwrap();
    }

    #[test]
    fn unrelated_repositories_do_not_block_each_other() {
        let first_dir = tempfile::tempdir().unwrap();
        let second_dir = tempfile::tempdir().unwrap();
        init_repo(first_dir.path());
        init_repo(second_dir.path());
        let coordinator = GitOperationCoordinator::default();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        let first_root = first_dir.path().to_path_buf();
        let first_coordinator = coordinator.clone();
        let first = thread::spawn(move || {
            first_coordinator
                .run_exclusive(&first_root, || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
                .unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let (second_tx, second_rx) = mpsc::channel();
        let second_root = second_dir.path().to_path_buf();
        let second_coordinator = coordinator.clone();
        let second = thread::spawn(move || {
            second_coordinator
                .run_exclusive(&second_root, || {
                    second_tx.send(()).unwrap();
                    Ok(())
                })
                .unwrap();
        });
        second_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        release_tx.send(()).unwrap();
        first.join().unwrap();
        second.join().unwrap();
    }

    #[test]
    fn shared_operations_overlap_but_a_waiting_writer_blocks_later_readers() {
        let queue = Arc::new(FairQueue::default());
        let first_reader = queue.acquire(Access::Shared);
        let (overlap_tx, overlap_rx) = mpsc::channel();
        let overlap_queue = Arc::clone(&queue);
        let overlap = thread::spawn(move || {
            let _guard = overlap_queue.acquire(Access::Shared);
            overlap_tx.send(()).unwrap();
        });
        overlap_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        overlap.join().unwrap();

        let (writer_tx, writer_rx) = mpsc::channel();
        let writer_queue = Arc::clone(&queue);
        let writer = thread::spawn(move || {
            let _guard = writer_queue.acquire(Access::Exclusive);
            writer_tx.send(()).unwrap();
            thread::sleep(Duration::from_millis(100));
        });
        thread::sleep(Duration::from_millis(30));

        let (reader_tx, reader_rx) = mpsc::channel();
        let reader_queue = Arc::clone(&queue);
        let reader = thread::spawn(move || {
            let _guard = reader_queue.acquire(Access::Shared);
            reader_tx.send(()).unwrap();
        });
        assert!(reader_rx.recv_timeout(Duration::from_millis(100)).is_err());
        drop(first_reader);
        writer_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(reader_rx.recv_timeout(Duration::from_millis(30)).is_err());
        writer.join().unwrap();
        reader_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        reader.join().unwrap();
    }

    #[test]
    fn linked_worktrees_share_the_common_repository_queue() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        run_git(root, &["config", "user.name", "Test"]).unwrap();
        run_git(root, &["config", "user.email", "test@example.com"]).unwrap();
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        run_git(root, &["add", "."]).unwrap();
        run_git(root, &["commit", "--quiet", "-m", "init"]).unwrap();
        let linked = root.join("linked");
        run_git(
            root,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "linked",
                linked.to_str().unwrap(),
            ],
        )
        .unwrap();

        let coordinator = GitOperationCoordinator::default();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let first_root = root.to_path_buf();
        let first_coordinator = coordinator.clone();
        let first = thread::spawn(move || {
            first_coordinator
                .run_exclusive(&first_root, || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
                .unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let (linked_tx, linked_rx) = mpsc::channel();
        let linked_coordinator = coordinator.clone();
        let second = thread::spawn(move || {
            linked_coordinator
                .run_exclusive(&linked, || {
                    linked_tx.send(()).unwrap();
                    Ok(())
                })
                .unwrap();
        });
        assert!(linked_rx.recv_timeout(Duration::from_millis(100)).is_err());
        release_tx.send(()).unwrap();
        linked_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        first.join().unwrap();
        second.join().unwrap();
    }
}
