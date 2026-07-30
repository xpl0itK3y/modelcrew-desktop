# Changelog

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
