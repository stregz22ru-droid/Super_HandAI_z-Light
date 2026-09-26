// test/base2-check.test.ts — B4: CHECK-директива (кэш, инвалидация, fail-closed,
// вердикты, guard-финальность, журнал решений).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBeforeRunCheck, isDestructive } from '../src/base2/check/directive.js';
import { CheckCache } from '../src/base2/check/cache.js';
import { resetSlotBus, getSlotBus } from '../src/base2/slotBus.js';
import { BusEvents, type ModeChangedEvent } from '../src/base2/types.js';
import { runWithTask } from '../src/base2/currentTask.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config.js';

let dir: string;
let agp: Server;
let agpUrl: string;
let agpCalls: unknown[];
let agpDecision: string;
let agpDelayMs: number;

const CFG = (root: string): AgentConfig => ({
  ...DEFAULT_CONFIG,
  workspaceRoot: join(tmpdir(), 'shai-check-ws'),
  check: { url: agpUrl, timeoutMs: 1500, cacheTtlSec: 60 },
});

function startAgp(): Promise<void> {
  return new Promise((resolveS) => {
    agpCalls = [];
    agpDecision = 'ALLOW';
    agpDelayMs = 0;
    agp = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', async () => {
        agpCalls.push(JSON.parse(body || '{}'));
        if (agpDelayMs > 0) await new Promise((r) => setTimeout(r, agpDelayMs));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, decision: { decision: agpDecision, reason: 'тест-вердикт ' + agpDecision, eventId: 'ev-1' } }));
      });
    });
    agp.listen(0, '127.0.0.1', () => {
      const addr = agp.address() as { port: number };
      agpUrl = `http://127.0.0.1:${addr.port}/agent/check-operation`;
      resolveS();
    });
  });
}

const RUN_DIRECTIVE = { kind: 'RUN', script: 'echo hello-check' };

describe('B4: CHECK-директива', () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'shai-check-'));
    resetSlotBus();
    await startAgp();
  });
  afterEach(() => {
    agp.close();
    resetSlotBus();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeHandle() {
    return createBeforeRunCheck({ cfg: CFG(dir), root: dir, log: () => {} });
  }

  it('ALLOW из AGP: вердикт не мешает исполнению (undefined), решение в журнале', async () => {
    const h = makeHandle();
    const v = await runWithTask({ taskId: 't1', conversationKey: 'k', origin: { type: 'human', agentId: 'bot' }, mode: 'manual' }, () =>
      h.beforeRun(1, RUN_DIRECTIVE),
    );
    expect(v).toBeUndefined();
    expect(agpCalls).toHaveLength(1);
    // origin.agentId передаётся в AGP (статистика per-agent)
    expect(agpCalls[0]).toMatchObject({ agentId: 'bot', operation: 'run' });
    const jf = join(dir, 'data', 'logs', 'check-decisions.jsonl');
    const entry = JSON.parse(readFileSync(jf, 'utf8').trim());
    expect(entry).toMatchObject({ taskId: 't1', agentId: 'bot', verdict: 'ALLOW', source: 'agp' });
    h.dispose();
  });

  it('кэш: повторная команда ходит в cache (AGP не вызывается второй раз)', async () => {
    const h = makeHandle();
    await runWithTask({ taskId: 't1', conversationKey: 'k', origin: { type: 'human', agentId: 'bot' }, mode: 'manual' }, () =>
      h.beforeRun(1, RUN_DIRECTIVE),
    );
    expect(agpCalls).toHaveLength(1);
    await runWithTask({ taskId: 't1', conversationKey: 'k', origin: { type: 'human', agentId: 'bot' }, mode: 'manual' }, () =>
      h.beforeRun(2, RUN_DIRECTIVE),
    );
    expect(agpCalls).toHaveLength(1); // второй вызов из кэша
    const jf = join(dir, 'data', 'logs', 'check-decisions.jsonl');
    const entries = readFileSync(jf, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entries[1].source).toBe('cache');
    h.dispose();
  });

  it('инвалидация кэша при mode.changed', async () => {
    const h = makeHandle();
    await runWithTask({ taskId: 't1', conversationKey: 'k', origin: { type: 'human', agentId: 'bot' }, mode: 'manual' }, () =>
      h.beforeRun(1, RUN_DIRECTIVE),
    );
    expect(agpCalls).toHaveLength(1);
    getSlotBus().emit<ModeChangedEvent>(BusEvents.modeChanged, { agentId: 'bot', from: 'manual', to: 'autopilot', by: 'test', ts: '' });
    await new Promise((r) => setTimeout(r, 50));
    await runWithTask({ taskId: 't2', conversationKey: 'k', origin: { type: 'human', agentId: 'bot' }, mode: 'autopilot' }, () =>
      h.beforeRun(1, RUN_DIRECTIVE),
    );
    expect(agpCalls).toHaveLength(2); // кэш сброшен → снова AGP
    h.dispose();
  });

  it('DENY из AGP → {deny:true} с причиной; попадает в журнал решений', async () => {
    agpDecision = 'DENY';
    const h = makeHandle();
    const v = await runWithTask({ taskId: 't1', conversationKey: 'k', origin: { type: 'human', agentId: 'bot' }, mode: 'manual' }, () =>
      h.beforeRun(1, RUN_DIRECTIVE),
    );
    expect(v?.deny).toBe(true);
    expect(v?.reason).toContain('CHECK DENY');
    h.dispose();
  });

  it('REVIEW из AGP → CONFIRM-семантика: deny с пояснением про mode=confirm', async () => {
    agpDecision = 'REVIEW';
    const h = makeHandle();
    const v = await runWithTask({ taskId: 't1', conversationKey: 'k', origin: { type: 'human', agentId: 'bot' }, mode: 'manual' }, () =>
      h.beforeRun(1, RUN_DIRECTIVE),
    );
    expect(v?.deny).toBe(true);
    expect(v?.reason).toContain('CHECK CONFIRM');
    h.dispose();
  });

  it('бюджет 1.5с: AGP молчит + команда НЕ деструктивна → ALLOW (fail-open), журнальная запись', async () => {
    agpDelayMs = 2500;
    const h = makeHandle();
    const v = await runWithTask({ taskId: 't1', conversationKey: 'k', origin: { type: 'human', agentId: 'bot' }, mode: 'manual' }, () =>
      h.beforeRun(1, RUN_DIRECTIVE),
    );
    expect(v).toBeUndefined();
    const jf = join(dir, 'data', 'logs', 'check-decisions.jsonl');
    const entry = JSON.parse(readFileSync(jf, 'utf8').trim());
    expect(entry.source).toBe('fail-closed');
    expect(entry.verdict).toBe('ALLOW');
    h.dispose();
  }, 10000);

  it('fail-closed для деструктивного класса: AGP молчит + rm -r → DENY', async () => {
    agpDelayMs = 2500;
    const h = makeHandle();
    const v = await runWithTask({ taskId: 't1', conversationKey: 'k', origin: { type: 'human', agentId: 'bot' }, mode: 'manual' }, () =>
      h.beforeRun(1, { kind: 'RUN', script: 'rm -r ./build-output' }),
    );
    expect(v?.deny).toBe(true);
    expect(v?.reason).toContain('fail-closed');
    h.dispose();
  }, 10000);

  it('guard-DENY финален: guard-паттерн не доходит до AGP (CHECK не перегрывает)', async () => {
    const h = makeHandle();
    const v = await runWithTask({ taskId: 't1', conversationKey: 'k', origin: { type: 'human', agentId: 'bot' }, mode: 'manual' }, () =>
      h.beforeRun(1, { kind: 'RUN', script: 'Remove-Item -Recurse -Force C:\\tmp\\x' }),
    );
    expect(agpCalls).toHaveLength(0); // CHECK даже не вызывался
    expect(v).toBeUndefined(); // запрет отдаст guard ниже по потоку
    const jf = join(dir, 'data', 'logs', 'check-decisions.jsonl');
    const entry = JSON.parse(readFileSync(jf, 'utf8').trim());
    expect(entry.source).toBe('guard-final');
    h.dispose();
  });

  it('WRITE/GIT-директивы вне CHECK v1 (нет вердикта, нет вызова AGP)', async () => {
    const h = makeHandle();
    const v = await runWithTask({ taskId: 't1', conversationKey: 'k', origin: { type: 'human', agentId: 'bot' }, mode: 'manual' }, () =>
      h.beforeRun(1, { kind: 'WRITE', path: 'a.txt', content: 'x' }),
    );
    expect(v).toBeUndefined();
    expect(agpCalls).toHaveLength(0);
    h.dispose();
  });

  it('isDestructive: расширенный класс вне guard-паттернов', () => {
    expect(isDestructive('rm -r ./build').destructive).toBe(true);
    expect(isDestructive('git push --force origin main').destructive).toBe(true);
    expect(isDestructive('git reset --hard HEAD~1').destructive).toBe(true);
    expect(isDestructive('del /S /Q temp').destructive).toBe(true);
    expect(isDestructive('echo безопасно').destructive).toBe(false);
  });
});

describe('B4: CheckCache', () => {
  it('TTL: запись живёт до until, потом вытесняется', () => {
    const c = new CheckCache(1000);
    const k = CheckCache.keyOf('cmd', 'wd', 'manual');
    c.set(k, { verdict: 'ALLOW', source: 'agp', latencyMs: 5 }, 1000);
    expect(c.get(k, 1500)?.verdict).toBe('ALLOW');
    expect(c.get(k, 2500)).toBeNull();
  });

  it('ключ различает команду/папку/режим (hash(команда, рабочая папка, режим))', () => {
    const a = CheckCache.keyOf('cmd', 'wd', 'manual');
    const b = CheckCache.keyOf('cmd2', 'wd', 'manual');
    const c = CheckCache.keyOf('cmd', 'wd2', 'manual');
    const d = CheckCache.keyOf('cmd', 'wd', 'autopilot');
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});
