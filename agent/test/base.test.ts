// test/base.test.ts — BASE: тесты четырёх модулей надстройки
// (autopilot / supervisor / agp-check / project-memory) + ядра
// (слоты onTaskStart/onTaskDone, cycle в журнале, REVIEW-вердикт beforeRun).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FeatureRegistry,
  setActiveRegistry,
  setServerTaskBridge,
  getServerTaskBridge,
  type FeatureContext,
} from '../src/features/registry.js';
import { executeDoc } from '../src/core/stepEngine.js';
import { _setJournalPathForTest, journalTail } from '../src/core/journal.js';
import { loadConfig } from '../src/config.js';
import { parseTz } from '../src/tz/parser.js';
import * as ptyManager from '../src/core/ptyManager.js';
import type { AgentConfig } from '../src/config.js';

// ---------- FakePty (паттерн test/features.test.ts) ----------
class FakeProc {
  dataCbs: ((data: string) => void)[] = [];
  exitCbs: ((e: { exitCode?: number; signal?: number }) => void)[] = [];
  killed = false;
  onData(cb: (data: string) => void) { this.dataCbs.push(cb); }
  onExit(cb: (e: { exitCode?: number; signal?: number }) => void) { this.exitCbs.push(cb); }
  kill() { this.killed = true; }
  emit(data: string) { for (const cb of this.dataCbs) cb(data); }
  exit(code: number) { for (const cb of this.exitCbs) cb({ exitCode: code }); }
}
function makeFakePty(outputs: { match: string; data: string; exit: number }[]) {
  return {
    spawn: vi.fn((file: string, args: string[], opts: any) => {
      const proc = new FakeProc();
      const script = args[args.length - 1] ?? '';
      const match = outputs.find((o) => script.includes(o.match));
      setTimeout(() => {
        if (proc.killed) return;
        if (match?.data) proc.emit(match.data);
        proc.exit(match?.exit ?? 0);
      }, 1);
      return proc as unknown as FakeProc;
    }),
  } as unknown as typeof import('@lydell/node-pty');
}

const originalPty = (ptyManager as any).ptyImpl;

// ---------- Хелперы ----------
let tmp: string;
let featuresDir: string;
let wsRoot: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'base-'));
  featuresDir = join(tmp, 'features');
  wsRoot = join(tmp, 'ws');
  mkdirSync(featuresDir, { recursive: true });
  mkdirSync(wsRoot, { recursive: true });
  _setJournalPathForTest(join(tmp, 'journal.jsonl'));
});

afterEach(() => {
  setActiveRegistry(null);
  setServerTaskBridge(null);
  ptyManager.injectPtyImpl(originalPty);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
  _setJournalPathForTest(null);
});

function makeCtx(features: Record<string, boolean>, extra: Partial<FeatureContext> = {}): FeatureContext {
  return {
    coreVersion: '1.1.0',
    config: { features, workspaceRoot: wsRoot },
    log: () => {},
    registerRoute: () => {},
    gitStatus: async () => '(тест)',
    journalTail: async () => [],
    versions: () => ({ core: '1.1.0' }),
    ...extra,
  };
}

const TZ_ECHO = (cycle = 2) => `# ЗАДАЧ: Base echo
# META
workdir: new:base-ws
mode: auto
on_fail: stop
cycle: ${cycle}

## ШАГ 1. эхо
RUN shell: bash
\`\`\`bash
echo base-e2e
\`\`\`
EXPECT exit=0
`;

async function runDoc(
  tz: string,
  features: Record<string, boolean>,
  cbOverrides: Record<string, any> = {},
) {
  const registry = new FeatureRegistry(featuresDir, '1.1.0');
  await registry.scanFeatures();
  registry.loadEnabled(features, makeCtx(features));
  setActiveRegistry(registry);
  ptyManager.injectPtyImpl(makeFakePty([{ match: 'echo base-e2e', data: 'base-e2e\n', exit: 0 }]));
  const cfg: AgentConfig = {
    port: 8787,
    workspaceRoot: wsRoot,
    shells: {
      pwsh: { cmd: '/nonexistent/pwsh', args: [] },
      bash: { cmd: '/nonexistent/bash', args: [] },
      pwshFallback: { cmd: 'powershell.exe', args: [] },
      linuxBash: { cmd: '/bin/bash', args: ['-c'] },
    },
    stepTimeoutSec: 5,
    maxOutputBytes: 1048576,
    deny: [],
    features,
  };
  const parsed = parseTz(tz);
  expect(parsed.ok).toBe(true);
  const result = await executeDoc(parsed.doc!, cfg, 't' + Date.now(), {
    onStepStatus: () => {},
    onPtyData: () => {},
    onNote: () => {},
    ...cbOverrides,
  }, { stopped: false }, join(tmp, 'logs'));
  return result;
}

// fake req/res для route-обработчиков фич
function fakeReq(url: string, body?: unknown): any {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  return {
    url,
    [Symbol.asyncIterator]: async function* () {
      for (const b of chunks) yield b;
    },
  };
}
function fakeRes(): any {
  return {
    code: 0,
    body: '',
    ctype: '',
    writeHead(c: number, h?: Record<string, string>) {
      this.code = c;
      this.ctype = h?.['content-type'] ?? '';
    },
    end(b?: unknown) {
      if (b !== undefined) this.body = String(b);
    },
  };
}

// ---------- 1. Ядро: слоты жизненного цикла задачи ----------

describe('BASE ядро: onTaskStart/onTaskDone + cycle в журнале', () => {
  it('слоты получают workspace, meta и финальный статус', async () => {
    const seen: { start?: any; done?: any } = {};
    writeFileSync(
      join(featuresDir, 'watcher.feature.js'),
      `export const manifest = { name: 'watcher', title: 't', description: 'd', version: '1.0.0', slot: ['onTaskStart', 'onTaskDone'], dependencies: [], minCore: '0.0.1' };
export function create(ctx) {
  const w = () => (globalThis.__watcher = globalThis.__watcher ?? {});
  return {
    onTaskStart(info) { w().start = JSON.parse(JSON.stringify(info)); },
    onTaskDone(info) { w().done = JSON.parse(JSON.stringify(info)); },
  };
}
`,
      'utf8',
    );
    const result = await runDoc(TZ_ECHO(3), { watcher: true });
    expect(result.status).toBe('SUCCESS');
    const w = (globalThis as any).__watcher;
    expect(w.start.taskId).toMatch(/^t\d+$/);
    expect(w.start.title).toBe('Base echo');
    expect(w.start.workspace.startsWith(wsRoot)).toBe(true);
    expect(w.start.meta.cycle).toBe(3);
    expect(w.start.meta.workdir).toBe('new:base-ws');
    expect(w.done.status).toBe('SUCCESS');
    expect(w.done.meta.cycle).toBe(3);
    expect(w.done.results[0].status).toBe('ok');
    delete (globalThis as any).__watcher;
  });

  it('каждая запись журнала несёт cycle из META (проброс doc.meta.cycle)', async () => {
    await runDoc(TZ_ECHO(2), {});
    const entries = journalTail(100) as any[];
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.every((e) => e.cycle === 2)).toBe(true);
  });

  it('без реестра executeDoc работает как раньше (но-оп слоты)', async () => {
    const result = await runDoc(TZ_ECHO(1), {});
    expect(result.status).toBe('SUCCESS');
  });
});

// ---------- 2. Ядро: REVIEW-вердикт beforeRun ----------

describe('BASE ядро: REVIEW-вердикт (confirm) фичи beforeRun', () => {
  const CONFIRMER = `export const manifest = { name: 'confirmer', title: 't', description: 'd', version: '1.0.0', slot: ['beforeRun'], dependencies: [], minCore: '0.0.1' };
export function create(ctx) {
  return {
    beforeRun(i, d) {
      if (d.kind === 'RUN') {
        return { confirm: { kind: 'RUN', preview: d.script.split('\\n')[0] }, reason: 'confirmer: REVIEW-тест' };
      }
      return undefined;
    },
  };
}
`;

  it('оператор одобрил REVIEW → директива исполнена', async () => {
    writeFileSync(join(featuresDir, 'confirmer.feature.js'), CONFIRMER, 'utf8');
    const asks: any[] = [];
    const result = await runDoc(TZ_ECHO(1), { confirmer: true }, {
      onNeedConfirm: async (i: number, kind: string, preview: string) => {
        asks.push({ i, kind, preview });
        return true;
      },
    });
    expect(asks.length).toBe(1);
    expect(asks[0].kind).toBe('RUN');
    expect(asks[0].preview).toBe('echo base-e2e');
    expect(result.results[0].status).toBe('ok');
    expect(result.results[0].outputTail).toContain('base-e2e');
  });

  it('оператор отклонил REVIEW → SKIP(фича), директива не исполнена', async () => {
    writeFileSync(join(featuresDir, 'confirmer.feature.js'), CONFIRMER, 'utf8');
    const result = await runDoc(TZ_ECHO(1), { confirmer: true }, {
      onNeedConfirm: async () => false,
    });
    expect(result.results[0].status).toBe('skip');
    expect(result.results[0].notes?.some((n) => n.includes('SKIP(фича)') && n.includes('оператор отклонил'))).toBe(true);
    expect(result.results[0].outputTail).toBeUndefined();
  });

  it('нет confirm-канала (onNeedConfirm) → fail-closed: skip', async () => {
    writeFileSync(join(featuresDir, 'confirmer.feature.js'), CONFIRMER, 'utf8');
    const result = await runDoc(TZ_ECHO(1), { confirmer: true });
    expect(result.results[0].status).toBe('skip');
    expect(result.results[0].notes?.some((n) => n.includes('REVIEW'))).toBe(true);
  });
});

// ---------- 3. agp-check ----------

import { create as createAgpCheck } from '../features/agp-check.feature.js';

describe('BASE agp-check: ALLOW/DENY/REVIEW/fail-closed/notify', () => {
  const fetchCalls: { url: string; body: any }[] = [];

  function stubFetch(decisionFor: (preview: string) => { decision: string; reason?: string } | null) {
    fetchCalls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
      const body = JSON.parse(init?.body ?? '{}');
      fetchCalls.push({ url: String(url), body });
      if (String(url).endsWith('/agent/check-operation')) {
        const d = decisionFor(body.preview ?? '');
        if (!d) throw new Error('unexpected preview: ' + body.preview);
        // Форма ответа AGP-шлюза: GovernanceDecision + eventId_used (см. agp-mvp outcomeBody)
        return new Response(JSON.stringify({
          eventId: 'ev-' + fetchCalls.length,
          decision: d.decision,
          reason: d.reason ?? '',
          ts: '',
          eventId_used: 'ev-' + fetchCalls.length,
        }), { status: 200 });
      }
      if (String(url).endsWith('/agent/notify')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }));
  }

  function mkCtx(on: boolean): any {
    return makeCtx({ 'agp-check': on }, {
      config: {
        features: { 'agp-check': on },
        workspaceRoot: wsRoot,
        agp: { gatewayUrl: 'http://agp.test:8790', agentId: 'test-agent', timeoutMs: 300 },
      },
    });
  }

  it('ALLOW → директива не тронута; afterRun шлёт RESULT success с eventId', async () => {
    stubFetch(() => ({ decision: 'ALLOW' }));
    const h = createAgpCheck(mkCtx(true));
    const verdict = await h.beforeRun(1, { kind: 'RUN', script: 'echo allow-me', expects: [] });
    expect(verdict).toBeUndefined();
    await h.afterRun(1, { taskId: 't1', i: 1, kind: 'RUN', status: 'ok', cmd: 'echo allow-me', durationMs: 12 });
    const notify = fetchCalls.find((c) => c.url.endsWith('/agent/notify'));
    expect(notify).toBeTruthy();
    expect(notify!.body.result).toBe('success');
    expect(String(notify!.body.eventId)).toMatch(/^ev-\d+$/);
    expect(notify!.body.durationMs).toBe(12);
  });

  it('DENY → skip с причиной от AGP, notify нет', async () => {
    stubFetch(() => ({ decision: 'DENY', reason: 'selftest: ops-run-001' }));
    const h = createAgpCheck(mkCtx(true));
    const verdict = await h.beforeRun(1, { kind: 'RUN', script: 'echo deny-me', expects: [] });
    expect(verdict?.skip).toBe(true);
    expect(verdict?.reason).toContain('DENY');
    expect(verdict?.reason).toContain('ops-run-001');
    await h.afterRun(1, { taskId: 't1', i: 1, kind: 'RUN', status: 'ok', cmd: 'echo deny-me', durationMs: 0 });
    expect(fetchCalls.find((c) => c.url.endsWith('/agent/notify'))).toBeUndefined();
  });

  it('REVIEW → confirm-вердикт с preview; после одобрения и afterRun — RESULT', async () => {
    stubFetch(() => ({ decision: 'REVIEW', reason: 'требуется оператор' }));
    const h = createAgpCheck(mkCtx(true));
    const verdict = await h.beforeRun(2, { kind: 'RUN', script: 'echo review-me', expects: [] });
    expect(verdict?.confirm?.kind).toBe('RUN');
    expect(verdict?.confirm?.preview).toBe('echo review-me');
    expect(verdict?.reason).toContain('REVIEW');
    await h.afterRun(2, { taskId: 't1', i: 2, kind: 'RUN', status: 'fail', cmd: 'echo review-me', durationMs: 5 });
    const notify = fetchCalls.find((c) => c.url.endsWith('/agent/notify'));
    expect(notify!.body.result).toBe('fail');
  });

  it('WRITE → operation=write + targetPath; ключ послеRun по cmd "WRITE <path>"', async () => {
    stubFetch(() => ({ decision: 'ALLOW' }));
    const h = createAgpCheck(mkCtx(true));
    const verdict = await h.beforeRun(1, { kind: 'WRITE', path: 'src/a.txt', content: 'hello\nworld', expects: [] });
    expect(verdict).toBeUndefined();
    const check = fetchCalls.find((c) => c.url.endsWith('/agent/check-operation'));
    expect(check!.body.operation).toBe('write');
    expect(check!.body.targetPath).toBe('src/a.txt');
    expect(check!.body.preview).toBe('hello');
    expect(check!.body.agentId).toBe('test-agent');
    await h.afterRun(1, { taskId: 't1', i: 1, kind: 'WRITE', status: 'ok', cmd: 'WRITE src/a.txt', durationMs: 1 });
    expect(fetchCalls.find((c) => c.url.endsWith('/agent/notify'))).toBeTruthy();
  });

  it('шлюз недоступен → fail-closed skip', async () => {
    fetchCalls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const h = createAgpCheck(mkCtx(true));
    const verdict = await h.beforeRun(1, { kind: 'RUN', script: 'echo x', expects: [] });
    expect(verdict?.skip).toBe(true);
    expect(verdict?.reason).toContain('fail-closed');
  });

  it('агп-check выключен (живой флаг) → вмешательства нет, fetch не вызван', async () => {
    stubFetch(() => ({ decision: 'DENY' }));
    const h = createAgpCheck(mkCtx(false));
    const verdict = await h.beforeRun(1, { kind: 'RUN', script: 'echo deny-me', expects: [] });
    expect(verdict).toBeUndefined();
    expect(fetchCalls.length).toBe(0);
  });

  it('GIT и прочие директивы не перехватываются', async () => {
    stubFetch(() => ({ decision: 'DENY' }));
    const h = createAgpCheck(mkCtx(true));
    expect(await h.beforeRun(1, { kind: 'GIT', msg: 'x' })).toBeUndefined();
    expect(fetchCalls.length).toBe(0);
  });
});

// ---------- 4. supervisor ----------

import { create as createSupervisor } from '../features/supervisor.feature.js';

describe('BASE supervisor: FAIL-серии, обороты без SUCCESS, маршруты', () => {
  function mkSupervisor(thresholds?: { maxSameFails?: number; maxTurnsNoSuccess?: number }) {
    const logs: string[] = [];
    const routes: Record<string, any> = {};
    const ctx: any = makeCtx({ supervisor: true }, {
      config: {
        features: { supervisor: true },
        workspaceRoot: wsRoot,
        supervisor: { maxSameFails: thresholds?.maxSameFails ?? 3, maxTurnsNoSuccess: thresholds?.maxTurnsNoSuccess ?? 5 },
      },
      log: (level: any, msg: string) => logs.push(msg),
      registerRoute: (_m: string, path: string, handler: any) => { routes[path] = handler; },
    });
    const h = createSupervisor(ctx);
    return { h, logs, routes };
  }

  it('3 одинаковых FAIL подряд → уведомление «FAIL подряд … нужны указания»', () => {
    const { h, logs } = mkSupervisor();
    for (let i = 1; i <= 3; i++) {
      h.onFail(i, 'EXPECT не совпал (exit=1)', { taskId: 't1', i, kind: 'RUN' });
    }
    const hit = logs.find((l) => l.includes('3 FAIL подряд') && l.includes('нужны указания'));
    expect(hit).toBeTruthy();
    // 4-й тот же FAIL — новое уведомление не спамится (счётчик 4 ≠ порогу 3)
    const before = logs.length;
    h.onFail(4, 'EXPECT не совпал (exit=1)', { taskId: 't1', i: 4, kind: 'RUN' });
    expect(logs.length).toBe(before);
  });

  it('другая сигнатура сбрасывает серию; успешный шаг сбрасывает', () => {
    const { h, logs } = mkSupervisor();
    h.onFail(1, 'boom-A', { taskId: 't1', i: 1, kind: 'RUN' });
    h.onFail(2, 'boom-A', { taskId: 't1', i: 2, kind: 'RUN' });
    h.onFail(3, 'boom-B', { taskId: 't1', i: 3, kind: 'RUN' }); // сброс
    h.onFail(4, 'boom-B', { taskId: 't1', i: 4, kind: 'RUN' });
    expect(logs.find((l) => l.includes('FAIL подряд'))).toBeUndefined();
    h.afterRun(5, { taskId: 't1', i: 5, kind: 'RUN', status: 'ok' });
    h.onFail(6, 'boom-C', { taskId: 't1', i: 6, kind: 'RUN' });
    h.onFail(7, 'boom-C', { taskId: 't1', i: 7, kind: 'RUN' });
    expect(logs.find((l) => l.includes('FAIL подряд'))).toBeUndefined();
  });

  it('порог оборотов без SUCCESS (per-workdir); SUCCESS сбрасывает', () => {
    const { h, logs } = mkSupervisor({ maxTurnsNoSuccess: 2 });
    const done = (taskId: string, status: any) =>
      h.onTaskDone({ taskId, title: 'T', status, workspace: join(wsRoot, 'proj-a'), meta: { workdir: 'proj-a', mode: 'auto', on_fail: 'stop', cycle: 1 }, results: [], notes: [] });
    done('t1', 'PARTIAL');
    done('t2', 'PARTIAL');
    expect(logs.find((l) => l.includes('2 оборотов подряд без SUCCESS'))).toBeTruthy();
    done('t3', 'SUCCESS'); // сброс
    done('t4', 'PARTIAL');
    const hits = logs.filter((l) => l.includes('оборотов подряд без SUCCESS')).length;
    expect(hits).toBe(1);
  });

  it('маршруты: notifications с since + intervention', async () => {
    const { h, routes } = mkSupervisor();
    // пороговая серия — только она кладёт уведомление в очередь
    for (let i = 1; i <= 3; i++) h.onFail(i, 'EXPECT не совпал (exit=1)', { taskId: 't1', i, kind: 'RUN' });

    const res1 = fakeRes();
    await routes['/features/supervisor/notifications'](fakeReq('/features/supervisor/notifications?since=0'), res1);
    const all = JSON.parse(res1.body);
    expect(all.ok).toBe(true);
    expect(all.notifications.length).toBeGreaterThanOrEqual(1);
    expect(all.lastId).toBeGreaterThan(0);

    const res2 = fakeRes();
    await routes['/features/supervisor/notifications'](fakeReq('/features/supervisor/notifications?since=' + all.lastId), res2);
    expect(JSON.parse(res2.body).notifications.length).toBe(0);

    const res3 = fakeRes();
    await routes['/features/supervisor/intervention'](fakeReq('/features/supervisor/intervention', { reason: '3 FAIL подряд на ШАГ 2 — нужны указания' }), res3);
    expect(res3.code).toBe(200);
    const res4 = fakeRes();
    await routes['/features/supervisor/notifications'](fakeReq('/features/supervisor/notifications?since=0'), res4);
    const all2 = JSON.parse(res4.body);
    expect(all2.notifications.find((n: any) => n.kind === 'intervention' && n.text.includes('Автопилот остановлен'))).toBeTruthy();
  });
});

// ---------- 5. project-memory ----------

import { create as createProjectMemory } from '../features/project-memory.feature.js';

describe('BASE project-memory: CONTEXT.md + projects.json + маршруты', () => {
  function mkMemory(dataDir: string | null) {
    const logs: string[] = [];
    const routes: Record<string, any> = {};
    const ctx: any = makeCtx({ 'project-memory': true }, {
      config: { features: { 'project-memory': true }, workspaceRoot: wsRoot },
      dataDir,
      log: (_l: any, msg: string) => logs.push(msg),
      registerRoute: (_m: string, path: string, handler: any) => { routes[path] = handler; },
    });
    const h = createProjectMemory(ctx);
    return { h, logs, routes };
  }
  const doneInfo = (status: any, cycle = 2) => ({
    taskId: 'task_1',
    title: 'Проект Альфа',
    status,
    workspace: join(wsRoot, 'proj-a'),
    meta: { workdir: 'proj-a', mode: 'auto', on_fail: 'stop', cycle },
    results: [
      { i: 1, title: 'эхо', status: 'ok' as const, durationMs: 10 },
      { i: 2, title: 'плохой', status: 'fail' as const, durationMs: 20, failReason: 'EXPECT не совпал (exit=1)' },
    ],
    notes: ['META-движка: …'],
  });

  it('onTaskStart: существующий CONTEXT.md показан оператору ([MEMORY] в логе)', () => {
    mkdirSync(join(wsRoot, 'proj-a'), { recursive: true });
    writeFileSync(join(wsRoot, 'proj-a', 'CONTEXT.md'), '# CONTEXT: прошлый раз\n- статус: PARTIAL\n', 'utf8');
    const { h, logs } = mkMemory(join(tmp, 'data'));
    h.onTaskStart({ taskId: 'task_1', title: 'Проект Альфа', workspace: join(wsRoot, 'proj-a'), meta: { workdir: 'proj-a', mode: 'auto', on_fail: 'stop', cycle: 2 } });
    const hit = logs.find((l) => l.includes('[MEMORY] Найден CONTEXT.md') && l.includes('прошлый раз'));
    expect(hit).toBeTruthy();
  });

  it('onTaskDone: пишет CONTEXT.md (статус/цикл/шаги) и обновляет projects.json', () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(join(wsRoot, 'proj-a'), { recursive: true });
    const { h, logs } = mkMemory(dataDir);
    h.onTaskDone(doneInfo('PARTIAL', 2));
    const md = readFileSync(join(wsRoot, 'proj-a', 'CONTEXT.md'), 'utf8');
    expect(md).toContain('# CONTEXT: Проект Альфа');
    expect(md).toContain('- Статус: PARTIAL');
    expect(md).toContain('- Цикл: 2');
    expect(md).toContain('ok=1 fail=1');
    const map = JSON.parse(readFileSync(join(dataDir, 'memory', 'projects.json'), 'utf8'));
    expect(map['proj-a'].lastStatus).toBe('PARTIAL');
    expect(map['proj-a'].lastCycle).toBe(2);
    expect(map['proj-a'].runs).toBe(1);
    expect(map['proj-a'].summary).toContain('EXPECT не совпал');
    expect(logs.find((l) => l.includes('CONTEXT.md обновлён'))).toBeTruthy();
  });

  it('маршруты: projects.json + context?workdir', () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(join(wsRoot, 'proj-b'), { recursive: true });
    const { h, routes } = mkMemory(dataDir);
    // onTaskDone ПЕРЕЗАПИСЫВАЕТ CONTEXT.md (авто-генерация) — поэтому ждём заголовок с title
    h.onTaskDone({ ...doneInfo('SUCCESS', 1), workspace: join(wsRoot, 'proj-b'), meta: { workdir: 'proj-b', mode: 'auto', on_fail: 'stop', cycle: 1 } });

    const r1 = fakeRes();
    routes['/features/project-memory/projects'](fakeReq('/features/project-memory/projects'), r1);
    const projects = JSON.parse(r1.body);
    expect(projects.ok).toBe(true);
    expect(projects.projects['proj-b'].lastStatus).toBe('SUCCESS');

    const r2 = fakeRes();
    routes['/features/project-memory/context'](fakeReq('/features/project-memory/context?workdir=proj-b'), r2);
    expect(r2.code).toBe(200);
    expect(r2.body).toContain('# CONTEXT: Проект Альфа');

    const r3 = fakeRes();
    routes['/features/project-memory/context'](fakeReq('/features/project-memory/context?workdir=нету'), r3);
    expect(r3.code).toBe(404);
  });

  it('без dataDir фича не падает (projects.json пропускается)', () => {
    const { h } = mkMemory(null);
    expect(() => h.onTaskDone(doneInfo('SUCCESS', 1))).not.toThrow();
  });
});

// ---------- 6. autopilot ----------

import { create as createAutopilot } from '../features/autopilot.feature.js';

describe('BASE autopilot: POST /features/autopilot/start + status', () => {
  function mkAutopilot(opts: { active: boolean; busy?: boolean; ok?: boolean }) {
    const routes: Record<string, any> = {};
    const startTask = vi.fn(async (tzText: string) =>
      opts.ok === false ? { ok: false, error: 'parse errors' } : { ok: true, taskId: 'task_777' });
    const ctx: any = makeCtx({ autopilot: true, 'autopilot-active': opts.active }, {
      config: { features: { autopilot: true, 'autopilot-active': opts.active }, workspaceRoot: wsRoot },
      registerRoute: (_m: string, path: string, handler: any) => { routes[path] = handler; },
      serverBridge: () => ({ startTask, isBusy: () => !!opts.busy }),
    });
    const h = createAutopilot(ctx);
    return { h, routes, startTask };
  }

  it('подрежим autopilot-active выключен → 409, startTask не вызван', async () => {
    const { routes, startTask } = mkAutopilot({ active: false });
    const res = fakeRes();
    await routes['/features/autopilot/start'](fakeReq('/features/autopilot/start', { tzText: TZ_ECHO(1) }), res);
    expect(res.code).toBe(409);
    expect(JSON.parse(res.body).active).toBe(false);
    expect(startTask).not.toHaveBeenCalled();
  });

  it('активен → startTask(tzText), 200 c taskId', async () => {
    const { routes, startTask } = mkAutopilot({ active: true });
    const res = fakeRes();
    await routes['/features/autopilot/start'](fakeReq('/features/autopilot/start', { tzText: TZ_ECHO(1) }), res);
    expect(res.code).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, taskId: 'task_777' });
    expect(startTask).toHaveBeenCalledWith(TZ_ECHO(1));
  });

  it('занят (isBusy) → 409 busy', async () => {
    const { routes, startTask } = mkAutopilot({ active: true, busy: true });
    const res = fakeRes();
    await routes['/features/autopilot/start'](fakeReq('/features/autopilot/start', { tzText: TZ_ECHO(1) }), res);
    expect(res.code).toBe(409);
    expect(JSON.parse(res.body).busy).toBe(true);
    expect(startTask).not.toHaveBeenCalled();
  });

  it('пустой tzText → 400; bridge отсутствует → 503; статус-маршрут отдаёт поля', async () => {
    const { h, routes } = mkAutopilot({ active: true });
    const r1 = fakeRes();
    await routes['/features/autopilot/start'](fakeReq('/features/autopilot/start', { tzText: '   ' }), r1);
    expect(r1.code).toBe(400);

    const ctxNoBridge: any = makeCtx({}, {
      config: { features: { 'autopilot-active': true }, workspaceRoot: wsRoot },
      registerRoute: (_m: string, p: string, hh: any) => { routes[p + '#nobridge'] = hh; },
      serverBridge: () => null,
    });
    createAutopilot(ctxNoBridge);
    const r2 = fakeRes();
    await routes['/features/autopilot/start#nobridge'](fakeReq('/features/autopilot/start', { tzText: TZ_ECHO(1) }), r2);
    expect(r2.code).toBe(503);

    const r3 = fakeRes();
    await routes['/features/autopilot/status'](fakeReq('/features/autopilot/status'), r3);
    const s = JSON.parse(r3.body);
    expect(s.ok).toBe(true);
    expect(s.featureEnabled).toBe(true);
    expect(s.active).toBe(true);
    expect(typeof s.busy).toBe('boolean');
    expect(h).toBeTruthy();
  });
});

// ---------- 7. config + ServerTaskBridge ----------

describe('BASE config: agp/supervisor/дефолты features; ServerTaskBridge', () => {
  it('loadConfig мягко мержит новые секции в старый конфиг', () => {
    const p = join(tmp, 'config.json');
    writeFileSync(p, JSON.stringify({
      port: 8999,
      features: { reflect: true, 'dry-run': false },
    }), 'utf8');
    const cfg = loadConfig(p);
    expect(cfg.port).toBe(8999);
    expect(cfg.features?.['dry-run']).toBe(false); // пользовательское значение сохранено
    expect(cfg.features?.supervisor).toBe(true);   // дефолты Base появились
    expect(cfg.features?.['agp-check']).toBe(true);
    expect(cfg.features?.['project-memory']).toBe(true);
    expect(cfg.features?.autopilot).toBe(false);
    expect(cfg.features?.['autopilot-active']).toBe(false);
    expect(cfg.agp?.gatewayUrl).toBe('http://127.0.0.1:8790');
    expect(cfg.agp?.agentId).toBe('super_handai_z_light');
    expect(cfg.supervisor?.maxSameFails).toBe(3);
    expect(cfg.supervisor?.maxTurnsNoSuccess).toBe(5);
  });

  it('пользовательские agp/supervisor не затираются дефолтами', () => {
    const p = join(tmp, 'config2.json');
    writeFileSync(p, JSON.stringify({ agp: { gatewayUrl: 'http://127.0.0.1:9999' }, supervisor: { maxSameFails: 7 } }), 'utf8');
    const cfg = loadConfig(p);
    expect(cfg.agp?.gatewayUrl).toBe('http://127.0.0.1:9999');
    expect(cfg.agp?.agentId).toBe('super_handai_z_light'); // остальное из дефолта
    expect(cfg.supervisor?.maxSameFails).toBe(7);
    expect(cfg.supervisor?.maxTurnsNoSuccess).toBe(5);
  });

  it('setServerTaskBridge/getServerTaskBridge — поздняя привязка и очистка', () => {
    expect(getServerTaskBridge()).toBeNull();
    const bridge = { startTask: async () => ({ ok: true }), isBusy: () => false };
    setServerTaskBridge(bridge);
    expect(getServerTaskBridge()).toBe(bridge);
    setServerTaskBridge(null);
    expect(getServerTaskBridge()).toBeNull();
  });
});

// ---------- 8. e2e-слоёная проверка: agp-check через executeDoc ----------

describe('BASE e2e: agp-check как фича движка (FakePty, полный конвейер)', () => {
  it('DENY-шаг пропущен, ALLOW-шаг исполнен, REVIEW одобрен оператором, journal с agp-заметками', async () => {
    // фича из папки features проекта подтягивается реестром
    const registry = new FeatureRegistry(
      join(process.cwd(), 'features'),
      '1.1.0',
    );
    await registry.scanFeatures();
    const features = { 'agp-check': true };
    registry.loadEnabled(features, {
      coreVersion: '1.1.0',
      config: {
        features,
        workspaceRoot: wsRoot,
        agp: { gatewayUrl: 'http://agp.test:8790', agentId: 'test-agent', timeoutMs: 300 },
      },
      log: () => {},
      registerRoute: () => {},
      gitStatus: async () => '',
      journalTail: async () => [],
      versions: () => ({}),
    } as FeatureContext);
    setActiveRegistry(registry);

    const checkCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
      const body = JSON.parse(init?.body ?? '{}');
      if (String(url).endsWith('/agent/check-operation')) {
        checkCalls.push(body.preview);
        const decision = body.preview.includes('deny-me')
          ? 'DENY'
          : body.preview.includes('review-me')
            ? 'REVIEW'
            : 'ALLOW';
        return new Response(JSON.stringify({ eventId: 'ev-' + (checkCalls.length), decision, reason: 'e2e', ts: '' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    ptyManager.injectPtyImpl(makeFakePty([
      { match: 'echo review-me', data: 'review-me\n', exit: 0 },
      { match: 'echo allow-me', data: 'allow-me\n', exit: 0 },
    ]));
    const cfg: AgentConfig = {
      port: 8787,
      workspaceRoot: wsRoot,
      shells: {
        pwsh: { cmd: '/nonexistent/pwsh', args: [] },
        bash: { cmd: '/nonexistent/bash', args: [] },
        pwshFallback: { cmd: 'powershell.exe', args: [] },
        linuxBash: { cmd: '/bin/bash', args: ['-c'] },
      },
      stepTimeoutSec: 5,
      maxOutputBytes: 1048576,
      deny: [],
      features,
    };
    const tz = `# ЗАДАЧ: AGP e2e
# META
workdir: new:agp-ws
mode: auto
on_fail: continue
cycle: 1

## ШАГ 1. deny
RUN shell: bash
\`\`\`bash
echo deny-me
\`\`\`
EXPECT exit=0

## ШАГ 2. review
RUN shell: bash
\`\`\`bash
echo review-me
\`\`\`
EXPECT exit=0

## ШАГ 3. allow
RUN shell: bash
\`\`\`bash
echo allow-me
\`\`\`
EXPECT exit=0
`;
    const confirms: any[] = [];
    const parsed = parseTz(tz);
    expect(parsed.ok).toBe(true);
    const result = await executeDoc(parsed.doc!, cfg, 't' + Date.now(), {
      onStepStatus: () => {},
      onPtyData: () => {},
      onNote: () => {},
      onNeedConfirm: async (i, kind, preview) => {
        confirms.push({ i, kind, preview });
        return true;
      },
    }, { stopped: false }, join(tmp, 'logs'));

    expect(result.status).toBe('SUCCESS');
    expect(result.results[0].status).toBe('skip'); // DENY → skip
    expect(result.results[0].notes?.some((n) => n.includes('agp: DENY'))).toBe(true);
    expect(confirms.length).toBe(1); // REVIEW → confirm оператору
    expect(confirms[0].preview).toBe('echo review-me');
    expect(result.results[1].status).toBe('ok'); // одобрен и исполнен
    expect(result.results[2].status).toBe('ok'); // ALLOW исполнен
    const entries = journalTail(100) as any[];
    expect(entries.some((e) => e.note?.includes('agp: DENY') && e.cycle === 1)).toBe(true);
  });
});
