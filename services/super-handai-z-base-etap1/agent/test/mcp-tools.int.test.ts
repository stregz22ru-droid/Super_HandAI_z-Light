// test/mcp-tools.int.test.ts — ЭТАП 1, МОДУЛЬ 1: интеграция MCP-сервера
// (тот же buildMcpServer, что и в stdio-входе) над InMemoryTransport:
// tools/list с аннотациями, run_tz (async taskId → get_status → task.done),
// единый выделитель (двойная активность невозможна), features_toggle,
// context_pack, purge_workspace, confirm → SKIP.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../src/mcp-server.js';
import { TaskHub } from '../src/core/taskHub.js';
import { FeatureRegistry, setActiveRegistry } from '../src/features/registry.js';
import type { AgentConfig } from '../src/config.js';

let tmp: string;
let client: Client;

// ТЗ: один RUN-шаг через /bin/bash (реальный pty, как в e2e)
const TZ_ECHO = `\`\`\`tz
# ЗАДАЧ: MCP смоук
# META
workdir: new:mcp-ws
mode: auto
on_fail: stop

## ШАГ 1. Эхо
RUN shell: bash
\`\`\`bash
echo mcp-echo-ok
\`\`\`
EXPECT exit=0
EXPECT stdout contains:mcp-echo-ok
\`\`\``;

const TZ_CONFIRM = `# ЗАДАЧ: MCP confirm
# META
workdir: new:mcp-conf
mode: confirm
on_fail: stop

## ШАГ 1. Подтверди
RUN shell: bash
\`\`\`bash
echo не-должно-исполниться
\`\`\`
EXPECT exit=0
`;

async function boot(overrides?: { workspaceRoot?: string }): Promise<{ hub: TaskHub; workspaceRoot: string; cfgPath: string; tmp: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'shz-mcp-'));
  const workspaceRoot = overrides?.workspaceRoot ?? join(tmp, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  const cfgPath = join(tmp, 'data', 'state', 'config.json');
  mkdirSync(join(tmp, 'data', 'state'), { recursive: true });
  const cfg: AgentConfig = {
    port: 0,
    workspaceRoot,
    shells: {
      pwsh: { cmd: '/nonexistent/pwsh', args: [] },
      bash: { cmd: '/nonexistent/bash', args: [] },
      pwshFallback: { cmd: 'powershell.exe', args: [] },
      linuxBash: { cmd: '/bin/bash', args: ['-c'] },
    },
    stepTimeoutSec: 20,
    maxOutputBytes: 1048576,
    deny: [],
    features: { reflect: true, 'dry-run': true, 'context-pack': true },
  } as AgentConfig;

  // реестр с bundled-фичами из репо (create() context-pack регистрирует route — но-оп)
  const featuresDir = join(process.cwd(), 'features');
  const registry = new FeatureRegistry(featuresDir, '1.0.0');
  await registry.scanFeatures();
  registry.loadEnabled(cfg.features!, {
    coreVersion: '1.0.0',
    config: cfg as any,
    session: (await import('../src/features/registry.js')).getSessionState(),
    log: () => {},
    registerRoute: () => {},
    gitStatus: async () => '(тест)',
    journalTail: async () => [],
    versions: () => ({ core: '1.0.0' }),
  });
  setActiveRegistry(registry);

  const hub = new TaskHub({ owner: 'mcp', stateDir: join(tmp, 'data', 'state') });
  const server = buildMcpServer({
    coreVersion: '1.0.0',
    cfg,
    registry,
    hub,
    hooksDir: join(tmp, 'hooks'),
    reportsDir: join(tmp, 'data', 'reports'),
    logDir: join(tmp, 'data', 'logs'),
    cfgPath,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'vitest', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { hub, workspaceRoot, cfgPath, tmp };
}

afterEach(async () => {
  setActiveRegistry(null);
  await client?.close().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
});

describe('МОДУЛЬ 1 — MCP-экспозиция (InMemory, тот же buildMcpServer)', () => {
  beforeEach(() => {}); // boot вызывается вручную в каждом тесте

  it('tools/list: ровно 6 tools с аннотациями readOnlyHint', async () => {
    await boot();
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name).sort();
    expect(names).toEqual(['context_pack', 'features_list', 'features_toggle', 'get_status', 'purge_workspace', 'run_tz']);
    const byName = Object.fromEntries(res.tools.map((t) => [t.name, t]));
    expect(byName.run_tz.annotations?.readOnlyHint).toBe(false);
    expect(byName.get_status.annotations?.readOnlyHint).toBe(true);
    expect(byName.features_list.annotations?.readOnlyHint).toBe(true);
    expect(byName.features_toggle.annotations?.readOnlyHint).toBe(false);
    expect(byName.context_pack.annotations?.readOnlyHint).toBe(true);
    expect(byName.purge_workspace.annotations?.readOnlyHint).toBe(false);
    expect(byName.purge_workspace.annotations?.destructiveHint).toBe(true);
  });

  it('run_tz: parse-ошибка → isError сразу, taskId НЕ создаётся', async () => {
    await boot();
    const res: any = await client.callTool({ name: 'run_tz', arguments: { tzText: 'это не ТЗ' } });
    expect(res.isError).toBe(true);
    expect(String(res.content[0].text)).toContain('parse errors');
  });

  it('run_tz: нет workdir → ОТКЛОНЕНО (та же проверка, что HTTP)', async () => {
    await boot();
    const res: any = await client.callTool({ name: 'run_tz', arguments: { tzText: '# ЗАДАЧ: x\n## ШАГ 1. a\nNOTE привет\n' } });
    expect(res.isError).toBe(true);
    expect(String(res.content[0].text)).toContain('ОТКЛОНЕНО');
  });

  it('run_tz → taskId сразу → get_status: RUNNING → SUCCESS (task.done) + отчёт на диске', async () => {
    const { hub, tmp: root } = await boot();
    const res: any = await client.callTool({ name: 'run_tz', arguments: { tzText: TZ_ECHO } });
    expect(res.isError).toBeFalsy();
    const { taskId } = res.structuredContent;
    expect(taskId).toMatch(/^task_/);
    expect(res.structuredContent.status).toBe('RUNNING');

    // ЕДИНЫЙ ВЫДЕЛИТЕЛЬ: пока задача RUNNING, второй run_tz невозможен
    const busy: any = await client.callTool({ name: 'run_tz', arguments: { tzText: TZ_ECHO } });
    expect(busy.isError).toBe(true);
    expect(String(busy.content[0].text)).toContain('task already running');

    // опрос до терминального статуса
    let rec: any = null;
    for (let i = 0; i < 100; i++) {
      const st: any = await client.callTool({ name: 'get_status', arguments: { taskId } });
      rec = st.structuredContent.task;
      if (rec && rec.status !== 'RUNNING') break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(rec?.status).toBe('SUCCESS'); // ← task.done
    expect(rec?.steps[0].status).toBe('ok');
    expect(rec?.additionalContext).toBeDefined();
    expect(rec?.reportPath && existsSync(rec.reportPath)).toBe(true);
    expect(rec?.owner).toBe('mcp');
    // hub освободился
    expect(hub.preflightCheck().ok).toBe(true);
    void root;
  }, 60000);

  it('единый выделитель HTTP↔MCP: задача HTTP-входа блокирует run_tz (кросс-процессный lock)', async () => {
    const { hub } = await boot();
    // другой вход (HTTP) в том же stateDir держит ЖИВУЮ задачу
    const httpHub = new TaskHub({ owner: 'http', stateDir: join(tmp, 'data', 'state') });
    const rec: any = {
      taskId: 'task_http_lock', owner: 'http', pid: process.pid, status: 'RUNNING',
      startedAt: new Date().toISOString(), steps: [], notes: [], additionalContext: [],
    };
    httpHub.begin(rec);
    try {
      const res: any = await client.callTool({ name: 'run_tz', arguments: { tzText: TZ_ECHO } });
      expect(res.isError).toBe(true);
      expect(String(res.content[0].text)).toContain('task_http_lock');
    } finally {
      httpHub.finish(rec);
    }
    expect(hub.preflightCheck().ok).toBe(true);
  });

  it('отмена оператора = SKIP: confirm-задача через MCP — шаг получает skip, статус SUCCESS', async () => {
    await boot();
    const res: any = await client.callTool({ name: 'run_tz', arguments: { tzText: TZ_CONFIRM } });
    const taskId = res.structuredContent.taskId;
    let rec: any = null;
    for (let i = 0; i < 100; i++) {
      const st: any = await client.callTool({ name: 'get_status', arguments: { taskId } });
      rec = st.structuredContent.task;
      if (rec && rec.status !== 'RUNNING') break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(rec?.status).toBe('SUCCESS');
    expect(rec?.steps[0].status).toBe('skip');
    expect((rec?.notes ?? []).join('\n')).toContain('отменён оператором');
  }, 60000);

  it('features_list: bundled-фичи с enabled/loaded/bundled', async () => {
    await boot();
    const res: any = await client.callTool({ name: 'features_list', arguments: {} });
    const feats = res.structuredContent.features;
    const names = feats.map((f: any) => f.name);
    expect(names).toEqual(expect.arrayContaining(['reflect', 'dry-run', 'context-pack']));
    const reflect = feats.find((f: any) => f.name === 'reflect');
    expect(reflect.enabled).toBe(true);
    expect(reflect.loaded).toBe(true);
    expect(reflect.bundled).toBe(true);
    // подрежимы приходят отдельным списком
    const sub = res.structuredContent.submodes.find((s: any) => s.name === 'dry-run-active');
    expect(sub).toBeTruthy();
  });

  it('features_toggle: пишет config.features в config.json (тот же контракт, что POST /features/toggle)', async () => {
    const { cfgPath } = await boot();
    const res: any = await client.callTool({ name: 'features_toggle', arguments: { name: 'reflect', enabled: false } });
    expect(res.structuredContent.ok).toBe(true);
    const onDisk = JSON.parse(readCfg(cfgPath));
    expect(onDisk.features['reflect']).toBe(false);
    // обратно включим
    await client.callTool({ name: 'features_toggle', arguments: { name: 'reflect', enabled: true } });
    expect(JSON.parse(readCfg(cfgPath)).features['reflect']).toBe(true);
  });

  it('context_pack: markdown с секциями versions/config/journal/git status', async () => {
    await boot();
    const res: any = await client.callTool({ name: 'context_pack', arguments: {} });
    const md: string = res.structuredContent.markdown;
    expect(md).toContain('# Context Pack — ');
    expect(md).toContain('## versions');
    expect(md).toContain('## config');
    expect(md).toContain('## journal (последние 20)');
    expect(md).toContain('## git status');
  });

  it('purge_workspace: деструктивен, отклоняется при активной задаче, чистит workspace', async () => {
    const { workspaceRoot } = await boot();
    const hub = new TaskHub({ owner: 'mcp', stateDir: join(tmp, 'data', 'state') });
    writeFileSync(join(workspaceRoot, 'мусор.txt'), 'x', 'utf8');
    // активная задача → отказ
    const rec: any = {
      taskId: 'task_purge_block', owner: 'http', pid: process.pid, status: 'RUNNING',
      startedAt: new Date().toISOString(), steps: [], notes: [], additionalContext: [],
    };
    hub.begin(rec);
    const blocked: any = await client.callTool({ name: 'purge_workspace', arguments: {} });
    expect(blocked.isError).toBe(true);
    hub.finish(rec);
    // свободно → чистит
    const ok: any = await client.callTool({ name: 'purge_workspace', arguments: {} });
    expect(ok.structuredContent.ok).toBe(true);
    expect(ok.structuredContent.removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(workspaceRoot, 'мусор.txt'))).toBe(false);
  });
});

function readCfg(p: string): string {
  return readFileSync(p, 'utf8');
}
