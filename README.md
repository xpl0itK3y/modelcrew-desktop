<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" alt="ModelCrew logo" />
</p>

<h1 align="center">ModelCrew</h1>

<p align="center">
  A fast terminal workspace for running AI coding agents side by side.
</p>

ModelCrew is a modular agent-based development system where each agent role
can run on a separate model, and the user stays in control of quality, cost,
security, and the level of autonomy.

The current version is the terminal foundation: a desktop terminal manager
built with **Tauri 2 + React + xterm.js + dockview + portable-pty**.
Terminals arrange themselves into a fleet grid, live inside project
workspaces, are driven by mouse and hotkeys, and panels automatically title
themselves after the running program.

## Features

- **Fleet grid layout** — new terminals split the grid automatically
  (row-based), drag splits to resize, zoom any panel to full window.
- **Projects → sessions → terminals** — each workspace is bound to a project
  folder (one folder = one project, enforced by the backend); sessions keep
  independent layouts and get friendly codenames like `amber-lynx`.
- **Native PTY backend** — real pseudo-terminals via Rust `portable-pty`,
  batched output, WebGL rendering; panel titles follow the foreground
  process (`codex`, `vim`, …).
- **Persistent state** — layouts, projects, and sessions survive restarts.
- **Settings** — interface language (English/Russian), six themes, accent
  colors, shell picker, terminal font size, and notification sounds.
- **Notification center** — automatic signed updates with download progress,
  release announcements, an unread-count badge on the bell, and a resizable
  popover.
- **Cross-platform** — macOS, Windows, and Linux installers with
  auto-update.

## Install

Download installers from
[Releases](https://github.com/xpl0itK3y/modelcrew-desktop/releases):

| Platform | Packages |
|---|---|
| macOS | `.dmg` (Apple Silicon, Intel) |
| Windows | setup `.exe`, `.msi` |
| Linux | `.AppImage`, `.deb`, `.rpm`, `.pkg.tar.zst` |

On Arch Linux, prefer the native package: `sudo pacman -U
ModelCrew_x.y.z_linux_x86_64.pkg.tar.zst` (or build `modelcrew-bin` from the
attached `PKGBUILD`). Runtime dependencies — WebKitGTK, GStreamer audio
plugins, tray support — are declared in every package, and the AppImage
bundles GStreamer so notification sounds work out of the box.

## Development

```bash
npm install
npm run tauri dev     # dev mode
npm run tauri build   # release build (.app / installer)
```

Frontend tests (vitest):

```bash
npm test
```

Backend tests (PTY, batching, stress):

```bash
cd src-tauri && cargo test
```

## Releases and updates

The version is changed with a single command:

```bash
npm run version:set -- 0.0.2
```

It synchronizes npm and Cargo, creates a bilingual template in
`release-notes/` and a section in `CHANGELOG.md`, but does not create a Git
tag. Validate the metadata before tagging:

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

## Keyboard shortcuts

| macOS | Windows / Linux | Action |
|---|---|---|
| ⌘T | Ctrl+T | New terminal in the grid |
| ⌘W | Ctrl+W | Close the active terminal |
| ⌘⇧W | Ctrl+Shift+W | Close the group (with confirmation) |
| ⌘⌥ + arrows | Ctrl+Alt + arrows | Focus the neighboring terminal |
| ⌘⇧ + arrows | Ctrl+Shift + arrows | Swap with the neighbor; at an edge — new split |
| hold ⌘⌥ | hold Ctrl+Alt | Show panel numbers overlay |
| ⌘⌥ + digit | Ctrl+Alt + digit | Focus panel № |
| ⌘⌥⇧ + digit | Ctrl+Alt+Shift + digit | Swap the active panel with № |
| ⌘↩ | Ctrl+Enter | Zoom the panel / restore the layout |
| ⌘⌥ +/− | Ctrl+Alt +/− | Grow/shrink the panel by 5% |
| ⌘ + drag | Ctrl + drag | Drag a terminal anywhere to swap panels |

Mouse tips:

- Double-click a panel title to rename it (pins the name).
- Double-click a project or session in the sidebar to rename it.
- The gear in the title bar opens Settings (appearance, terminal,
  notifications).

## What's next (v0.2+)

Agent orchestration (swarm), a kanban task board, memory with a relation
graph, and a built-in browser preview — on top of this foundation.
