# modelcrew-desktop

ModelCrew — a modular agent-based system for development, where each agent role can operate on a separate model, and the user controls quality, cost, security, and the level of autonomy.

Текущая версия — терминальный фундамент: десктоп-менеджер терминалов
(Tauri 2 + React + xterm.js + dockview + portable-pty). Терминалы
раскладываются флот-сеткой, живут в воркспейсах, управляются мышью и
хоткеями, панели сами подписываются именем запущенной программы.

## Запуск

```bash
npm install
npm run tauri dev     # dev-режим
npm run tauri build   # релизная сборка (.app / установщик)
```

Тесты бэкенда (PTY, батчинг, стресс):

```bash
cd src-tauri && cargo test
```

## Релизы и обновления

Первая публичная версия — `0.0.1`. Версия меняется одной командой:

```bash
npm run version:set -- 0.0.2
```

Команда синхронизирует npm и Cargo, создаёт двуязычный шаблон в
`release-notes/` и секцию в `CHANGELOG.md`, но не создаёт Git tag.
Перед тегом проверяются метаданные:

```bash
npm run release-scripts:test
npm run release-notes:validate
npm run changelog:validate
npm run release:validate
```

Каждый push в `main` собирает nightly artifacts, а tag `vX.Y.Z` запускает
stable workflow. Установщики и `latest.json` публикуются в разделе
[Releases](https://github.com/xpl0itK3y/modelcrew-desktop/releases) этого репозитория.
Настройка ключей, форматы пакетов и ручная проверка описаны в
[`packaging/README.md`](packaging/README.md).

## Хоткеи

| Комбинация (⌘ = Ctrl вне macOS) | Действие |
|---|---|
| ⌘T | Новый терминал в сетку |
| ⌘W | Закрыть активный терминал |
| ⌘⇧W | Закрыть группу (с подтверждением) |
| ⌘⌥ + стрелки | Фокус на соседний терминал |
| ⌘⇧ + стрелки | Поменяться местами с соседом; у края — новый сплит |
| ⌘⌥ (держать) | Номера поверх панелей |
| ⌘⌥ + цифра | Фокус на панель № |
| ⌘⌥⇧ + цифра | Своп активной панели с № |
| ⌘↩ | Зум панели / вернуть раскладку |
| ⌘⌥ +/− | Панель больше/меньше на 5% |

Двойной клик по имени панели — переименовать (фиксирует имя).
Двойной клик по воркспейсу в сайдбаре — переименовать его.
Шестерёнка в титлбаре — настройки (цвет подсветки).

## Что дальше (v0.2+)

Оркестрация агентов (swarm), канбан-доска задач, память с графом
связей, встроенный браузер-превью — поверх этого фундамента.
