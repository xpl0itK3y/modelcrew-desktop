# Changelog

## 0.0.16

### Русский

Файлы проекта видны деревом, открываются в своей колонке с подсветкой и номерами строк, а колонки тянутся за разделители. Хуки агентов заработали на Windows.

- Дерево проекта слева от терминалов: папка читается ровно тогда, когда её раскрыли
- Файл открывается мимо git — папка без репозитория остаётся папкой с файлами
- Открытый файл живёт в своей колонке, а не вкладкой среди терминалов
- Вкладки открытых файлов: переключение не теряет несохранённую правку
- Подсветка кода под текстом, номера строк, сохранение по ⌘S
- Большой файл рисуется окном по видимым строкам — прокрутка не спотыкается
- Поиск по имени вглубь проекта, мимо node_modules, target и прочих тяжёлых папок
- Создание, переименование, удаление и показ в системном проводнике
- Имя нового файла вводится строкой дерева, на том самом месте, где он появится
- Ходьба по дереву стрелками, удаление с клавиатуры, контекстное меню по правой кнопке
- Дерево следит за диском: созданное агентом появляется само и отмечается вспышкой
- Удалили или переименовали файл — вкладка закрывается или едет следом за именем
- Редактор предупреждает, если файл изменился на диске, и спрашивает перед записью поверх
- Файл не в UTF-8 больше не уничтожается сохранением
- Ширину дерева, редактора и боковой панели задают разделители, двойной щелчок возвращает исходную
- Хуки агентов работают на Windows: приложение отвечает на их запросы само, без оболочки
- Возня внутри target, node_modules и .git больше не занимает окно, пока работает агент
- Смена размера панелей больше не выглядит для приложения как ответ агента

### English

Project files show as a tree and open in a column of their own with highlighting and line numbers; every column drags to size. Agent hooks now work on Windows.

- A project tree beside the terminals: a folder is read exactly when it is opened
- Files open without asking git — a folder with no repository is still a folder with files
- The open file lives in its own column, not as a tab among the terminals
- Tabs for open files: switching between them keeps unsaved work
- Syntax highlighting under the text, line numbers, saving with ⌘S
- A large file is painted by the window of visible lines, so scrolling does not stutter
- Search by name through the project, skipping node_modules, target and other heavy folders
- Create, rename, delete and reveal in the system file manager
- A new name is typed as a row of the tree, in the place the file will appear
- Arrow-key navigation, deleting from the keyboard, a context menu on right click
- The tree follows the disk: what an agent creates appears on its own and flashes
- Delete or rename a file and its tab closes or follows the new name
- The editor says when the file changed on disk and asks before writing over it
- A file that is not UTF-8 is no longer destroyed by saving
- Dividers size the tree, the editor and the sidebar; a double click restores the original width
- Agent hooks work on Windows: the application answers their requests itself, with no shell
- Churn inside target, node_modules and .git no longer keeps the window busy while an agent works
- Resizing the panels no longer looks to the application like an agent answering

## 0.0.15

### Русский

Перед правкой агент заявляет файл, занятый оставляет соседу, а запись поверх устаревшего чтения отклоняется. В шапке панели видно, чем он занят.

- Перед правкой агент заявляет файл, а занятый оставляет соседу и берётся за другой
- Заявки поддерживают claude, codex, copilot, cursor, grok, kimi, opencode, kilocode и antigravity
- Каждый агент получает отказ на своём языке: кодом выхода, решением в JSON или ошибкой плагина
- В отказе сказано и то, что переписывать занятый файл через оболочку тоже не нужно
- Запись поверх устаревшего чтения отклоняется — агент перечитывает файл заново
- Из патча codex вычитываются все файлы сразу, а не только первый
- Пути через символические ссылки считаются одним и тем же файлом
- Устаревшая запись хука обновляется при подключении, а не остаётся лежать как есть
- Хуки codex ставятся автоматически; чтобы он их запускал, нужно разовое `/hooks` в его сессии
- В шапке панели видно, какой файл правит агент, полный список — в подсказке
- Правка отмечается карандашом, ожидание — песочными часами, а подпись мягко пульсирует
- Длинное имя файла в подписи обрывается многоточием
- На вкладке видно, какая панель упёрлась в занятый файл
- После каждого хода агента дерево проекта снимается в служебную ветку
- Вкладка снимков убрана из Git-панели, а пилюля вкладок считает ширину по их числу

### English

An agent claims a file before editing it, leaves a busy one to its neighbour, and a write built on a stale read is refused. Panel headers show what it edits.

- An agent claims a file before editing and leaves a busy one to its neighbour
- Claims work in claude, codex, copilot, cursor, grok, kimi, opencode, kilocode and antigravity
- Each agent is refused in its own dialect: exit code, JSON decision, or plugin error
- The refusal also says not to rewrite the busy file through the shell
- A write built on a stale read is refused, so the agent re-reads the file
- Every file in a codex patch is claimed, not just the first one
- Paths that differ only by a symlink count as the same file
- An outdated hook entry is brought up to date on connect instead of being left alone
- Codex hooks are installed automatically; running them needs a one-time `/hooks` in its session
- Panel headers name the file being edited, with the full list in the tooltip
- An edit is marked with a pencil, waiting with an hourglass, and the label pulses gently
- A long file name in the label ends in an ellipsis
- Tabs show which panel is stuck on a busy file
- The project tree is snapshotted after every agent turn
- The snapshots tab is gone from the git panel, and the tab pill sizes itself by tab count

## 0.0.14

### Русский

Агентские сессии точнее привязываются к терминалам и сохраняются до закрытия панели, а ожидающие агенты и готовые обновления стали заметнее.

- Сессия агента повторно привязывается после первого реального сообщения
- Последний разговор панели сохраняется даже после выхода агента в оболочку
- Сохранённая сессия удаляется вместе с панелью и не передаётся другому агенту
- Колокольчик и значок приложения показывают число ожидающих агентов
- Уведомления приходят от всех панелей, кроме той, где пользователь сейчас работает
- Движения и клики мыши в терминале не считаются текстовым вводом
- Метка ожидания снимается только после реального ввода в нужной панели
- Готовое обновление всегда показывает системный баннер
- Активная панель получила более заметный акцент, а индикатор ожидания теперь мигает
- Панели получили прямые углы для более цельной терминальной сетки
- Панель Kimi называется по команде запуска, а не по внутреннему имени процесса

### English

Agent sessions bind to terminals more reliably and persist until panels close, while waiting agents and ready updates are easier to notice.

- Agent sessions retry binding after the first real message
- A panel remembers its last conversation even after the agent exits to the shell
- Remembered sessions are removed with their panel and never handed to another agent
- The bell and app icon show how many agent panels are waiting
- Alerts arrive from every panel except the one currently in use
- Terminal mouse reports no longer count as typed input
- A waiting marker clears only after real input reaches that panel
- A ready update always shows a system banner
- The active panel has a stronger accent, while waiting indicators now blink
- Panels use square corners for a more cohesive terminal grid
- Kimi panels use the launch command instead of the process's internal name

## 0.0.13

### Русский

Настройки и Git-панель теперь загружаются по требованию, а Git и уведомления агентов разделены на независимо тестируемые модули.

- Настройки и Git-панель вынесены из стартового бандла и загружаются только при первом открытии
- Клиент Git разделён на модули веток, синхронизации, журнала и истории
- Интерфейс истории разделён на граф коммитов, детали, действия и сравнение
- Разбор unified diff, относительное время и аватары авторов получили отдельные тесты
- Правила уведомлений агентов вынесены в чистый policy-модуль
- Сканирование терминалов, состояние ожидающих панелей и доставка уведомлений разделены и протестированы
- Хвост терминала собирается только для системного баннера, который действительно будет показан
- Устранены оставшиеся предупреждения Clippy в Rust-коде

### English

Settings and the Git panel now load on demand, while Git and agent alerts are split into independently tested modules.

- Settings and the Git panel are removed from the startup bundle and load only when first opened
- The Git client is split into branch, synchronization, log, and history modules
- The history interface is split into commit graph, details, actions, and comparison components
- Unified diff parsing, relative timestamps, and author avatars have dedicated tests
- Agent alert decisions now live in a pure policy module
- Terminal scanning, waiting-panel state, and alert delivery are isolated and tested
- Terminal output is collected only for a system banner that will actually be shown
- Removed the remaining Clippy warnings from the Rust code

## 0.0.12

### Русский

Расширены уведомления агентов: больше CLI подключены через hooks, а ожидающие ответа панели видны в колокольчике и открываются одним нажатием.

- Claude Code, OpenCode, GitHub Copilot CLI, Aider, Grok, Kilo Code, Cursor Agent и Antigravity подключены к точным hook-уведомлениям
- Колокольчик показывает панели, ожидающие ответа, вместе с агентом, проектом и сессией
- Нажатие на ожидающую панель открывает нужный проект, сессию и терминал
- Метка ожидания сохраняется, пока пользователь действительно не ответит в панели
- Общий переключатель уведомлений агентов отключает весь поток оповещений
- В настройках появились разделы инструментов агентов, MCP, плагинов и горячих клавиш
- Список горячих клавиш адаптируется к клавиатуре пользователя
- Кнопки терминальной панели остаются видимыми, а разворот предлагается только когда он полезен
- Удалены устаревшие интеграции Qwen Code и Amp, а уведомления называют фактически запущенного агента

### English

Agent alerts now cover more CLIs, while panels waiting for input appear in the notification center and open with one click.

- Claude Code, OpenCode, GitHub Copilot CLI, Aider, Grok, Kilo Code, Cursor Agent, and Antigravity emit precise hook alerts
- The notification center lists panels waiting for input with their agent, project, and session
- Clicking a waiting panel opens the correct project, session, and terminal
- Waiting markers remain visible until the user actually responds in the panel
- The master agent-alert switch silences the entire notification flow
- Settings now include agent tools, MCP, plugins, and keyboard shortcut sections
- The shortcut reference adapts to the user's keyboard
- Terminal panel controls stay visible, while maximize appears only when useful
- Removed obsolete Qwen Code and Amp integrations, and alerts identify the agent that actually ran

## 0.0.11

### Русский

Добавлены режимы размещения терминалов, событийные уведомления агентов, поддержка Copilot CLI и установка Git Bash на Windows.

- Новые терминалы можно размещать по строкам, змейкой или от центра
- Уведомления агентов получают точный текст через backend events и объединяют частые события
- Уведомления учитывают скрытые за развёрнутой панелью терминалы и восстановленные сессии
- Добавлены обнаружение и восстановление сессий GitHub Copilot CLI
- Git Bash на Windows можно установить из настроек через WinGet
- Громкость уведомлений сохраняется между запусками
- Разворот терминала и статусная плашка получили плавные анимации, а перенос файлов стал аккуратнее
- Скрытые сессии больше не запускаются заранее при старте приложения
- Исправлено сопоставление иконки ModelCrew в Arch Linux и KDE Plasma

### English

Added terminal placement modes, event-based agent alerts, Copilot CLI support, and Git Bash setup on Windows.

- Place new terminals by rows, snake order, or from the center
- Agent alerts receive precise text through backend events and collapse frequent events
- Alerts cover terminals hidden behind a maximized panel and restored sessions
- GitHub Copilot CLI sessions can be discovered and restored
- Install Git Bash on Windows from settings through WinGet
- Notification volume persists across application restarts
- Terminal zoom and its status banner animate smoothly, while file drops look cleaner
- Hidden sessions no longer start eagerly when the application launches
- Fixed ModelCrew icon matching on Arch Linux and KDE Plasma

## 0.0.10

### Русский

Перетаскивайте файлы и вставляйте изображения в терминал, получайте точные уведомления агентов и используйте GitHub-профиль для новых коммитов.

- Файлы и папки можно перетащить прямо в терминал: путь экранируется для оболочки и вставляется в командную строку
- Изображение из буфера сохраняется во временный файл PNG, JPEG, GIF или WebP, после чего его путь вставляется в тот же терминал
- Уведомления отдельно распознают завершение работы, вопрос, запрос разрешения, ожидание ответа и ошибку агента
- В настройках можно выбрать краткий или подробный текст уведомлений агентов
- Системное уведомление показывает проект и, в подробном режиме, короткое сообщение агента
- Новые коммиты из Git-панели используют имя и защищённый noreply-адрес вошедшего GitHub-профиля
- Добавлена поддержка Kimi Code, устаревшая интеграция Gemini CLI удалена
- Изменение ориентации терминальной сетки применяется сразу к текущей раскладке

### English

Drop files or paste images into terminals, receive precise agent alerts, and use your GitHub identity for new commits.

- Drop files and folders directly into a terminal to insert a shell-escaped path into its command line
- Paste a clipboard image to store a temporary PNG, JPEG, GIF, or WebP file and insert its path into the same terminal
- Alerts distinguish completed work, questions, permission requests, waiting for input, and agent errors
- Choose brief or detailed agent notification text in Settings
- System notifications show the project and, in detailed mode, a short message supplied by the agent
- New commits from the Git panel use the signed-in GitHub profile name and protected noreply address
- Added Kimi Code support and removed the obsolete Gemini CLI integration
- Changing the terminal grid orientation applies immediately to the current layout

## 0.0.9

### Русский

Настройки получили разделы, поиск и GitHub-аккаунт, появились новые темы и badges, а проверки безопасности и релиза закрывают больше рискованных сценариев.

- Настройки разделены на вкладки: внешний вид, терминал, агенты, уведомления и GitHub-аккаунт
- Поиск настроек работает по зарегистрированным строкам интерфейса и сбрасывается при смене языка
- GitHub-вход синхронизируется между титлбаром, настройками и аватарами авторов коммитов
- Добавлены темы Obsidian, Sepia и Parchment
- Badge count теперь виден в Windows taskbar overlay и на Linux docks, а Linux-уведомления получают иконку приложения
- Проверки закрывают рискованные входы: updater manifests, локальные пути пакетов, подписи, CSP, capability allowlist, symlink/path traversal и forged GitHub device flow
- Релизная оснастка получила дополнительные тесты package validation и nightly Arch-сборка выровнена со стабильным релизом

### English

Settings now have tabs, search, and a GitHub account area, new themes and badges improve the desktop polish, and security/release checks cover more risky inputs.

- Settings are split into Appearance, Terminal, Agents, Notifications, and GitHub account tabs
- Settings search indexes the actual registered UI rows and resets when the interface language changes
- GitHub sign-in state is shared between the titlebar, settings, and commit author avatars
- Added Obsidian, Sepia, and Parchment themes
- Badge counts now show in the Windows taskbar overlay and Linux docks, and Linux notifications use the app icon
- Tests cover risky inputs in updater manifests, local package paths, signatures, CSP, capability allowlists, symlink/path traversal, and forged GitHub device flow
- Release package validation has more automated coverage, and nightly Arch packaging is aligned with the stable release path

## 0.0.8

### Русский

Файлы коммита открываются диффом «было рядом со стало», окно работает под политикой безопасности контента, звук уведомлений вернулся в Linux, а скачанное обновление остаётся с бейджем.

- Откройте файлы коммита и читайте изменение в две колонки: слева было, справа стало, строка напротив строки
- Окно приложения теперь работает под политикой безопасности контента: скрипты только со своего источника
- Звуки уведомлений снова играют в Linux — плеер получает их блобами, понятными загрузчику WebKit
- Скачанное обновление остаётся с бейджем на колокольчике и иконке, пока вы его не установите
- В Windows терминал находит Git Bash, даже если Git установлен вне Program Files
- Одноколоночный вид diff остался и переключается, а сравнение коммитов использует тот же рендерер
- Релизный валидатор не пропустит сборку без политики безопасности или с разрешённым inline-скриптом
- AppImage оставляет графику системе и несёт только те аудио-плагины, что действительно работают

### English

A commit's files open into an aligned before-and-after diff, the window runs under a content security policy, Linux notification sounds work again, and downloaded updates stay badged.

- Open a commit's files and read the change as two aligned columns, old on the left and new on the right
- The app window now runs under a content security policy that limits scripts to its own origin
- Notification sounds play on Linux again, delivered to the player as blobs the WebKit loader understands
- A downloaded update stays badged on the bell and app icon until you install it
- On Windows the terminal finds Git Bash even when Git is installed outside Program Files
- The single-column diff view stays and toggles, and commit compare now shares the same renderer
- The release validator refuses a build with no security policy or one that allows inline scripts
- The AppImage leaves graphics to the host and bundles only the audio plugins that actually work

## 0.0.7

### Русский

Обновление больше не теряется до установки, второй запуск фокусирует уже открытое окно, а Linux-пакеты честно объявляют всё, что им нужно.

- Скачанное обновление остаётся на виду до установки: видно, где лежит пакет и что с ним делать
- Повторный запуск фокусирует уже работающее окно вместо второй копии приложения
- Меню веток и коммитов больше не вылезают за границы Git-панели
- Linux-пакеты объявляют все нужные программы, а про отсутствующий git приложение говорит прямо
- Обходной путь DMABUF в Linux теперь можно выключить обратно в настройках
- Сборка релиза прерывается, если в неё попал адрес дев-сервера
- Git-сценарии целиком проверяются на настоящем сервере, включая слияние pull request в графе
- Rust-тесты и проверка терминала гоняются ещё и на Windows и macOS, а пакет Arch aarch64 собирается нативно

### English

Downloaded updates stay visible until installed, launching again focuses the running window, and the Linux packages declare everything they need.

- A downloaded update stays visible until installed, showing where the package is and how to install it
- Launching the app again focuses the running window instead of starting a second copy
- Branch and commit menus no longer escape the edges of the Git panel
- Linux packages declare every program they need, and a missing git is reported plainly
- The Linux DMABUF workaround can now be switched back off in settings
- A release build now refuses to ship if it would load the dev server
- The whole Git workflow is checked against a real server, including the pull-request merge shape in the graph
- Rust tests and the terminal check also run on Windows and macOS, and the Arch aarch64 package is built natively

## 0.0.6

### Русский

Git-панель выросла до полной истории с графом веток, действиями над коммитами, правкой файлов прямо в diff и входом через GitHub.

- Изучайте историю графом веток: HEAD, метки веток, поиск по сообщению, автору и файлу
- Управляйте коммитами: amend, squash, drop, теги, патчи и сравнение любых двух коммитов
- Сливайте, перебазируйте и публикуйте ветки, а из отделённого HEAD возвращайтесь одним действием
- Правьте изменённые файлы прямо в diff, не покидая панель
- Входите через GitHub и видьте настоящие аватары авторов рядом с коммитами
- В Linux исправлено чёрное окно, вернулись звуки уведомлений в AppImage, а пакет для Arch x86_64 собирается нативно

### English

The Git panel grew into a full history with a branch graph, commit actions, inline file editing in the diff, and GitHub sign-in.

- Explore history as a branch graph with HEAD, branch chips, and search by message, author, or file
- Manage commits: amend, squash, drop, tags, patches, and a diff between any two commits
- Merge, rebase, and publish branches, and return from a detached HEAD in one action
- Edit changed files inline in the diff without leaving the panel
- Sign in with GitHub to see real author avatars next to commits
- On Linux the black window is fixed, AppImage notification sounds work again, and the Arch x86_64 package is built natively

## 0.0.5

### Русский

Добавлены встроенная Git-панель, уведомления фоновых агентов, сетка терминалов и сохранение обновлений между перезапусками.

- Просматривайте изменения, diff, ветки и историю Git прямо в ModelCrew
- Создавайте коммиты, переключайте ветки и откатывайте отдельные файлы
- Получайте звук, системное уведомление и badge, когда фоновый агент завершил работу
- Выравнивайте терминалы в ровную сетку с выбранной ориентацией
- Скачанные обновления остаются готовыми к установке после перезапуска

### English

Added an integrated Git panel, background-agent alerts, even terminal grids, and downloaded updates that persist across restarts.

- Review changes, diffs, branches, and Git history directly in ModelCrew
- Create commits, switch branches, and revert individual files
- Get sound, system notifications, and app badges when a background agent finishes
- Arrange terminals into an even grid with a configurable orientation
- Downloaded updates remain ready to install after the application restarts

## 0.0.4

### Русский

Терминалы теперь восстанавливают экран и отдельную историю команд, продолжают сессии AI-агентов и показывают системные уведомления.

- Текст терминалов восстанавливается после полного перезапуска приложения
- Каждая панель хранит собственную историю команд между запусками
- Каталог возобновления расширен до 11 CLI; для шести агентов сохраняется точная привязка к диалогу
- Можно автоматически восстановить все сессии активного проекта для мгновенного переключения
- Добавлены системные уведомления, удаление анонсов и новые анимации центра уведомлений

### English

Terminal screens and per-panel command history now survive restarts, AI-agent chats resume automatically, and notifications can appear at the OS level.

- Restore terminal text after fully quitting and reopening ModelCrew
- Keep command history isolated per panel across launches
- Resume 11 supported agent CLIs; six agents retain an exact panel-to-chat binding
- Optionally restore every session in the active project for instant switching
- Use OS notifications and dismiss announcements with refreshed arrival animations

## 0.0.3

### Русский

Обновлены иконки и анимации, улучшен центр уведомлений, а звуки, трей и обновления стали надёжнее в Linux.

- Плавное открытие и закрытие настроек, диалогов, уведомлений и подсказок
- Центр уведомлений можно растягивать; его высота сохраняется между запусками
- На колокольчике отображается количество непрочитанных уведомлений
- Новые иконки приложения адаптированы для macOS, Windows и Linux
- В Linux исправлена работа звуков, системного трея и обновлений через пакеты

### English

Refreshed icons and animations, improved the notification center, and made sounds, tray integration, and updates more reliable on Linux.

- Settings, dialogs, notifications, and toasts now open and close with smooth animations
- The notification center is resizable and remembers its height across launches
- The bell now displays the number of unread notifications
- Refreshed app icons are tailored for macOS, Windows, and Linux
- Fixed notification sounds, system tray support, and package updates on Linux

## 0.0.2

### Русский

Добавлены настраиваемые звуки для уведомлений об обновлениях, вкладки настроек и мгновенное отображение имени оболочки нового терминала.

- Выбор из пяти звуков уведомления или полное отключение звука
- Предпрослушивание звука и сохранение настройки между запусками
- Звук воспроизводится при появлении нового уведомления об обновлении
- Настройки разделены на вкладки внешнего вида, терминала и уведомлений
- Название оболочки нового терминала отображается сразу без временной надписи

### English

Added configurable update-notification sounds, organized settings tabs, and immediate shell names for newly opened terminals.

- Choose one of five notification sounds or turn sounds off
- Preview the selected sound and keep the setting across restarts
- A sound plays when a new update notification appears
- Settings are organized into Appearance, Terminal, and Notifications tabs
- New terminals show the shell name immediately without a temporary label

## 0.0.1

### Русский

Первый публичный релиз ModelCrew.

- Проекты и рабочие папки
- Несколько сессий
- До 12 терминалов в сессии
- Темы и локализация

### English

First public ModelCrew release.

- Projects and working folders
- Multiple sessions
- Up to 12 terminals per session
- Themes and localization
