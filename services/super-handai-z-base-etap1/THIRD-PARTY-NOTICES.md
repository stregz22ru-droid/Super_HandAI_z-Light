# THIRD-PARTY-NOTICES

Сторонние материалы, использованные при разработке Super_HandAI_z Base.

## Ponytail (донор паттернов)

- Проект: Ponytail — "Lazy senior dev mode for AI agents"
- Репозиторий: https://github.com/DietrichGebert/ponytail
- Версия-референс: 4.9.0
- Лицензия: MIT License
- Copyright (c) 2026 DietrichGebert

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Что именно заимствовано (паттерны и формат, не предметный контент)

| Компонент Super_HandAI_z Base (Этап 1) | Заимствованный паттерн донора |
|---|---|
| `agent/src/core/taskHub.ts` (единый выделитель задач HTTP+MCP) | подход к изоляции MCP-сервера от основного процесса (Ponytail-Research, таблица 10) |
| `agent/src/core/externalHooks.ts` (Windows-гигиена внешних хуков) | BOM-strip, CRLF-толерантность, plain node без `exec`/`&&`, allowlist путей, self-exit по бюджету — из hooks-windows.test.js (#443, #593, #527, #569) |
| `agent/src/features/registry.ts` (onSessionStart, additionalContext, never-block, disableSelf) | идеи hooks-контрактов SessionStart / additionalContext (таблица 9 отчёта) |
| `agent/src/mcp.ts`, `agent/src/mcp-server.ts` (MCP-экспозиция поверх stdio) | паттерн тонкого MCP-сервера над общим ядром (SDK @modelcontextprotocol/sdk) |
| `agent/src/skillconv.ts` (конвертер пак ↔ SKILL.md + sync-guard) | формат SKILL.md (frontmatter name/description, ≤160 в description) и sync-guard тесты по образцу openclaw-skills.test.js (таблица 11) |

**Не переносилось:** предметный контент донора — правила «ленивого сеньора»,
инструкции `skills/*` донора, тексты их промптов, примеры. Вся предметная
составляющая Super_HandAI_z (ТЗ-контракт, EXPECT-верификация, слоты фич,
витрина, AGP) — оригинальная.

### Зависимости из экосистемы MCP

- `@modelcontextprotocol/sdk` (MIT, © Model Context Protocol contributors) —
  транспорт stdio/InMemory и протокольная обвязка; точная версия зафиксирована
  в `agent/package-lock.json`.
