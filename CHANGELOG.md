# Changelog

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
