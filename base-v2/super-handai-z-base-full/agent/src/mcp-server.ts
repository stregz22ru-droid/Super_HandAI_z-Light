// mcp-server.ts — MCP-сервер агента (Base Этап 1 → Этап 2, B0).
// Шесть инструментов над ЕДИНЫМ выделителем задач: задачные реализации (mcp.ts)
// ходят WS-вызовами в живой агент (agentLink → task.start / status.get того же
// TaskHub, что у WS-моста и операторской витрины). Guard/AGP/confirm-проверки
// те же, что и у остальных входов: MCP не даёт обхода безопасности. Отмена
// оператора (task.stop / confirm.answer) = SKIP. Режим агента — READ-ONLY (П-2):
// инструмента переключения режима НЕ СУЩЕСТВУЕТ (modeGet в agentLink — только чтение).
// context_pack — исключение из транспорта: он зовёт ЕДИНЫЙ билдер
// core/contextPack.ts напрямую (в MCP-процессе route-слотов нет — ДОЗАКАЗ п.2).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  McpTransports,
  RunTzShape,
  GetStatusShape,
  FeaturesToggleShape,
  toolRunTz,
  toolGetStatus,
  toolFeaturesList,
  toolFeaturesToggle,
  toolContextPack,
  toolPurgeWorkspace,
} from './mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')) as { version?: string };

export const MCP_SERVER_INFO = { name: 'super-handai-z', version: PKG.version ?? '0.0.0' };

function text(t: string) {
  return { type: 'text' as const, text: t };
}

function ok(payload: Record<string, unknown>) {
  return { content: [text(JSON.stringify(payload, null, 2))], structuredContent: payload };
}

function errText(e: unknown) {
  return { content: [text(e instanceof Error ? e.message : String(e))], isError: true as const };
}

export function buildMcpServer(bridge: McpTransports): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version },
    {
      instructions:
        'MCP-сервер Super_HandAI_z — детерминированный ТЗ-исполнитель. ' +
        'run_tz запускает ТЗ и НЕМЕДЛЕННО возвращает {taskId} (исполнение идёт в фоне); ' +
        'далее опрашивай get_status до state=done и сверяй engineStatus (SUCCESS/PARTIAL/STOPPED/DENIED).',
    },
  );

  // 1) run_tz — async-запуск: ответ {taskId} сразу, вызов не держится открытым.
  server.registerTool(
    'run_tz',
    {
      title: 'Запустить ТЗ',
      description:
        'Валидирует и запускает ТЗ в агенте; НЕМЕДЛЕННО возвращает {taskId}. ' +
        'Исполнение в фоне: опрашивай get_status до state=done.',
      inputSchema: RunTzShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ tzText }) => {
      try {
        return ok(await toolRunTz(bridge, { tzText }));
      } catch (e) {
        return errText(e);
      }
    },
  );

  // 2) get_status — чтение карточки задачи (ТОТ ЖЕ TaskHub, что у run_tz: контракт-гейт в mcp.ts; WS status.get).
  server.registerTool(
    'get_status',
    {
      title: 'Статус задачи',
      description:
        'Карточка задачи по taskId: state (queued/running/done/failed/stopped/denied — ВСЕГДА непустой), ' +
        'engineStatus (SUCCESS/PARTIAL/STOPPED/DENIED), шаги с outputTail, workspace, reportMd.',
      inputSchema: GetStatusShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ taskId }) => {
      try {
        return ok(await toolGetStatus(bridge, { taskId }));
      } catch (e) {
        return errText(e);
      }
    },
  );

  // 3) features_list — реестр фич (bundled: reflect/dry-run/context-pack).
  server.registerTool(
    'features_list',
    {
      title: 'Список фич',
      description: 'Список фич системы фич: name/title/version/slot/enabled/loaded/bundled + подрежимы.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return ok(await toolFeaturesList(bridge));
      } catch (e) {
        return errText(e);
      }
    },
  );

  // 4) features_toggle — включение/выключение фичи (пишет config.features).
  server.registerTool(
    'features_toggle',
    {
      title: 'Переключить фичу',
      description:
        'Включить/выключить фичу {name, enabled}. Включение применяется после рестарта агента; подрежимы действуют сразу.',
      inputSchema: FeaturesToggleShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ name, enabled }) => {
      try {
        return ok(await toolFeaturesToggle(bridge, { name, enabled }));
      } catch (e) {
        return errText(e);
      }
    },
  );

  // 5) context_pack — единый markdown-контекст; ПРЯМОЙ вызов билдера (не HTTP).
  server.registerTool(
    'context_pack',
    {
      title: 'Контекст-пак',
      description:
        'Markdown-артефакт: versions ядра и фич, config, git status workspace, последние 20 записей journal. ' +
        'Собирается единым билдером (тот же, что у HTTP-фичи context-pack) — работает даже без живого агента.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const { markdown } = await toolContextPack();
        return { content: [text(markdown)] };
      } catch (e) {
        return errText(e);
      }
    },
  );

  // 6) purge_workspace — полная очистка workspace (отклоняется при активной задаче).
  server.registerTool(
    'purge_workspace',
    {
      title: 'Очистить workspace',
      description: 'Удаляет все папки в корне workspace. Отклоняется (409), пока исполняется задача.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return ok(await toolPurgeWorkspace(bridge));
      } catch (e) {
        return errText(e);
      }
    },
  );

  return server;
}
