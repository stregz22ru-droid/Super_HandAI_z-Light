// mcp.ts — MCP-сервер Light-агента (Base Этап 1).
// Полная версия с запуском. Работает поверх HTTP API агента на 8787.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const AGENT_BASE = 'http://127.0.0.1:8787';
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? '';

async function agentJson(method: string, path: string, body?: unknown): Promise<any> {
  const url = AGENT_BASE + path + (path.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(AGENT_TOKEN);
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 2000) }; }
  if (!res.ok) {
    const msg = parsed?.error ?? text.slice(0, 200);
    throw new Error(`агент HTTP ${res.status}: ${msg}`);
  }
  return parsed;
}

async function toolRunTz(args: { tzText: string }): Promise<{ taskId: string }> {
  const r = await agentJson('POST', '/tasks', { tzText: args.tzText });
  return { taskId: r.taskId };
}

async function toolGetStatus(args: { taskId: string }): Promise<any> {
  let r;
  try {
    r = await agentJson('GET', '/tasks/' + encodeURIComponent(args.taskId));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('404')) {
      throw new Error('get_status: задача не найдена в агенте (404) — сплит-брейн store\'ов');
    }
    throw e;
  }
  const task = r.task ?? r;
  const state = task?.state;
  if (typeof state !== 'string' || state.trim() === '') {
    throw new Error('get_status: ответ БЕЗ непустого state — сплит-брейн store\'ов');
  }
  return r;
}

async function toolFeaturesList(): Promise<any> {
  return agentJson('GET', '/features');
}

async function toolFeaturesToggle(args: { name: string; enabled: boolean }): Promise<any> {
  return agentJson('POST', '/features/toggle', args);
}

async function toolContextPack(): Promise<{ markdown: string }> {
  const r = await agentJson('GET', '/features/context-pack');
  return { markdown: r.markdown ?? JSON.stringify(r) };
}

async function toolPurgeWorkspace(): Promise<any> {
  return agentJson('POST', '/workspace/purge');
}

// === MCP-СЕРВЕР ===
const mcpServer = new McpServer({
  name: 'super-handai-z',
  version: '1.1.0',
});

mcpServer.registerTool(
  'run_tz',
  { title: 'Запустить ТЗ', inputSchema: { tzText: z.string().min(1) } },
  async ({ tzText }) => {
    const r = await toolRunTz({ tzText });
    return { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r };
  }
);

mcpServer.registerTool(
  'get_status',
  { title: 'Статус задачи', inputSchema: { taskId: z.string().min(1) } },
  async ({ taskId }) => {
    const r = await toolGetStatus({ taskId });
    return { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r };
  }
);

mcpServer.registerTool(
  'features_list',
  { title: 'Список фич' },
  async () => {
    const r = await toolFeaturesList();
    return { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r };
  }
);

mcpServer.registerTool(
  'features_toggle',
  { title: 'Вкл/выкл фичу', inputSchema: { name: z.string(), enabled: z.boolean() } },
  async ({ name, enabled }) => {
    const r = await toolFeaturesToggle({ name, enabled });
    return { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r };
  }
);

mcpServer.registerTool(
  'context_pack',
  { title: 'Контекст-пак проекта' },
  async () => {
    const r = await toolContextPack();
    return { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r };
  }
);

mcpServer.registerTool(
  'purge_workspace',
  { title: 'Очистить workspace' },
  async () => {
    const r = await toolPurgeWorkspace();
    return { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r };
  }
);

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
console.error('[mcp] сервер готов: 6 tools через stdio');