# Changelog

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
