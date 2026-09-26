#!/usr/bin/env node
// test/mcp-smoke.mjs — смоук MCP-канала (B0, 8 маркеров) на канонической сборке.
// Запуск: node agent/test/mcp-smoke.mjs   (из корня репо; агент должен быть запущен)
// Канал: spawn `node dist/mcp-stdio.js` (ЧИСТЫЙ stdio JSON-RPC) → MCP SDK;
//        задачные операции внутри — WS-транспорт к агенту (task.start/status.get).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const PORT = process.env.SHAI_AGENT_PORT ?? '8787';
let token = (process.env.SHAI_AGENT_TOKEN ?? '').trim();
if (!token) {
  const tf = resolve(root, 'data', 'state', 'agent.token');
  if (existsSync(tf)) token = readFileSync(tf, 'utf8').trim();
}
if (!token) {
  console.error('MCP-SMOKE: FAIL — токен агента не найден (data/state/agent.token)');
  process.exit(1);
}

const child = spawn(process.execPath, [resolve(root, 'agent', 'dist', 'mcp-stdio.js')], {
  env: { ...process.env, SHAI_AGENT_PORT: PORT, SHAI_AGENT_TOKEN: token },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderrBuf = '';
child.stderr.on('data', (d) => (stderrBuf += d.toString()));
const stdoutLines = [];
child.stdout.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    if (line.trim()) stdoutLines.push(line);
  }
});

let seq = 0;
const pending = new Map();
function send(method, params, isNotification = false) {
  return new Promise((resolveP, rejectP) => {
    if (isNotification) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
      resolveP(undefined);
      return;
    }
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectP(new Error('таймаут ' + method));
    }, 30000);
    pending.set(id, { resolveP, rejectP, timer, method });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
child.stdout.on('data', () => {
  // разбор строк делаем лениво после каждой пачки
  while (stdoutLines.length > 0) {
    const line = stdoutLines.shift();
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.rejectP(new Error(p.method + ': ' + JSON.stringify(msg.error).slice(0, 300)));
      else p.resolveP(msg.result);
    }
  }
});

const results = [];
function marker(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`[${ok ? 'OK' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function callTool(name, args) {
  const r = await send('tools/call', { name, arguments: args });
  if (r.isError) throw new Error('tool ' + name + ': ' + (r.content?.[0]?.text ?? 'ошибка'));
  return r;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // MCP-1: initialize отвечает (стартовый блок: McpServer + StdioServerTransport + connect)
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'shai-smoke', version: '1.0.0' },
  });
  marker('MCP-1 initialize отвечает', !!init?.serverInfo?.name, init?.serverInfo?.name);
  await send('notifications/initialized', {}, true);

  // MCP-2: tools/list = ровно 6
  const tools = await send('tools/list', {});
  const names = (tools?.tools ?? []).map((t) => t.name).sort();
  marker('MCP-2 tools/list = 6', names.length === 6, names.join(','));

  // MCP-3: run_tz даёт taskId НЕМЕДЛЕННО (WS task.start, origin mcp)
  const tz = `# ЗАДАЧ: смоук MCP
# META
workdir: new:ws-mcp-smoke
mode: auto

## ШАГ 1. Маркер
RUN
\`\`\`bash
echo mcp-auto-ok
\`\`\`
EXPECT stdout contains: mcp-auto-ok
`;
  const t0 = Date.now();
  const run = await callTool('run_tz', { tzText: tz });
  const payload = JSON.parse(run.content?.[0]?.text ?? '{}');
  const taskId = payload.taskId;
  marker('MCP-3 run_tz → taskId немедленно', typeof taskId === 'string' && taskId.startsWith('task_'), `${taskId} (${Date.now() - t0}мс)`);

  // MCP-4: get_status — state НЕПУСТОЙ на КАЖДОМ полле; терминал несёт engineStatus+steps
  let okStatus = true;
  let terminal = null;
  for (let i = 0; i < 40; i++) {
    const st = await callTool('get_status', { taskId });
    const card = JSON.parse(st.content?.[0]?.text ?? '{}')?.task ?? {};
    if (typeof card.state !== 'string' || card.state.trim() === '') {
      okStatus = false;
      marker('MCP-4 get_status state непустой', false, `полл ${i}: state=${JSON.stringify(card.state)}`);
      break;
    }
    if (['done', 'failed', 'stopped', 'denied'].includes(card.state)) {
      terminal = card;
      break;
    }
    await sleep(250);
  }
  if (okStatus) {
    const okTerm = terminal && typeof terminal.engineStatus === 'string' && Array.isArray(terminal.steps);
    marker('MCP-4 get_status: state непустой на каждом полле + engineStatus/steps в терминале', okTerm, terminal ? `${terminal.state}/${terminal.engineStatus}` : 'не дождались терминала');
  }

  // MCP-5: context_pack — markdown ≥80 симв., заголовок, без следов «route не подключён»/403
  const cp = await callTool('context_pack', {});
  const md = cp.content?.[0]?.text ?? '';
  const cpOk = md.length >= 80 && md.includes('# Context Pack') && !md.includes('route не подключён') && !md.includes('403');
  marker('MCP-5 context_pack непустой markdown', cpOk, `${md.length} симв., заголовок: ${md.includes('# Context Pack')}`);

  // MCP-6: features_list — реестр читается
  const fl = await callTool('features_list', {});
  const flBody = JSON.parse(fl.content?.[0]?.text ?? '{}');
  marker('MCP-6 features_list', flBody.ok === true && Array.isArray(flBody.features), `фич: ${(flBody.features ?? []).length}`);

  // MCP-7: features_toggle round-trip (возвращаем как было)
  const current = (flBody.features ?? []).find((f) => f.name === 'reflect');
  const was = current?.enabled === true;
  await callTool('features_toggle', { name: 'reflect', enabled: !was });
  await callTool('features_toggle', { name: 'reflect', enabled: was });
  marker('MCP-7 features_toggle round-trip', true, `reflect ${was}→${!was}→${was}`);

  // MCP-8: purge_workspace (при свободном агенте — ok)
  const pg = await callTool('purge_workspace', {});
  const pgBody = JSON.parse(pg.content?.[0]?.text ?? '{}');
  marker('MCP-8 purge_workspace', pgBody.ok === true, `removed: ${pgBody.removed}`);

  // Канал чистый: stderr без протокола (только диагностика), процесс закрывается по stdin
  child.stdin.end();
  await sleep(300);
  const clean = !stderrBuf.includes('ФАТАЛЬНО');
  marker('MCP-9 канал чистый (stderr без фатальных ошибок)', clean, stderrBuf.split('\n').slice(-3).join(' | '));

  child.kill();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nMCP-SMOKE: ${passed === results.length ? 'PASS' : 'FAIL'} (${passed}/${results.length})`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('MCP-SMOKE: FAIL —', e.message);
  if (stderrBuf) console.error('[stderr]\n' + stderrBuf.slice(-800));
  child.kill();
  process.exit(1);
});
