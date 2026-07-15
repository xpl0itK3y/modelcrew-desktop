import type { MessageKey } from "./ru";

export const en: Record<MessageKey, string> = {
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.delete": "Delete",

  "titlebar.toggleSidebar": "Show or hide sidebar",
  "titlebar.newTerminal": "Add terminal to grid",
  "titlebar.layoutsSoon": "Layouts — coming soon",
  "titlebar.notificationsSoon": "Notifications — coming soon",
  "titlebar.notifications": "Notifications",
  "titlebar.updateReady": "Update {version} is ready",
  "titlebar.updatesUnavailable":
    "Updates are available in the installed application",
  "titlebar.settings": "Settings",

  "update.title": "Updates",
  "update.idleDescription":
    "ModelCrew checks for and downloads updates in the background.",
  "update.checkNow": "Check for updates",
  "update.checking": "Checking for a new version…",
  "update.upToDate": "You’re up to date",
  "update.upToDateDescription":
    "There are no new stable updates right now.",
  "update.checkAgain": "Check again",
  "update.downloading": "Downloading ModelCrew {version}",
  "update.downloadingDescription":
    "You can keep working — your terminals will stay open.",
  "update.downloadProgress": "Update download progress",
  "update.downloaded": "Downloaded {downloaded}",
  "update.downloadedOf": "{downloaded} of {total}",
  "update.verifying": "Verifying the downloaded update",
  "update.verifyingDescription":
    "Checking the system package signature and integrity.",
  "update.version": "Update {version} is ready",
  "update.readyTitle": "ModelCrew {version} update",
  "update.fallbackSummary":
    "A new ModelCrew version is available. Full details are on the release page.",
  "update.manualPackageHelp":
    "ModelCrew could not safely identify this installation format. Open the downloads page and choose the matching package manually.",
  "update.details": "Details",
  "update.later": "Later",
  "update.openDownloads": "Open download page",
  "update.restartAndInstall": "Restart and update",
  "update.confirmTitle": "Restart ModelCrew?",
  "update.confirmWarning":
    "Terminals and running processes will close. Your projects, sessions and layout will be saved.",
  "update.nativeConfirmWarning":
    "Linux will request system authorization. After installation, terminals and running processes will close. Your projects, sessions and layout will be saved.",
  "update.confirmRestart": "Restart",
  "update.authorizing": "Waiting for system authorization",
  "update.authorizingDescription":
    "Approve the installation in the Linux system dialog. It will then continue automatically.",
  "update.authorizationCancelledTitle": "Installation was not authorized",
  "update.authorizationCancelledDescription":
    "System authorization was cancelled. The update was not installed and your terminals are still running.",
  "update.manualInstallHint":
    "The package is already downloaded to /tmp/modelcrew-update-…. You can install it manually: sudo pacman -U <file> (deb: dpkg -i, rpm: rpm -U). If your password is correct but authorization keeps failing, make sure a polkit agent is running in your session.",
  "update.installing": "Installing ModelCrew {version}",
  "update.installingDescription":
    "The application will restart after the update is installed.",
  "update.nativeInstallingDescription":
    "Approve the system dialog if it appears. Linux will install the package automatically — keep ModelCrew open.",
  "update.restarting": "Restarting ModelCrew {version}",
  "update.restartingDescription":
    "The update is installed. Saving your workspace state and restarting the application.",
  "update.errorTitle": "ModelCrew could not be updated",
  "update.errorCheck": "Could not check for a new version.",
  "update.errorDownload": "Could not download the update.",
  "update.errorInstall": "Could not install the downloaded update.",
  "update.retry": "Try again",
  "update.close": "Close update notifications",
  "update.resize": "Drag to resize",
  "update.notificationsTitle": "Notifications",
  "update.refreshingNotifications": "Refreshing notifications…",
  "update.empty": "No notifications yet",
  "update.versionLabel": "ModelCrew {version}",
  "update.downloadRetry":
    "The download did not finish. We’ll retry automatically.",
  "update.installFailedTitle": "The update could not be installed",
  "update.installFailedDescription":
    "Try installing it again. ModelCrew will ask you to confirm the restart before another attempt.",
  "update.retryInstall": "Retry installation",
  "update.restartFailedTitle":
    "The update was installed, but ModelCrew did not restart",
  "update.restartFailedDescription":
    "You do not need to install it again. Press “Retry restart”, or simply quit the app and open it again — the new version will start.",
  "update.retryRestart": "Retry restart",

  "sidebar.title": "Projects",
  "sidebar.newWorkspace": "New project",
  "sidebar.deleteWorkspace": "Delete project",
  "sidebar.homeFolder": "Home folder",
  "sidebar.renameWorkspace": "Rename project",
  "sidebar.expandWorkspace": "Expand project “{name}”",
  "sidebar.collapseWorkspace": "Collapse project “{name}”",
  "sidebar.workspaceActions": "Actions for project “{name}”",
  "sidebar.newSessionIn": "New session in project “{name}”",
  "sidebar.renameSession": "Rename session",
  "sidebar.deleteSession": "Delete session",
  "sidebar.sessionActions": "Actions for session “{name}”",
  "sidebar.newTerminalIn": "New terminal in session “{name}”",

  "settings.title": "Settings",
  "settings.language": "Interface language",
  "settings.languageRussian": "Русский",
  "settings.languageEnglish": "English",
  "settings.theme": "Interface theme",
  "settings.accent": "Accent color",
  "settings.customColor": "Custom color",
  "settings.selectTheme": "Select the “{name}” theme",
  "settings.selectAccent": "Select the “{name}” color",
  "settings.shell": "Shell",
  "settings.shellDefault": "System default",
  "settings.shellNote": "Changing it restarts all running terminals",
  "settings.selectShell": "Select the “{name}” shell",
  "settings.confirmShellChange":
    "Switch to “{name}” and restart {terminals}? Current processes will be stopped.",
  "settings.shellRestart": "Restart",
  "settings.shellApplying": "Restarting…",
  "settings.shellChanged": "Shell changed",
  "settings.shellRestarted": "Shell changed: restarted {terminals}",
  "settings.shellRestartFailed":
    "Could not restart {failed} of {total} terminals — they are still running in the previous shell",
  "settings.terminalFontSize": "Terminal font size",
  "settings.terminalFontSizeValue": "{size} px",
  "settings.tabAppearance": "Appearance",
  "settings.tabTerminal": "Terminal",
  "settings.tabNotifications": "Notifications",
  "settings.notificationSound": "Notification sound",
  "settings.notificationSoundNote":
    "Plays when a new notification arrives. Click to preview.",
  "settings.notificationSoundSuppressed":
    "Audio appeared to hang last time a sound played, so sound is temporarily disabled. Select “Off”, then pick a sound to try again.",
  "settings.previewSound": "Preview “{name}”",
  "settings.soundOff": "Off",
  "settings.soundChime": "Chime",
  "settings.soundClick": "Click",
  "settings.soundPop": "Pop",
  "settings.soundReveal": "Reveal",
  "settings.soundFlute": "Flute",

  "theme.midnight.name": "Midnight",
  "theme.midnight.description": "Original dark theme",
  "theme.graphite.name": "Graphite",
  "theme.graphite.description": "Calm monochrome",
  "theme.ocean.name": "Ocean",
  "theme.ocean.description": "Deep blue-black",
  "theme.forest.name": "Forest",
  "theme.forest.description": "Dark evergreen",
  "theme.aubergine.name": "Amethyst",
  "theme.aubergine.description": "Muted violet",
  "theme.porcelain.name": "Porcelain",
  "theme.porcelain.description": "Light slate",

  "accent.pink": "Pink",
  "accent.rose": "Rose",
  "accent.red": "Red",
  "accent.orange": "Orange",
  "accent.amber": "Amber",
  "accent.yellow": "Yellow",
  "accent.lime": "Lime",
  "accent.green": "Green",
  "accent.emerald": "Emerald",
  "accent.teal": "Teal",
  "accent.sky": "Sky blue",
  "accent.blue": "Blue",
  "accent.indigo": "Indigo",
  "accent.violet": "Violet",
  "accent.purple": "Purple",
  "accent.fuchsia": "Fuchsia",
  "accent.white": "White",
  "accent.gray": "Gray",

  "welcome.title": "Build your fleet.",
  "welcome.chooseProject":
    "Choose a project folder — your workspace terminals will run there.",
  "welcome.terminalsTogether": "Agent terminals, together in one window.",
  "welcome.openProject": "Open project folder",
  "welcome.newTerminal": "New terminal",
  "welcome.openProjectShortcut": "also opens the folder picker",
  "welcome.newTerminalShortcut": "new terminal",
  "welcome.panelNumbersShortcut": "panel numbers",
  "welcome.zoomShortcut": "zoom",

  "group.splitRight": "Split right",
  "group.maximizeRestore": "Maximize or restore ({shortcut})",
  "group.close": "Close group ({shortcut})",
  "layout.noSplitSpace": "Not enough room for another terminal",
  "layout.terminalLimit": "Can’t open more than {max} terminals",
  "layout.restore": "Restore layout",
  "layout.terminalExpanded": "Terminal expanded",
  "layout.restoreShortcut": "restore",

  "workspace.checking": "Checking project folders…",
  "workspace.folderChecking": "The project folder is still being checked",
  "workspace.folderPickerDesktopOnly":
    "Folder selection is available in the ModelCrew app",
  "workspace.syncFailed": "Could not synchronize folders: {error}",
  "workspace.persistReadFailed":
    "Could not read your saved projects. Saving is paused so they are not overwritten — restart the app.",
  "workspace.prepareFailed": "Could not prepare folders: {error}",
  "workspace.rootOwnedBy":
    "The folder already belongs to workspace {workspaceId}",
  "workspace.alreadyOpen": "The folder is already open in “{name}”",
  "workspace.alreadyRegistered":
    "The folder is already open in another workspace",
  "workspace.invalidBackendId":
    "The app received an invalid workspace identifier",

  "confirm.closeTerminal": "Close terminal?",
  "confirm.deleteWorkspace":
    "Delete workspace “{name}” and close {terminals}?",
  "confirm.deleteSession":
    "Delete session “{name}” and close {terminals}?",

  "session.defaultName": "Session {index}",
  "session.cannotDeleteLast": "A project’s only session can’t be deleted",

  "terminal.defaultTitle": "terminal",
  "terminal.statusRunning": "Terminal is running",
  "terminal.statusExited": "Terminal has exited",
  "terminal.rename": "Rename terminal",
  "terminal.shellStartFailed": "Could not start shell: {error}",
  "terminal.workspaceMissing": "the panel is not linked to a workspace",
  "terminal.webPreview": "web preview: the shell only runs in the app",
  "terminal.processExited": "process exited",
  "terminal.restored": "restored",
  "terminal.exitCode": "code {code}",

  "error.mainWindowOnly": "This command is only available in the main window",
  "error.invalidLocale": "The selected interface language is not supported",
  "error.appMenuUpdateFailed": "Could not update the application menu",
  "error.workspaceInvalidId": "Invalid workspace identifier",
  "error.workspaceRootConflict":
    "The workspace is already linked to another folder",
  "error.workspaceRootNotRegistered":
    "The workspace folder is not registered",
  "error.workspaceRootIdentityChanged":
    "The workspace folder was replaced — select it again",
  "error.workspaceRootMissing": "The project folder is unavailable",
  "error.workspaceRootPermissionDenied":
    "Permission to the project folder was denied",
  "error.workspaceRootNotDirectory": "The selected path is not a folder",
  "error.workspaceRootUnavailable": "Could not inspect the project folder",
  "error.workspacePathUnsupported":
    "The project path contains unsupported characters",
  "error.workspacePickerPathInvalid": "Could not read the selected path",
  "error.terminalNotFound": "The terminal was not found",
  "error.terminalPtyOpenFailed": "Could not open the PTY",
  "error.terminalShellNotFound": "Shell not found: {shell}",
  "error.terminalCwdUnavailable":
    "The terminal working directory is unavailable",
  "error.terminalSpawnFailed": "Could not start shell {shell}",
  "error.terminalOutputStreamFailed": "Could not open the output stream",
  "error.terminalInputStreamFailed": "Could not open the input stream",
  "error.terminalWriteFailed": "Could not write to the terminal",
  "error.terminalResizeFailed": "Could not resize the terminal",
  "error.terminalKillFailed":
    "Could not stop all terminals before updating",
  "error.unknown": "An unknown error occurred",
};
