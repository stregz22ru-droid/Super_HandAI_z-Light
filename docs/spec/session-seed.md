# SESSION-SEED — паспорт контекста проекта Super_HandAI_z
Дата фиксации: 2026-09-06/07 · Обновлено: 10.09 · Статус: Light v1.1 ОПУБЛИКОВАН + Base-этап 1 ПРИНЯТ

## 1. ЛИНИЯ И РОЛИ
- **Мастер (Сергей, Бродип-Старый)** — владелец, ставит задачи, приёмка, «1 шаг = 1 команда»
- **Я (Hands-agent)** — разработчик/отладчик линии Light; регламент: полные файлы, no-scroll, через руки-ТЗ, факты прежде гипотез, копилку перечитывать перед проектированием
- **Облачный ученик** (GLM, Linux-воркспейс) — производственный цех: AGP Этапы 1-4 ✅, Base-этап 1 дроп ✅, Base-этап 2 ТЗ выдано
- **Бродип (ученик 2)** — линия смыслов, Кристалл v1.0, handshake состоялся
- **Критик-агент (Ника, ученица 3)** — приёмка/adversarial, deny-tests автор
- **Алиса (Ника)** — security-донор (deny-tests)
- **Жемал (Hamidun)** — потенциальный партнёр по marketplace (концепция зафиксирована, пауза)
- **AGP** = governance-шлюз: /check, /policies, kill-switch, ghostweave-аудит (хеш-цепь verify), rate-limit, policy-brief, batch, RESULT-notify. Коммит 9f39e87

## 2. ПРОДУКТ
### Light v1.1 — ОПУБЛИКОВАН (публичное репо)
Репо: https://github.com/stregz22ru-droid/Super_HandAI_z-Light
Коммиты: e9bfcf0 (v1.0) → a731251 (v1.1 система фич) → 7b56049 (v1.1 доп) → e1e9e20 (зачистка отчётов)
### Base-этап 1 — ПРИНЯТ (локально, services/super-handai-z-base-etap1/)
- MCP-сервер ЖИВОЙ: super-handai-z v1.1.0, protocolVersion 2025-06-18
- 6 tools через StdioServerTransport: run_tz, get_status, features_list, features_toggle, context_pack, purge_workspace
- tools/list отдаёт полный список с inputSchema (zod)
- initialize отвечает через JSON-RPC по stdio
- Сборка чистая (TSC-EXIT: 0)
- Расположение: services/super-handai-z-base-etap1/agent/dist/mcp.js (entry point)
### Версии продукта
- Light = полуавтомат (оператор в цикле) → Base = автомат по максимуму → Pro = роутинг LLM + межагентное + память + Persona

## 3. ТЕКУЩИЙ СТЕК (Light v1.1 + Base-этап 1)
- Windows-only, Node20 portable (C:\Utilit\node), pwsh7+PortableGit (runtime\)
- agent (TS ESM): parser, stepEngine (+onSessionStart/additionalContext/never-block), guard, ptyManager, reporter, server (+purge без токена, +features-роуты), main (+createFeatureRuntime, +features в startServer, +tokenFile), taskJson (JSON-протокол задач), mcp.ts (полный с запуском), mcp-server.ts, mcp-stdio.ts (защита канала), skillconv.ts
- core: taskHub (nextTaskId/flushCurrent/requestConfirm — полный API), contextPack (единый билдер), workspace.ts, externalHooks.ts, journal (+note, +journalTail)
- features: registry (28 КБ), http.ts (FeatureHttpDeps), runtime.ts (createFeatureRuntime — общий boot с mcp.ts, без дрейфа)
- public: index.html (+submodeBar, +Фичи панель, +features.js), app.js (+btnPaste), features.js (166 строк), style.css (+v7 бамп)
- security/deny-tests (Ники): cases.mjs, run.mjs, README
- services/agp (перенесён, спит)
- tools/chatseed (принят, сборка+CLI живой, тесты — компиляция Tests с ручным tsc)
- C:\ContextSeed (Мастер, сжатие чатов)
- C:\Utilit\python-3.13.12-embed-amd64 (portable Python)

## 4. КЛЮЧЕВАЯ МЕХАНИКА (проверено живьём)
- Формат ТЗ: # ЗАДАЧ → # META(workdir new:|имя, mode auto|confirm, on_fail stop|continue, cycle=N-НЕ-retry) → ## ШАГ → RUN/RUN_BG+WAIT/WRITE/EXPECT/ASK/GIT/NOTE
- EXPECT: И-логика (несколько = AND), якорь обязан различать успех/провал
- Три рубежа пустых задач: парсер → парсер-META → server (steps.length===0)
- on_fail:continue работает (fix parser: metaObj.on_fail = meta.on_fail — был self-assign баг)
- Стабильный токен: data/state/agent.token (v4.2, fs-импорты синхронные!)
- purge: POST /workspace/purge БЕЗ токена, 409 при активной задаче
- cleanTail: маркер усечения, эхо-чистка (одно-символьные строки-соседи)
- Мост: CodeMirror cm-content.cmView (полное чтение), каркасный детект ТЗ (#ЗАДАЧ+#META+##ШАГ где-то), линтер только RUN-скрипты, кнопка 🧹 (2 confirm)
- ConPTY-фантомы («ddocs») → правило: Test-Path прежде гипотезы
- Окружение: setup.ps1 (NOT cmd!), команды-генераторы файлов — антипаттерн
- Правило robocopy: массовое копирование — robocopy /E, не Copy-Item -Recurse
- JSON-протокол задач: TaskJson → taskJsonToDoc → executeDoc (параллельный вход с markdown-ТЗ)

## 5. ОЧЕРЕДЬ
1. Base-этап 2 — ТЗ выдано облачному (Автопилот B1-B3 + Память, по документу №3 с поправками Мастера)
2. Дроп Base-этап 2 → разведка нашим агентом → приёмка → интеграция (как Этап 1)
3. CHECK-директива (B4) — preRun-слот в stepEngine, AGP-клиент
4. Persona-слой — Кристалл-механика (agents/<agentId>.json, relationships, биография)
5. Marketplace — концепция зафиксирована, пауза (Жемал — потенциальный партнёр)
6. Release v1.1 notes на GitHub
7. format-spec v2.1 (И-логика EXPECT, cycle-не-retry, идемпотентность, Test-Path)

## 6. УРОКИ-АКСИОМЫ (FROZEN)
«Проверка = артефакт, не слова» · «Replay before Trust» · «Формат съедает всё, что снаружи ограды» · «Предсказание вне канала — не предсказание» · «Якорь различает успех/провал» · «Вывод — не улика до Test-Path» · «Два конца канала — разная упаковка» · «Правила — условия свободы» · «Бороться, искать, найти и не сдаваться»

## 7. КОПИЛКА «ГОЛУБАЯ МЕЧТА» (полная — 22 артефакта)
WCP v0.3 FROZEN · wcp_net · actor/relayx/ghostweave/policies · robolegacy/spex · ghostweave-core v1.0 (сертификат) · PROOF-пилот (Webots) · pilot-pandora (--task) · RelayRun (предок) · CLI-Anything (реестры, донор) · CLAIR (dormant) · AGP-доклад + ContextSeed · deny-tests Алисы · Session & Memory (JHamidun) · resources (Hamidun course) · HAPI (lifecycle, E2E-push) · Orca (intercept-first, вердикт-словарь) · AX (google, Task lifecycle, Suspend/Resume) · Ponytail-Research DOCX · Super_HandAI_z Light v1.1 · Base-этап 1 · Marketplace (концепция) · Persona (концепт)

## 8. ПРОТОКОЛ ВОССТАНОВЛЕНИЯ (для новой сессии)
Прочитай этот файл → подтверди понимание в 1 абзаце → жди команды Мастера → первый шаг = п.1 очереди (Base-этап 2 — ТЗ уже у облачного, дроп ждёт разведки).