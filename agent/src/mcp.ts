// mcp.ts — MCP-слой: реализации шести инструментов (Base Этап 1 → Этап 2, B0).
//
// B0 (ремонт фундамента, вердикт Ponytail-Research 5.1):
//  • Транспорт задачных операций — WS-клиент к агенту (base2/mcp/agentLink.ts):
//    HTTP-эндпоинтов задач в server.ts НЕТ и не будет (дизайн команды);
//    задачи — WS task.start, статус — WS status.get из ЕДИНОГО TaskHub.
//  • context_pack — ПРЯМОЙ вызов единого билдера core/contextPack.ts (без HTTP
//    и route-слотов; один билдер на всех потребителей — Ponytail).
//  • features_list / features_toggle / purge_workspace — HTTP /features* и
//    /workspace/purge (эти эндпоинты в канонической сборке ЕСТЬ, это не задачи).
import { z } from 'zod';
import { buildContextPack } from './core/contextPack.js';
import type { AgentLink } from './base2/mcp/agentLink.js';

export { AgentLink } from './base2/mcp/agentLink.js';

/** Транспорты MCP: WS-линк (задачи/статус/режим-чтение) + HTTP-реквизит
 *  (features/purge — эндпоинты канонической сборки). */
export interface McpTransports {
  link: AgentLink;
  baseUrl: string;
  token: string;
}

/** Все HTTP-вызовы агента идут с токеном ?t= (тот же гейт, что у UI/моста). */
function withToken(bridge: McpTransports, path: string): string {
  return bridge.baseUrl + path + (path.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(bridge.token);
}

async function agentJson<T>(
  bridge: McpTransports,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(withToken(bridge, path), {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 2000) };
  }
  if (!res.ok) {
    const msg = (parsed as { error?: string })?.error ?? text.slice(0, 200);
    throw new Error(`агент HTTP ${res.status}: ${msg}`);
  }
  return parsed as T;
}

// ---------- zod-схемы входов (контракт инструментов) ----------

export const RunTzShape = {
  tzText: z
    .string()
    .min(1)
    .describe('Полный текст ТЗ в формате format-spec: "# ЗАДАЧ:", "# META" (workdir/mode/on_fail), "## ШАГ N", директивы RUN/WRITE/EXPECT.'),
};

export const GetStatusShape = {
  taskId: z.string().min(1).describe('taskId из ответа run_tz.'),
};

export const FeaturesToggleShape = {
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/, 'имя фичи: [a-z0-9-]{2,32}'),
  enabled: z.boolean().describe('true — включить (после рестарта агента), false — выключить.'),
};

// ---------- реализации инструментов (возврат = structuredContent) ----------

/**
 * run_tz: WS task.start (П-1: origin {type:'mcp', agentId:'mcp'}, conversationId
 * 'mcp' — MCP-инициированные задачи образуют СВОЙ разговор и не блокируют UI).
 * Агент валидирует ТЗ и отвечает {taskId} СРАЗУ (исполнение в фоне).
 */
export async function toolRunTz(bridge: McpTransports, args: { tzText: string }): Promise<Record<string, unknown>> {
  const taskId = await bridge.link.startTz(args.tzText);
  return { taskId };
}

/**
 * get_status: WS status.get — карточка задачи из ТОГО ЖЕ TaskHub, куда run_tz
 * кладёт задачу (единый store агента; сплит-брейн store'ов невозможен).
 * КОНТРАКТ-ГЕЙТ (ДОЗАКАЗ п.1, сохранён):
 *   • state — непустая строка ВСЕГДА (queued/running/done/failed/stopped/denied);
 *   • в терминальном состоянии — engineStatus и steps на месте.
 * Нарушение любого пункта = дефект сплит-брейна store'ов → явная ошибка, не «—».
 */
export async function toolGetStatus(bridge: McpTransports, args: { taskId: string }): Promise<Record<string, unknown>> {
  const task = await bridge.link.getStatus(args.taskId);
  const state = task.state;
  if (typeof state !== 'string' || state.trim() === '') {
    throw new Error(
      "get_status: ответ агента БЕЗ непустого state — статус-канал не связан с TaskHub, " +
      "в котором run_tz создаёт задачу (сплит-брейн store'ов — ДОЗАКАЗ п.1).",
    );
  }
  const terminal = state === 'done' || state === 'failed' || state === 'stopped' || state === 'denied';
  if (terminal && (typeof task.engineStatus !== 'string' || !Array.isArray(task.steps))) {
    throw new Error(
      'get_status: задача в терминальном состоянии, но engineStatus/steps отсутствуют — ' +
      'финишер TaskHub не связан с карточкой задачи (нарушение контракта {state, engineStatus, steps}).',
    );
  }
  return { ok: true, task };
}

/** features_list: GET /features — реестр фич с полями enabled/loaded/bundled. */
export async function toolFeaturesList(bridge: McpTransports): Promise<Record<string, unknown>> {
  return agentJson<Record<string, unknown>>(bridge, 'GET', '/features');
}

/** features_toggle: POST /features/toggle {name, enabled} — пишет config.features. */
export async function toolFeaturesToggle(
  bridge: McpTransports,
  args: { name: string; enabled: boolean },
): Promise<Record<string, unknown>> {
  return agentJson<Record<string, unknown>>(bridge, 'POST', '/features/toggle', { name: args.name, enabled: args.enabled });
}

/**
 * context_pack: ПРЯМОЙ вызов единого билдера core/contextPack.ts — БЕЗ HTTP-пути
 * и route-слотов (ДОЗАКАЗ п.2, сохранено в Этапе 2). Билдер один для HTTP-фичи
 * и MCP — содержимое артефакта не зависит от входа.
 */
export async function toolContextPack(): Promise<{ markdown: string }> {
  const markdown = await buildContextPack();
  if (typeof markdown !== 'string' || markdown.trim().length < 40 || !markdown.includes('# Context Pack')) {
    throw new Error('context_pack: билдер вернул пустой/неполный markdown — проверь core/contextPack.ts');
  }
  return { markdown };
}

/** purge_workspace: POST /workspace/purge — полная очистка (отклоняется при активной задаче). */
export async function toolPurgeWorkspace(bridge: McpTransports): Promise<Record<string, unknown>> {
  return agentJson<Record<string, unknown>>(bridge, 'POST', '/workspace/purge');
}
