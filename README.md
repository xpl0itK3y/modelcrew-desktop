<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="120" alt="ModelCrew logo" />

# ModelCrew

[![Release](https://img.shields.io/github/v/release/xpl0itK3y/modelcrew-desktop?label=release&color=e8567c)](https://github.com/xpl0itK3y/modelcrew-desktop/releases)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-backend-CE412B?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Platforms](https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-supported-4fb864)](https://github.com/xpl0itK3y/modelcrew-desktop/releases)
[![License](https://img.shields.io/badge/license-MIT-6f7bde)](LICENSE)

### A fast terminal workspace for running AI coding agents side by side

Six agents, six panels — with live git diffs, per-panel history,
and a nudge the moment one of them needs you.

[**How it works**](#how-it-works) · [**Features**](#features) · [**Supported agents**](#supported-agents) · [**Install**](#install) · [**Shortcuts**](#keyboard-shortcuts) · [**Development**](#development)

</div>

---

ModelCrew is a desktop terminal manager for working with several AI coding
agents at once. Terminals arrange themselves into a grid, live inside project
workspaces, come back after a restart with their text and their conversations,
and say when one of them is waiting for you.

Built on **Tauri 2** with a Rust **portable-pty** backend, **React 18**,
**TypeScript**, **Vite**, **xterm.js** and **dockview**.

## How it works

<div align="center">
<img src="docs/assets/flow.gif" alt="Panels talk to their own PTY, each PTY runs one agent CLI; agents ask the claim guard before writing and send hook events; changes come back as live diffs in the git panel and alerts come back to you" width="100%" />
</div>

Every panel is a terminal of its own: its own PTY, its own shell history, its
own agent conversation. What the agents do next runs through two places the
application keeps for itself — the guard that hands out files, and the hooks
that say when someone is waiting. Both loops close back on the window: edits
show up as live diffs, and a waiting agent finds you wherever you are.

## Features

| Feature | What it does |
|---|---|
| **Fleet grid layout** | New terminals split the grid automatically, while any panel can still be zoomed to the full window. |
| **Session restore** | Every session of a project comes back alive at launch — terminals reopen with their previous text and each panel resumes **its own** agent conversation, bound precisely per panel. |
| **One project, several agents** | Before an agent edits a file it claims it; a file already taken is left to its neighbour, and a write over a stale read is refused. Each agent hears the refusal in its own protocol — an exit code, a JSON decision, a plugin error. |
| **Live git panel** | Uncommitted changes in real time as agents edit files: per-file diffs with live counters, a commit box, one-click revert, a branch switcher and history with a graph. An unfinished merge, rebase, cherry-pick or revert is named by a banner with Continue and Abort, and a commit is refused while conflict markers are still in the files. |
| **Project tree and editor** | The project's files beside the terminals: a tree that follows the disk, search by name, and a column of its own for the open file with syntax highlighting and line numbers. |
| **Agent alerts** | When an out-of-sight agent finishes or waits for your decision, ModelCrew plays a sound, shows a system banner naming the agent and project, and badges the app icon with the count of waiting panels. |
| **Per-panel history** | Each terminal keeps its own shell history (zsh, bash, fish), so pressing arrow-up never leaks commands between panels. |
| **Resilient updates** | Signed auto-updates download in the background into a persistent cache — a restart never re-downloads — with progress and release notes in the notification center. A downloaded update keeps its badge until it is installed, so reading the notification never hides it. |

**Also inside:** projects → sessions → terminals (one folder = one project,
enforced by the backend, friendly codenames like `amber-lynx`) · native PTY
backend with batched output and WebGL rendering · titles that follow the
foreground process · nine themes, eighteen accent colors, shell picker, font
size and notification sounds · English / Russian interface · macOS, Windows
and Linux installers with auto-update.

### One project, several agents

Two agents in one folder used to overwrite each other's work. Now a file is
claimed before it is edited, and a write over a stale read is refused.

<div align="center">
<img src="docs/assets/claims.gif" alt="Claude Code claims src/app.ts and is granted it; Codex asks for the same file, is refused, and claims src/api.ts instead" width="100%" />
</div>

### When an agent needs you

<div align="center">
<img src="docs/assets/alerts.gif" alt="An agent event checks whether its panel is in use; if it is not, a sound, a system banner and a dock badge go out, and one click opens that very panel" width="100%" />
</div>

## Supported agents

Each panel remembers **which** conversation it was running and resumes exactly
that one — six Claude Code panels get six different chats. Ten CLIs are
recognized:

<div align="center">

`Claude Code` · `Codex` · `GitHub Copilot` · `OpenCode` · `Kilo Code` ·
`Kimi Code` · `Grok Build` · `Cursor` · `Aider` · `Antigravity`

</div>

## Install

Download installers from the
[**Releases**](https://github.com/xpl0itK3y/modelcrew-desktop/releases) page:

| Platform | Packages |
|---|---|
| **macOS** | `.dmg` (Apple Silicon, Intel) |
| **Windows** | setup `.exe`, `.msi` |
| **Linux** | `.AppImage`, `.deb`, `.rpm`, `.pkg.tar.zst` |

On Arch Linux, prefer the native package:

```bash
sudo pacman -U ModelCrew_x.y.z_linux_x86_64.pkg.tar.zst
```

…or build `modelcrew-bin` from the attached `PKGBUILD`. Both x86_64 and
aarch64 packages are compiled on Arch itself, against the same libraries they
will run with. Every package declares what ModelCrew runs at runtime — `git`
for the change panel, `pkexec` for installing updates, `xdg-open` for links,
plus WebKitGTK, GStreamer audio plugins and tray support. The AppImage carries
GStreamer itself so notification sounds work out of the box.

> **Linux notifications:** system banners use the standard
> `org.freedesktop.Notifications` D-Bus service. Desktop environments
> provide it out of the box; bare window managers (Hyprland, i3, sway) need
> a notification daemon such as `mako` or `dunst` running.

> **AppImage requirements:** the image carries its own WebKitGTK, GTK and
> GStreamer, but never its own `libc`, GPU drivers or `git` — those always
> come from your system. It therefore needs a distribution at least as new as
> the one it was built on (Ubuntu 22.04), and `libfuse2` to mount itself. On
> distributions that ship only FUSE 3, run it without mounting:
> ```bash
> ./ModelCrew_x.y.z_linux_x86_64.AppImage --appimage-extract-and-run
> ```

> **Black window on Linux:** WebKitGTK's DMABUF renderer leaves a blank
> window on some drivers, so ModelCrew disables it by default. Set
> `WEBKIT_DISABLE_DMABUF_RENDERER=0` to get the faster path back, or `=1` to
> keep it off explicitly. If a window still stays black, turn accelerated
> compositing off as well:
> ```bash
> WEBKIT_DISABLE_COMPOSITING_MODE=1 modelcrew-desktop
> ```

## Keyboard shortcuts

| macOS | Windows / Linux | Action |
|---|---|---|
| ⌘T | Ctrl&nbsp;+&nbsp;T | Add a terminal to the grid |
| ⌘W | Ctrl&nbsp;+&nbsp;W | Close the terminal |
| ⌘⇧W | Ctrl&nbsp;+&nbsp;Shift&nbsp;+&nbsp;W | Close the group, with confirmation |
| ⌘↩ | Ctrl&nbsp;+&nbsp;Enter | Expand the terminal or restore the grid |
| hold&nbsp;⌘⌥ | hold&nbsp;Ctrl&nbsp;+&nbsp;Alt | Show panel numbers while the keys are held |
| ⌘⌥&nbsp;+&nbsp;digit | Ctrl&nbsp;+&nbsp;Alt&nbsp;+&nbsp;digit | Focus a panel by its number |
| ⌘⌥&nbsp;+&nbsp;arrows | Ctrl&nbsp;+&nbsp;Alt&nbsp;+&nbsp;arrows | Focus the neighbouring panel |
| ⌘⌥⇧&nbsp;+&nbsp;digit | Ctrl&nbsp;+&nbsp;Alt&nbsp;+&nbsp;Shift&nbsp;+&nbsp;digit | Swap with the panel of that number |
| ⌘⇧&nbsp;+&nbsp;arrows | Ctrl&nbsp;+&nbsp;Shift&nbsp;+&nbsp;arrows | Move the panel aside |

The reference inside Settings adapts to your keyboard and is the one that is
always current.

**Mouse tips**

- ⌘ (Ctrl) + drag a terminal anywhere to swap panels.
- Double-click a panel title to rename it (pins the name).
- Double-click a project or session in the sidebar to rename it.
- Drag the divider between columns to resize; double-click it to reset.
- The gear in the title bar opens Settings (appearance, terminal, notifications).

## Development

```bash
npm install
npm run tauri dev     # dev mode
npm run tauri build   # release build (.app / installer)
```

```bash
npm test                       # frontend tests (vitest)
cd src-tauri && cargo test     # backend tests (PTY, git, batching, stress)
```

The Git backend is also covered end to end against a real server. Those runs
need network access and write permission, so they are opt-in:

```bash
MODELCREW_TEST_REMOTE=git@github.com:you/scratch-repo.git \
  cargo test -- --ignored live_workflow
```

It publishes a uniquely named `modelcrew-test/…` branch, drives push, pull,
divergence and rebase through it, and deletes the branch afterwards.

<details>
<summary><b>Releases and updates</b></summary>

<br>

The version is changed with a single command:

```bash
npm run version:set -- x.y.z
```

It synchronizes npm and Cargo, creates a bilingual template in
`release-notes/` and a section in `CHANGELOG.md`, but does **not** create a
Git tag. Validate the metadata before tagging:

```bash
npm run release-scripts:test
npm run release-notes:validate
npm run changelog:validate
npm run release:validate
```

Every push to `main` builds nightly artifacts, and a `vX.Y.Z` tag runs the
stable workflow. Installers and `latest.json` are published on the
[Releases](https://github.com/xpl0itK3y/modelcrew-desktop/releases) page.
Key setup, package formats, and manual verification are described in
[`packaging/README.md`](packaging/README.md).

</details>

## License

[MIT](LICENSE)
