# Super_HandAI_z — ПОЛНАЯ СБОРКА: Light v1.1 + Base (Этап 1 MCP + Этап 2 Автопилот)

Версия агента 1.2.0 (коммит b02cb61). Чистая полная сборка — ничего докладывать не нужно.

## Состав
- Ядро Light v1.1 (parser, guard, ptyManager, reporter) — без изменений
- Base Этап 1: MCP-слой (6 tools), taskHub, externalHooks, skillconv
- Base Этап 2: автопилот B1-B4 (режим per-agent, мост-вход/петля/стоп-политика/эскалация,
  CHECK-директива), память 4 слоя, taskService (П-1), modeStore (П-2), outflow (П-3), slotBus (П-4)
- services/agp — AGP-гейт проверки операций (node.exe win64 в комплекте)
- agent/dist — собрано; agent/node_modules — prod-зависимости + MCP SDK + win32-пребилды node-pty
- INSTALL.md / REPORT-ETAP2.md — карта установки и отчёт по этапу 2 для Мастера

## Запуск
1. Если есть СТАРАЯ рабочая папка с data/ (токены в data/config.json) — скопируй свою data/ в эту папку.
   data/ в архиве нет намеренно (токены не должны гулять по архивам).
2. Если папка новая: запусти setup.cmd (создаст конфиг), затем run.cmd.
3. npm install / npm run build НЕ нужны — всё собрано и вендорено.

## Живость (кратко, полная карта в INSTALL.md §1)
- initialize отвечает; tools/list = 6; run_tz даёт taskId немедленно
- get_status — непустой state; context_pack — markdown с заголовком
- WS: ping / status.get / mode.get|set|list / autopilot.state

## npm в agent/ не запускать — пребилды node-pty (win32-x64) вендорены вручную.
