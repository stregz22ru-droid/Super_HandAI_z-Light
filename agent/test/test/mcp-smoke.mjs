#!/usr/bin/env node
// test/mcp-smoke.mjs — MCP-смоук на реальном stdio (ЭТАП 1, МОДУЛЬ 1).
// Поднимает node dist/mcp.js как отдельный процесс (как это сделает хост-чат),
// говорит JSON-RPC поверх stdin/stdout и проходит цепочку:
//   tools/list → run_tz → taskId → get_status → task.done → features_toggle →
//   → features_list → context_pack → purge_workspace
// Маркеры (stdout): MCP-SMOKE-TOOLS, MCP-SMOKE-STDIO-CLEAN, MCP-SMOKE-RUN_TZ,
//   MCP-SMOKE-STATUS-RUNNING, MCP-SMOKE-TASK-DONE, MCP-SMOKE-TOGGLE,
//   MCP-SMOKE-FEATURES, MCP-SMOKE-CTX-PACK, MCP-SMOKE-PURGE, MCP-SMOKE
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO = resolve(AGENT, '..');
const FAILS = [];
const fail = (m) => { FAILS.push(m); console.error('[MCP-SMOKE] !! ' + m); };

// --- изолированный корень (SHAI_ROOT) ---
const root = mkdtempSync(join(tmpdir(), 'shz-mcp-smoke-'));
mkdirSync(join(root, 'agent', 'features'), { recursive: true });
mkdirSync(join(root, 'data', 'state'), { recursive: true });
mkdirSync(join(root, 'workspace'), { recursive: true });
for (const f of ['reflect.feature.js', 'dry-run.feature.js', 'context-pack.feature.js']) {
  copyFileSync(join(AGENT, 'features', f), join(root, 'agent', 'features', f));
}
copyFileSync(join(AGENT, 'package.json'), join(root, 'agent', 'package.json'));
const cfg = {
  port: 0,
  workspaceRoot: join(root, 'workspace'),
  features: { reflect: true, 'dry-run': true, 'context-pack': true },
  stepTimeoutSec: 20,
};
writeFileSync(join(root, 'data', 'state', 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

const TZ = `\`\`\`tz
# ЗАДАЧ: MCP смоук stdio
# META
workdir: new:mcp-smoke-ws
mode: auto
on_fail: stop

## ШАГ 1. Эхо
RUN shell: bash
\`\`\`bash
echo mcp-smoke-echo
\`\`\`
EXPECT exit=0
EXPECT stdout contains:mcp-smoke-echo
\`\`\``;

// --- процесс MCP ---
const child = spawn(process.execPath, [join(AGENT, 'dist', 'mcp.js')], {
  env: { ...process.env, SHAI_ROOT: root },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderrBuf = '';
child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

let stdoutBuf = '';
let protocolViolations = 0;
let nextId = 1;
const pending = new Map();

child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString('utf8');
  let idx;
  while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    let msg = null;
    try { msg = JSON.parse(line); } catch { protocolViolations++; continue; } // stdout = только JSON-RPC
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    child.stdin.write(msg);
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); rej(new Error('таймаут ответа: ' + method)); }
    }, 30000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', jsonmethod: undefined, method, params }) + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1) initialize
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'shai-smoke', version: '1.0.0' },
  });
  console.log('[MCP-SMOKE] initialize: server=' + init.serverInfo?.name + ' v' + init.serverInfo?.version);
  notify('notifications/initialized', {});

  // 2) tools/list — ровно 6, с аннотациями
  const tools = await request('tools/list', {});
  const names = tools.tools.map((t) => t.name).sort();
  const expected = ['context_pack', 'features_list', 'features_toggle', 'get_status', 'purge_workspace', 'run_tz'];
  console.log('[MCP-SMOKE-TOOLS]: ' + names.length + ' ' + names.join(','));
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail('tools: ' + names.join(','));
  const ro = Object.fromEntries(tools.tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
  if (!(ro.get_status === true && ro.features_list === true && ro.context_pack === true)) fail('readOnlyHint read-инструментов');
  if (!(ro.run_tz === false && ro.features_toggle === false && ro.purge_workspace === false)) fail('readOnlyHint write-инструментов');
  if (tools.tools.find((t) => t.name === 'purge_workspace')?.annotations?.destructiveHint !== true) fail('destructiveHint у purge_workspace');

  // stdout-гигиена: каждая строка — JSON-RPC (нарушения считались в обработчике)
  console.log('[MCP-SMOKE-STDIO-CLEAN]: ' + (protocolViolations === 0 ? 'да' : 'нет (' + protocolViolations + ')'));
  if (protocolViolations !== 0) fail('stdout загрязнён не-JSON-RPC выводом');

  // 3) run_tz → taskId СРАЗУ (вызов не держится открытым)
  const t0 = Date.now();
  const run = await request('tools/call', { name: 'run_tz', arguments: { tzText: TZ } });
  const dt = Date.now() - t0;
  const taskId = run.structuredContent?.taskId;
  console.log('[MCP-SMOKE-RUN_TZ]: taskId=' + taskId + ' (ответ за ' + dt + 'ms, асинхронно)');
  if (!taskId) fail('run_tz не вернул taskId');
  if (dt > 5000) fail('run_tz держал вызов открытым (' + dt + 'ms)');

  // 4) get_status → RUNNING (или уже done) → ждём task.done
  let rec = null;
  let sawRunning = false;
  for (let i = 0; i < 120; i++) {
    const st = await request('tools/call', { name: 'get_status', arguments: { taskId } });
    rec = st.structuredContent?.task;
    if (rec?.status === 'RUNNING') sawRunning = true;
    if (rec && rec.status !== 'RUNNING') break;
    await sleep(200);
  }
  console.log('[MCP-SMOKE-STATUS-RUNNING]: ' + (sawRunning ? 'виден' : 'пролетёл (быстро)'));
  console.log('[MCP-SMOKE-TASK-DONE]: ' + rec?.status);
  if (rec?.status !== 'SUCCESS') fail('задача не SUCCESS: ' + rec?.status);
  if (rec?.steps?.[0]?.status !== 'ok') fail('шаг 1 не ok: ' + rec?.steps?.[0]?.status);
  if (!rec?.reportPath || !existsSync(rec.reportPath)) fail('отчёт не найден: ' + rec?.reportPath);
  if (!stderrBuf.includes('[mcp] super-handai-z готов')) fail('boot-строки нет в stderr (логи должны идти в stderr)');

  // 5) единый выделитель: пока ничего не running — свободно; запускаем вторую и бьём в занятость
  const run2 = await request('tools/call', { name: 'run_tz', arguments: { tzText: TZ.replace('MCP смоук stdio', 'MCP смоук 2') } });
  const busy = await request('tools/call', { name: 'run_tz', arguments: { tzText: TZ } });
  const busyText = busy.content?.[0]?.text ?? '';
  console.log('[MCP-SMOKE-LOCK]: ' + (busy.isError ? 'двойная активность отклонена' : 'ПРОПУЩЕНА!'));
  if (!busy.isError || !busyText.includes('task already running')) fail('двойная активность не отклонена');
  const t2 = run2.structuredContent?.taskId;
  for (let i = 0; i < 120; i++) {
    const st = await request('tools/call', { name: 'get_status', arguments: { taskId: t2 } });
    if (st.structuredContent?.task?.status !== 'RUNNING') break;
    await sleep(200);
  }

  // 6) features_toggle → config.json на диске
  await request('tools/call', { name: 'features_toggle', arguments: { name: 'dry-run', enabled: false } });
  const cfgOnDisk = JSON.parse(readFileSync(join(root, 'data', 'state', 'config.json'), 'utf8'));
  const toggled = cfgOnDisk.features['dry-run'] === false;
  console.log('[MCP-SMOKE-TOGGLE]: dry-run=false записан в config.json → ' + (toggled ? 'да' : 'нет'));
  if (!toggled) fail('features_toggle не записал config.json');

  // 7) features_list
  const fl = await request('tools/call', { name: 'features_list', arguments: {} });
  const feats = fl.structuredContent?.features ?? [];
  console.log('[MCP-SMOKE-FEATURES]: ' + feats.length + ' фич, bundled=' + feats.filter((f) => f.bundled).length);
  if (feats.length < 3) fail('features_list вернул меньше 3 фич');

  // 8) context_pack
  const cp = await request('tools/call', { name: 'context_pack', arguments: {} });
  const md = cp.structuredContent?.markdown ?? '';
  const hasSections = md.includes('## versions') && md.includes('## config') && md.includes('## journal');
  console.log('[MCP-SMOKE-CTX-PACK]: секции ' + (hasSections ? 'на месте' : 'нет'));
  if (!hasSections) fail('context_pack без ожидаемых секций');

  // 9) purge_workspace
  const pw = await request('tools/call', { name: 'purge_workspace', arguments: {} });
  console.log('[MCP-SMOKE-PURGE]: removed=' + pw.structuredContent?.removed);
  if (pw.structuredContent?.ok !== true) fail('purge_workspace не прошёл');

  // финал
  child.kill('SIGTERM');
  rmSync(root, { recursive: true, force: true });
  if (FAILS.length > 0) {
    console.log('MCP-SMOKE: FAIL (' + FAILS.length + ')');
    process.exit(1);
  }
  console.log('MCP-SMOKE: PASS');
  process.exit(0);
}

main().catch((e) => {
  console.error('[MCP-SMOKE] краш: ' + (e instanceof Error ? e.stack : String(e)));
  console.log('MCP-SMOKE: FAIL');
  child.kill('SIGKILL');
  process.exit(1);
});
