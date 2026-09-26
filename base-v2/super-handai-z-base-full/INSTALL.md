# Super_HandAI_z — BASE Этап 2 (Автопилот B0–B4 + Память) — INSTALL

Дроп: **файлы + патчи, БЕЗ пуша**. Ядро (parser/guard/ptyManager/reporter) **не тронуто**
(в диффе — 0 строк). Единственная врезка в ядро — deny-вердикт в preRun-слоте
stepEngine (одобрена Мастером, B4); при выключенной фиче `check-directive` она — но-оп.

Фундамент: ядро Light v1.1 + Base-этап 1 (MCP-слой, taskHub) + поправки Мастера П-1..П-4.

---

## 0. Состав поставки

```
INSTALL.md                 — этот файл
REPORT-ETAP2.md            — таблица этап/модуль/шаг/статус + stdout-маркеры + коммиты
patches/
  etap2-full-vs-92a4dfc.patch   — полный дельта-патч от моей линии 92a4dfc (БАЗА ПАТЧА)
  etap2-part2-integration.patch — ч.2 (server + MCP→WS + фичи)
  etap2-part3-tests.patch       — ч.3 (тесты + смоуки + gitignore + версия)
files/                     — НОВЫЕ файлы (копируются 1:1 в репо)
  agent/src/base2/**           — слой этапа (22 модуля)
  agent/features/*.feature.js  — 4 новые фичи витрины
  agent/test/base2-*.test.ts   — 10 unit-файлов vitest
  agent/test/autopilot-loop.sim.test.ts — интеграционная симуляция петли (10 сценариев)
  agent/test/etap2-smoke.mjs   — смоук Этапа 2 (11 маркеров)
  agent/test/mcp-smoke.mjs     — смоук MCP (9 маркеров, WS-транспорт)
patched/                   — ПОЛНЫЕ версии ИЗМЕНЁННЫХ файлов (если патч не ложится)
bundle/agent/dist          — собранный dist моей линии (для автономного смоука; НЕ копировать
                             поверх канонической сборки — пересобрать: npm run build)
bundle/agent/node_modules  — prod-зависимости (ws, zod, @modelcontextprotocol/sdk, @lydell/node-pty)
```

Коммиты моей линии: `c89748d` (ч.1 base2+ядро) → `585ca6d` (ч.2 интеграция) → `b02cb61` (ч.3 тесты). ПУША НЕТ.

---

## 1. Карта «файл → точка входа → критерий живости»

### Новые модули `agent/src/base2/`

| Файл | Точка входа | Критерий живости |
|---|---|---|
| `types.ts` | типы/константы (OriginType, WIRE_ORIGIN_TYPES, BusEvents) | импорт; sanitizeWireOrigin режет wire-origin до human\|mcp |
| `atomic.ts` | writeJsonAtomic / appendJsonl / readJsonSafe | tmp+rename переживает kill; JSONL дописывается |
| `slotBus.ts` | getSlotBus() — шина слотов П-4 | slotBus.on/emit; ошибка подписчика не роняет эмиттер |
| `currentTask.ts` | getCurrentTask() (AsyncLocalStorage) | контекст доступен в beforeRun при параллельных задачах |
| `taskService.ts` | **TaskService.startTz(tzText, origin, {sessionId, conversationId})** — П-1 | taskId немедленно; validateTzText — общий с мостом |
| `modeStore.ts` | getMode/setMode/listModes — B1 (П-2) | config.mode — отдельный ключ; рестарт сохраняет; mode.changed |
| `modeGate.ts` | request(agentId, target, by) | manual→autopilot только при idle; autopilot→manual drain; confirm-панель блокирует |
| `mcp/agentLink.ts` | AgentLink.connect({port, token}) — B0 | ping→pong; RPC reqId-корреляция; modeSet НЕ существует (П-2 read-only) |
| `autopilot/tzContract.ts` | extractContract / tzFingerprint — B2 | блок ````shai-tz (4 бэктика) + `complete: true`/маркер; подстроки не контракт |
| `autopilot/tzQueue.ts` | offer/take — один слот, TTL | occupied/same-pending/expire |
| `autopilot/bridgeIn.ts` | **ingestAnswer({answerText, chatId, agentId})** — B2 | журнал отказа data/logs/bridge-in.jsonl с причиной; manual → не подаёт |
| `autopilot/ledger.ts` | addTurn / fingerprintOf (K4), per-инициатор (K9) | отпечаток = [шаг, класс, exit, норм-сообщение] |
| `autopilot/stopPolicy.ts` | evaluateStopPolicy | complete > 3 подряд > N=5 без SUCCESS |
| `autopilot/redaction.ts` | profileFor / redact — П-3 | токены/абс-пути/внутренние URL; per-agent профиль |
| `autopilot/outflow.ts` | buildTurnReport/buildCustom | квота → обрезка + data/logs/outflow.jsonl |
| `autopilot/escalation.ts` | raise() — K7 | 3 приёмника всегда + помощник только на «3 отпечатка» и только trusted |
| `autopilot/fsm.ts` | AutopilotFsm (LoopPort/DispatchPort) | FSM per-task, петля per-conversation; события через slotBus |
| `autopilot/fsmPersist.ts` | FsmPersist (data/autopilot-state.json) | атомарная запись tmp+rename; читается после рестарта |
| `check/client.ts` | checkOperation() — B4 | POST /agent/check-operation, бюджет 1.5с |
| `check/cache.ts` | CheckCache.keyOf(cmd, workdir, mode) | TTL 60с; invalidateAll на mode.changed |
| `check/directive.ts` | createBeforeRunCheck() → beforeRun | ALLOW/DENY/CONFIRM/MODIFY(=DENY+предложение); guard-финален; fail-closed |
| `memory/store.ts` | MemoryStore — 4 слоя | CONTEXT.md, projects.json, conversations/<chatId>.jsonl, agents/<agentId>.json |
| `runtime.ts` | **initBase2Runtime(deps) / getBase2()** | идемпотентен; вызывается из startServer; SHAI_BASE2_ROOT — изоляция data-слоя |

### Изменённые файлы (патч/patched)

| Файл | Что изменилось | Критерий живости |
|---|---|---|
| `core/stepEngine.ts` | **ЕДИНСТВЕННАЯ врезка**: deny-ветка beforeRun («DENIED(CHECK): …» в notes шага) | фича выключена → поведение базовое (тест: но-оп) |
| `features/registry.ts` | BeforeRunVerdict.deny + featuresBeforeRun возвращает deny | тесты stepEngine зелёные |
| `core/taskHub.ts` | параллельность per-conversation (карта активных), origin/sessionId/conversationId, reportPath | GET /tasks/:id отдаёт origin; /workspace/purge 409 при любой активной |
| `server.ts` | делегация в taskService.startTz; WS-расширения: `ping`, `status.get`, `mode.get/set/list`, `glm.ingest`, `autopilot.state`, reqId-ответы на task.start; ретрансляция mode.changed/autopilot.state.changed | смоуки ET2-1..7 |
| `proto.ts` | аддитивные Client/ServerMsg (task.result, mode.*, ingest.result, autopilot.outbox…) | старые сообщения не изменились |
| `config.ts` | секции mode/autopilot/redaction/check/helpers (опциональные, merge с дефолтами) | старый config.json валиден |
| `mcp.ts`, `mcp-server.ts`, `mcp-stdio.ts` | B0: транспорт задач — WS (agentLink), HTTP остался только для /features* и /workspace/purge | MCP-SMOKE 9/9 |
| `.gitignore` | + data/autopilot-state.json, data/memory/, escalation-*.md | мусор этапа не идёт в пуш |
| `agent/package.json` | версия 1.2.0 | context_pack отражает |

### Новые фичи (витрина)

| Файл | Слот | Живость |
|---|---|---|
| `mode-control.feature.js` | route | GET /features/mode-control → 200 {modes…} |
| `autopilot-core.feature.js` | route | GET /features/autopilot-core → 200 {loops…} |
| `memory-layers.feature.js` | route | GET /features/memory-layers → 200 {projects, conversations, agents} |
| `check-directive.feature.js` | beforeRun | при деструктивном RUN без AGP — DENY fail-closed; журнал data/logs/check-decisions.jsonl |

---

## 2. Интеграция в каноническую сборку

1. **Файлы**: скопировать `files/` поверх корня репо (robocopy /E, НЕ Copy-Item -Recurse — урок Этапа 1).
2. **Изменённые файлы**: применить `patches/etap2-full-vs-92a4dfc.patch` (если ваша база = моя линия 92a4dfc)
   ИЛИ взять полные версии из `patched/`. Если ваш server.ts/config.ts разошлись — переносите
   отмеченные секции `BASE ЭТАП 2` руками (все они помечены комментариями).
3. **config.json** — ничего удалять не нужно; новые секции подхватятся дефолтами:
```json
{
  "mode": { "operator": "manual" },
  "autopilot": { "maxTurnsNoSuccess": 5, "maxParallel": 2, "queueTtlSec": 600,
                 "outQuotaChars": 12000, "helperAgentId": "", "escalationFingerprintsK": 3 },
  "redaction": { "tokens": [], "agents": { "<agentId>": { "tokens": ["…"], "quotaChars": 8000 } } },
  "check": { "url": "http://127.0.0.1:8790/agent/check-operation", "timeoutMs": 1500, "cacheTtlSec": 60 },
  "helpers": { "trustedAgents": [] }
}
```
4. **Фичи**: включить в config.features: `"mode-control": true, "autopilot-core": true, "memory-layers": true`
   (+ `"check-directive": true` — только вместе с работающим AGP).
5. Сборка и запуск: `npm run build` → `node dist/main.js`.

### Конфликт-карта (важно)
- Если в вашей витрине остались СТАРЫЕ фичи `autopilot.feature.js` / `project-memory.feature.js` /
  `agp-check.feature.js` (от Base-дропа v3.4) — **выключите их** (`config.features: false`):
  они дублируют зоны ответственности новых `autopilot-core` / `memory-layers` / `check-directive`.
  Имена новых фич специально не совпадают со старыми.
- `externalHooks`/`skillconv` вашей сборки не затрагиваются: мост подключается через
  WS `glm.ingest` и шину слотов, правок их кода не требуется.

---

## 3. Контракт моста (зафиксирован до работ, B2)

**Вход** (ответ GLM, программно — WS `glm.ingest {answerText, chatId, agentId}`):

    ````shai-tz
    complete: true            ← опциональное КОНТРАКТНОЕ поле завершения (первая строка)
    # ЗАДАЧ: …
    # META
    workdir: new:proj
    mode: auto
    ## ШАГ 1. …
    RUN
    ```bash
    echo done-ok
    ```
    EXPECT stdout contains: done-ok
    ````

- контейнер — **4 бэктика** (внутренние 3-бэктиковые фенсы ТЗ его не закрывают);
- альтернативное поле завершения — маркер `<!--SHAI:AUTOPILOT:COMPLETE-->` вне блока;
- всё вне блока — свободный текст: «задача завершена» там НЕ останавливает петлю;
- дедуп — sha256 нормализованного текста; повтор той же ТЗ отбрасывается.

**Выход** — WS-броадкаст `autopilot.outbox {kind: 'turn-report'|'escalation'|'hint'|'help-request', chatId, text}`
через redaction per-agent + квоту. Чат-коллектор (скрипт-клиент, будущий z.ai-мост) читает канал.

**Смоуки** (агент запущен, из корня репо):
```
node agent/test/mcp-smoke.mjs     → MCP-SMOKE: PASS (9/9)
node agent/test/etap2-smoke.mjs   → ETAP2-SMOKE: PASS (11/11)
npx vitest run                    → 151/151
```

---

## 4. Допущения (реализованные трактовки поправок — правьте конфигом, не кодом)

1. **П-1 параллельность**: задачи разных разговоров — параллельны (глобал-лимит `autopilot.maxParallel=2`),
   внутри разговора — FIFO. FSM per-task (карточка TaskHub), петля per-conversation.
2. **П-2 read-only MCP**: у agentLink нет setMode; WS `mode.set` — только тумблер UI.
3. **drain**: autopilot→manual при активной задаче применяется ПОСЛЕ её завершения;
   мост читает целевой режим сразу — новые обороты не подаёт.
4. **CONFIRM (B4)** в v1 = DENY с пояснением «запусти с META mode=confirm» (штатная confirm-панель
   остаётся каналом подтверждения). MODIFY = DENY + предложение шлюза (авто-подмена вне v1).
5. **«Отчёт шага» для CHECK-решений**: DENY попадает в notes шага (→ отчёт), все вердикты —
   в data/logs/check-decisions.jsonl + терминал `[CHECK]`; reporter не тронут.
6. **Помощник**: вызывается ТОЛЬКО при стопе «3 одинаковых отпечатка» и только если
   `autopilot.helperAgentId` входит в `helpers.trustedAgents` (дефолт пусто — только человек);
   ответ помощника — через `glm.ingest` с chatId `<чат>:help` → задача origin `autopilot-help`,
   его отчёт возвращается в исходный чат как `hint`.
7. **Память**: слои append-only; `оценка` в relationships не заполняется автоматически (Persona).
8. **wire-origin**: снаружи разрешены только `human|mcp`; `autopilot|help-request|autopilot-help`
   присваиваются только внутри процесса.
