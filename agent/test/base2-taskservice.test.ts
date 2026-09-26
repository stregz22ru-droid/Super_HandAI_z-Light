// test/base2-taskservice.test.ts — П-1: taskService.startTz (единый билдер,
// немедленный taskId, параллельность между разговорами, FIFO внутри разговора,
// per-task stop/confirm, origin-атрибуция в карточке).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskHub } from '../src/core/taskHub.js';
import { TaskService } from '../src/base2/taskService.js';
import { resetSlotBus, getSlotBus } from '../src/base2/slotBus.js';
import { BusEvents, type TaskFinishedEvent, type TaskStartedEvent } from '../src/base2/types.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config.js';

let dir: string;
let hub: TaskHub;
let ts: TaskService;
let broadcasts: Record<string, unknown>[];
let started: TaskStartedEvent[];
let finished: TaskFinishedEvent[];

const CFG: AgentConfig = { ...DEFAULT_CONFIG, workspaceRoot: join(tmpdir(), 'shai-test-ws'), stepTimeoutSec: 30 };

const OK_TZ = `# ЗАДАЧ: ок
# META
workdir: new:ws-tsvc-ok
mode: auto

## ШАГ 1. Маркер
RUN
\`\`\`bash
echo tsvc-ok-marker
\`\`\`
EXPECT stdout contains: tsvc-ok-marker
`;

const SLOW_TZ = `# ЗАДАЧ: медленная
# META
workdir: new:ws-tsvc-slow
mode: auto

## ШАГ 1. Пауза
RUN
\`\`\`bash
sleep 1
\`\`\`
EXPECT exit=0
`;

// два шага — стоп-сигнал проверяется движком МЕЖДУ директивами
const SLOW2_TZ = `# ЗАДАЧ: медленная-2
# META
workdir: new:ws-tsvc-slow2
mode: auto

## ШАГ 1. Пауза
RUN
\`\`\`bash
sleep 1
\`\`\`
EXPECT exit=0

## ШАГ 2. Финиш
RUN
\`\`\`bash
echo finished-ok
\`\`\`
EXPECT stdout contains: finished-ok
`;

const CONFIRM_TZ = `# ЗАДАЧ: confirm
# META
workdir: new:ws-tsvc-conf
mode: confirm

## ШАГ 1. Пауза
RUN
\`\`\`bash
sleep 1
\`\`\`
EXPECT exit=0
`;

describe('П-1: TaskService', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shai-tsvc-'));
    resetSlotBus();
    hub = new TaskHub();
    broadcasts = [];
    started = [];
    finished = [];
    ts = new TaskService({
      cfg: CFG,
      hub,
      reportsDir: join(dir, 'reports'),
      logDir: join(dir, 'logs'),
      broadcast: (m) => broadcasts.push(m),
    });
    getSlotBus().on<TaskStartedEvent>(BusEvents.taskStarted, (e) => started.push(e));
    getSlotBus().on<TaskFinishedEvent>(BusEvents.taskFinished, (e) => finished.push(e));
  });
  afterEach(() => {
    ts.stopTask();
    resetSlotBus();
    rmSync(dir, { recursive: true, force: true });
  });

  it('taskId возвращается НЕМЕДЛЕННО; origin/sessionId/conversationId в карточке', async () => {
    const t0 = Date.now();
    const r = ts.startTz(OK_TZ, { type: 'mcp', agentId: 'mcp' }, { sessionId: 's1', conversationId: 'mcp' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Date.now() - t0).toBeLessThan(300); // немедленно, не ждём исполнения
    expect(r.conversationKey).toBe('conv:mcp');
    const rec = hub.get(r.taskId);
    expect(rec?.origin).toEqual({ type: 'mcp', agentId: 'mcp' });
    expect(rec?.sessionId).toBe('s1');
    await new Promise((res) => setTimeout(res, 1500));
    const done = hub.get(r.taskId);
    expect(done?.state).toBe('done');
    expect(done?.engineStatus).toBe('SUCCESS');
  }, 15000);

  it('валидация: пустое ТЗ / без шагов / без workdir — отказ без создания задачи', () => {
    expect(ts.startTz('', { type: 'human', agentId: 'op' }).ok).toBe(false);
    expect(ts.startTz('# ЗАДАЧ: пусто\n# META\nworkdir: new:ws-x\n', { type: 'human', agentId: 'op' }).ok).toBe(false);
    const noWorkdir = '# ЗАДАЧ: нет workdir\n# META\n\n## ШАГ 1\nRUN\n```bash\necho x\n```\nEXPECT exit=0\n';
    const r = ts.startTz(noWorkdir, { type: 'human', agentId: 'op' });
    expect(r.ok).toBe(false);
    expect(hub.list()).toHaveLength(0);
  });

  it('параллельность между разговорами (П-1): две задачи разных чатов идут одновременно', async () => {
    const t0 = Date.now();
    const a = ts.startTz(SLOW_TZ, { type: 'autopilot', agentId: 'bot' }, { conversationId: 'chat:a' });
    const b = ts.startTz(SLOW_TZ, { type: 'autopilot', agentId: 'bot' }, { conversationId: 'chat:b' });
    expect(a.ok && b.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 400));
    // обе Running одновременно
    expect(hub.get(a.ok ? a.taskId : '')?.state).toBe('running');
    expect(hub.get(b.ok ? b.taskId : '')?.state).toBe('running');
    await new Promise((res) => setTimeout(res, 1600));
    // две задачи по ~1с завершились за < 2с суммарно → параллельно
    const wall = Date.now() - t0;
    expect(wall).toBeLessThan(2800);
    expect(finished.length).toBe(2);
  }, 20000);

  it('FIFO внутри одного разговора: вторая задача ждёт первой (очередь per-conversation)', async () => {
    const a = ts.startTz(SLOW_TZ, { type: 'human', agentId: 'op' }, { conversationId: 'same' });
    const b = ts.startTz(OK_TZ, { type: 'human', agentId: 'op' }, { conversationId: 'same' });
    expect(a.ok && b.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 300));
    expect(hub.get(a.ok ? a.taskId : '')?.state).toBe('running');
    expect(hub.get(b.ok ? b.taskId : '')?.state).toBe('queued');
    const snap = ts.snapshot();
    expect(snap.queued.some((q) => q.conversationKey === 'conv:same' && q.count === 1)).toBe(true);
    await new Promise((res) => setTimeout(res, 2400));
    expect(finished.length).toBe(2);
    // порядок: a раньше b
    const ia = finished.findIndex((f) => f.taskId === (a.ok ? a.taskId : ''));
    const ib = finished.findIndex((f) => f.taskId === (b.ok ? b.taskId : ''));
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(ib).toBeGreaterThan(ia);
  }, 20000);

  it('per-task stop: task.stop(taskId) останавливает только указанную задачу', async () => {
    const a = ts.startTz(SLOW2_TZ, { type: 'human', agentId: 'op' }, { conversationId: 'chat:a' });
    const b = ts.startTz(SLOW2_TZ, { type: 'human', agentId: 'op' }, { conversationId: 'chat:b' });
    expect(a.ok && b.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 300));
    ts.stopTask(a.ok ? a.taskId : '');
    // a остановлена между шагами (шаг 2 не начинается), b доезжает до SUCCESS
    expect(await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 6000) {
        const ra = hub.get(a.ok ? a.taskId : '');
        const rb = hub.get(b.ok ? b.taskId : '');
        if (ra?.state === 'stopped' && rb?.engineStatus === 'SUCCESS') return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })()).toBe(true);
    expect(hub.get(a.ok ? a.taskId : '')?.state).toBe('stopped');
    expect(hub.get(b.ok ? b.taskId : '')?.engineStatus).toBe('SUCCESS');
  }, 15000);

  it('confirm-панель per-task: taskId в broadcast, answerConfirm маршрутизирует по taskId', async () => {
    const r = ts.startTz(CONFIRM_TZ, { type: 'human', agentId: 'op' }, { conversationId: 'c1' });
    expect(r.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 300));
    const conf = broadcasts.find((m) => m.type === 'confirm.request') as { taskId?: string } | undefined;
    expect(conf?.taskId).toBe(r.ok ? r.taskId : '');
    expect(ts.pendingConfirmFor('op')).toBe(true);
    expect(ts.answerConfirm(r.ok ? r.taskId : '', true)).toBe(true);
    await new Promise((res) => setTimeout(res, 1800));
    expect(hub.get(r.ok ? r.taskId : '')?.engineStatus).toBe('SUCCESS');
  }, 15000);

  it('isIdle учитывает и активные, и queued задачи агента', async () => {
    const a = ts.startTz(SLOW_TZ, { type: 'autopilot', agentId: 'bot' }, { conversationId: 'chat:a' });
    const b = ts.startTz(SLOW_TZ, { type: 'autopilot', agentId: 'bot' }, { conversationId: 'chat:b' });
    const c = ts.startTz(SLOW_TZ, { type: 'autopilot', agentId: 'bot' }, { conversationId: 'chat:c' });
    expect(a.ok && b.ok && c.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 200));
    expect(ts.isIdle('bot')).toBe(false);
    expect(ts.isIdle('other-agent')).toBe(true);
    ts.stopTask();
  }, 15000);
});
