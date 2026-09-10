# AGP-MVP — пакет для Windows x64

Портативный комплект governance-шлюза. **Node.js устанавливать не нужно** — в комплекте `node.exe` (LTS v22, win-x64), шлюз работает сразу после распаковки.

## Запуск

1. Распакуйте папку `agp-mvp-win64` целиком в любое место (лучше путь без пробелов и кириллицы, например `C:\agp\`).
2. Запустите `start.bat` — шлюз поднимется на `http://127.0.0.1:8790` (только localhost).
3. При первом старте в консоли появится строка `[AGP] admin token: <hex>` — это токен администратора (kill switch, смена политик). Без заданной переменной `AGP_ADMIN_TOKEN` токен генерируется заново при каждом старте. Чтобы токен был постоянным, запускайте так:

   ```bat
   set AGP_ADMIN_TOKEN=my-secret
   start.bat
   ```

Fail-secure: при каждом старте сервер проверяет хеш-цепочку аудита (`data\audit.jsonl`). Нарушена — старт запрещён (`[AGP] AUDIT CHAIN BROKEN at seq N`, exit 1).

## Проверка (при запущенном шлюзе, вторая консоль)

```bat
powershell -ExecutionPolicy Bypass -File test-agp.ps1
```

Ожидаемый итог: `SMOKE: PASS (5 markers)` — ALLOW на `/check`, DENY на `Remove-Item -Recurse`, REVIEW на write вне workspace и на `git push`, целостность цепи аудита.

## Состав пакета

| Файл/папка | Что это |
|---|---|
| `node.exe` | Портативный Node.js LTS (win-x64) — из него работает шлюз |
| `dist\` | Скомпилированный сервер (запускается `start.bat`) |
| `src\` | Исходники TypeScript (для просмотра/доработки) |
| `node_modules\` | Только runtime-зависимости (express, zod, uuidv7 — чистый JS) |
| `data\policies.json` | Политики; `audit.jsonl` и `killswitch` появятся рядом при работе |
| `test-agp.ps1` | Смоук-тест (5 маркеров) |
| `README-AGP.md` | Полная документация API |

## Интеграция с Super_HandAI_z

Договор `mode: agp-check`, схема запроса, таблица маппинга и pwsh-пример — в `README-AGP.md`, раздел **«Интеграция с Super_HandAI_z»**. Коротко: клиент перед каждым `RUN` / `RUN_BG` / `WRITE` вызывает `POST /agent/check-operation` (`ALLOW` → исполнять, `REVIEW` → человек, `DENY` → пропуск шага), после исполнения — `POST /agent/notify` (RESULT в цепь аудита). Шлюз недоступен — шаг не исполняется (fail-closed).

## Важно

- Порт `8790`: при ошибке `EADDRINUSE` шлюз уже запущен в другой консоли.
- Чистый прогон: остановите шлюз и удалите `data\audit.jsonl` и `data\killswitch`.
- Пересборка из исходников на Windows требует установленного Node.js + `npm install` (включая typescript) — портативный `node.exe` в комплекте предназначен только для запуска готового `dist\`.
- Шлюз слушает только `127.0.0.1` — наружу не торчит; для доступа с других машин нужен reverse-proxy (вне MVP).
