// mcp-stdio.ts — stdio-вход MCP-сервера агента (Base Этап 1 → Этап 2, B0).
// КОНТРАКТ КАНАЛА: stdout — ТОЛЬКО JSON-RPC 2.0 (по строке на сообщение).
// Весь console-вывод перенаправлен в stderr, поэтому хост (Claude Desktop и
// любые MCP-клиенты) получает чистый протокол без шума. Порты не открываются.
//
// B0: транспорт к агенту — WS-клиент (base2/mcp/agentLink.ts) с auth по
// стабильному токену data/state/agent.token. HTTP-эндпоинтов задач у агента
// нет (дизайн) — run_tz/get_status идут по WS task.start/status.get.
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer, MCP_SERVER_INFO } from './mcp-server.js';
import { AgentLink } from './base2/mcp/agentLink.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- ЧИСТЫЙ КАНАЛ: весь консольный вывод — в stderr (до любых логов) ---
const consoleAny = console as unknown as Record<string, (...args: unknown[]) => void>;
for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
  consoleAny[k] = (...args: unknown[]) => {
    process.stderr.write('[mcp-stdio] ' + args.map((a) => String(a)).join(' ') + '\n');
  };
}

const root = resolve(__dirname, '..', '..'); // dist/ → корень репо (там data/state/agent.token)
const port = Number(process.env.SHAI_AGENT_PORT ?? '8787');

let token = (process.env.SHAI_AGENT_TOKEN ?? '').trim();
if (!token) {
  const tokenFile = resolve(root, 'data', 'state', 'agent.token');
  if (existsSync(tokenFile)) token = readFileSync(tokenFile, 'utf8').trim();
}
if (!token) {
  process.stderr.write(
    '[mcp-stdio] ФАТАЛЬНО: токен агента не найден (data/state/agent.token или SHAI_AGENT_TOKEN). ' +
      'Сначала запусти агента (run.cmd / node dist/main.js).\n',
  );
  process.exit(1);
}

// Завершение: stdin закрыт хостом → выходим (без зависших event loop).
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// B0: WS-линк к агенту. Подключаемся ДО server.connect: MCP-host получает
// initialize сразу, а задачи не падают на «линк не открыт». Короткий ретрай
// на случай старта MCP раньше агента (порядок запуска хостом не гарантирован).
const RETRIES = Number(process.env.SHAI_MCP_RETRIES ?? '15');
const RETRY_MS = Number(process.env.SHAI_MCP_RETRY_MS ?? '1000');

let link: AgentLink | null = null;
for (let attempt = 1; attempt <= RETRIES; attempt++) {
  try {
    link = await AgentLink.connect({ port, token, connectTimeoutMs: 5000, authProbeTimeoutMs: 5000 });
    break;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isAuth = msg.includes('auth отклонён');
    if (isAuth || attempt === RETRIES) {
      process.stderr.write('[mcp-stdio] ФАТАЛЬНО: ' + msg + '\n');
      process.exit(1);
    }
    process.stderr.write(`[mcp-stdio] агент не готов (попытка ${attempt}/${RETRIES}): ${msg}\n`);
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}
if (!link) {
  process.stderr.write('[mcp-stdio] ФАТАЛЬНО: WS-линк не установлен\n');
  process.exit(1);
}

const baseUrl = process.env.SHAI_AGENT_URL ?? 'http://127.0.0.1:' + port;
const server = buildMcpServer({ link, baseUrl, token });

await server.connect(new StdioServerTransport());
process.stderr.write(
  `[mcp-stdio] ${MCP_SERVER_INFO.name} v${MCP_SERVER_INFO.version} готов (stdio); транспорт: WS ws://127.0.0.1:${port}/ws\n`,
);
