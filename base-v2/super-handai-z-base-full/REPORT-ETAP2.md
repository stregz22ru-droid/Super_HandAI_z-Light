# ОТЧЁТ: Super_HandAI_z Base — Этап 2 (Автопилот B0–B4 + Память)

Дата: 13.09.2026. База: моя линия `92a4dfc` (Light v1.1 + Base-этап 1). Пуша нет — только дроп.
Коммиты: `c89748d` (ч.1) → `585ca6d` (ч.2) → `b02cb61` (ч.3).

## 1. Таблица этап / модуль / шаг / статус

| Этап | Модуль | Шаг | Статус |
|---|---|---|---|
| **B0** Ремонт фундамента | `base2/mcp/agentLink.ts` | WS-RPC клиент к агенту (auth agent.token, reqId-корреляция, ping-проба, modeGet без setMode) | ✅ |
| | `mcp.ts` / `mcp-server.ts` / `mcp-stdio.ts` | run_tz/get_status → WS; context_pack → прямой билдер; features/purge → HTTP; 6 tools; ретрай подключения | ✅ |
| | `server.ts` | WS-расширения: ping/status.get (+reqId-ответ task.start) | ✅ |
| **П-1** Мульти-инициатор | `base2/taskService.ts` | startTz(tzText, origin, {sessionId, conversationId}); taskId немедленно; per-conversation FIFO; maxParallel | ✅ |
| | `core/taskHub.ts` | карта активных per-conversation; origin/sessionId/conversationId/reportPath в карточке | ✅ |
| | `base2/types.ts` | origin-типы; wire-ограничение human\|mcp | ✅ |
| **B1** Режим | `base2/modeStore.ts` | карта {[agentId]: mode}; config.mode отдельным ключом; атомарная запись; mode.changed; журнал by-origin | ✅ |
| | `base2/modeGate.ts` | idle-gate (manual→autopilot); drain (autopilot→manual); блок при confirm-панели | ✅ |
| | `server.ts` | WS mode.get/set/list; ретрансляция mode.changed в UI | ✅ |
| **B2** Мост, вход | `autopilot/tzContract.ts` | контракт ````shai-tz (4 бэктика) + complete:true/маркер; нормализация; sha256 | ✅ |
| | `autopilot/tzQueue.ts` | один слот, TTL, keep-oldest | ✅ |
| | `autopilot/bridgeIn.ts` | ingestAnswer: контракт→parser→дедуп→слот→idle-gate→старт; журнал отказов с причиной; pumpIdle | ✅ |
| **B3** Мост, выход и петля | `autopilot/ledger.ts` | обороты, отпечатки K4, per-инициатор K9 | ✅ |
| | `autopilot/stopPolicy.ts` | N=5 без SUCCESS; 3 одинаковых подряд; контрактное завершение (не подстрока) | ✅ |
| | `autopilot/redaction.ts` + `outflow.ts` | redaction per-agent (токены/пути/URL), квота с журналом | ✅ |
| | `autopilot/escalation.ts` | 3 приёмника (чат/терминал/файл) + помощник (порог «3 отпечатка», trusted) | ✅ |
| | `autopilot/fsm.ts` + `fsmPersist.ts` | FSM per-task/петля per-chat; события slotBus; state-файл tmp+rename; recovery K5 | ✅ |
| **B4** CHECK-директива | `core/stepEngine.ts` + `features/registry.ts` | deny-вердикт preRun — ЕДИНСТВЕННАЯ врезка; но-оп при выключенной фиче | ✅ |
| | `check/client.ts`, `check/cache.ts`, `check/directive.ts` | AGP /agent/check-operation; вердикты ALLOW/DENY/CONFIRM/MODIFY(=DENY+предложение); кэш hash(cmd,workdir,mode) TTL 60с + инвалидация mode.changed; бюджет 1.5с; fail-closed деструктивного класса; guard финален; журнал решений; origin.agentId в AGP | ✅ |
| | `features/check-directive.feature.js` | beforeRun-слот, ленивая инициализация | ✅ |
| **ПАМЯТЬ** | `base2/memory/store.ts` | слой 1: CONTEXT.md (append) после task.done; слой 2: projects.json (циклы/статусы/даты/резюме); слой 3: conversations/<chatId>.jsonl; слой 4: agents/<agentId>.json (autopilot-help → relationships) | ✅ |
| **Интеграция** | `server.ts`, `proto.ts`, `config.ts`, 4 фичи | делегация taskService; WS-расширения; секции конфига; витрина | ✅ |

## 2. Проверки и stdout-маркеры (прогоны 13.09.2026)

```
TSC-EXIT: 0

=== vitest (16 файлов) ===
 Test Files  16 passed (16)
      Tests  151 passed (151)

=== node agent/test/mcp-smoke.mjs ===
[OK] MCP-1 initialize отвечает — super-handai-z
[OK] MCP-2 tools/list = 6 — context_pack,features_list,features_toggle,get_status,purge_workspace,run_tz
[OK] MCP-3 run_tz → taskId немедленно — task_… (16мс)
[OK] MCP-4 get_status: state непустой на каждом полле + engineStatus/steps в терминале — done/SUCCESS
[OK] MCP-5 context_pack непустой markdown — 10538 симв., заголовок: true
[OK] MCP-6 features_list — фич: 7
[OK] MCP-7 features_toggle round-trip — reflect false→true→false
[OK] MCP-8 purge_workspace — removed: 1
[OK] MCP-9 канал чистый (stderr без фатальных ошибок)
MCP-SMOKE: PASS (9/9)

=== node agent/test/etap2-smoke.mjs ===
[OK] ET2-1 WS-расширения отвечают (ping→pong)
[OK] ET2-2 task.start (WS) → taskId + status.get: state непустой на каждом полле
[OK] ET2-3 mode.set → mode.changed + config.mode записан (ok=true, changed=true, persisted=true)
[OK] ET2-4 manual: мост не подаёт задачи — manual-skip
[OK] ET2-5 autopilot: ТЗ → задача программно; outbox: отчёт оборота; контрактное завершение → стоп в успехе
[OK] ET2-6 redaction в исходящем: нет agent.token/внутренних URL
[OK] ET2-7 data/autopilot-state.json существует (K5)
ETAP2-SMOKE: PASS (11/11)   ← дважды подряд (идемпотентен)
```

Критерии ТЗ → где проверены программно:
- B0: initialize/tools=6/run_tz taskId/get_status непустой state/context_pack ≥80 без «route не подключён» → MCP-SMOKE 9/9.
- B1: рестарт сохраняет mode (unit `base2-mode`), drain-политика (unit), origin в журнале (unit), MCP read-only (agentLink без setMode + тест), тумблер переживает рестарт (unit + ET2-3 persisted).
- B2: ТЗ→задача программно; дедуп; слот/TTL; отказ с журналом; manual-гейт → симуляция (10 сценариев) + unit.
- B3: 5 без SUCCESS→стоп+эскалация; 3 отпечатка→стоп; контракт→успех; подстрока НЕ останавливает; kill в RUNNING→восстановление (unit K5); redaction/квота+журнал (unit+ET2-6).
- B4: кэш/инвалидация/бюджет/fail-closed/guard-финален/журнал решений → `base2-check` (12 тестов, мок-AGP).
- Память: 4 слоя append-only → `base2-memory`.

## 3. Ядро — неприкосновенность

`git diff 92a4dfc..HEAD -- agent/src/core/guard.ts agent/src/core/reporter.ts agent/src/core/ptyManager.ts agent/src/tz/parser.ts` → **0 строк**.
Единственная врезка: stepEngine deny-ветка beforeRun (23 строки с комментариями) + registry (9 строк).

## 4. Гигиена дерева

mode-only изменения (131 файл от копирования воркспейса) в коммиты НЕ входили.
Новые файлы этапа: 22 модуля base2, 4 фичи, 12 тест-файлов, 2 смоука.
