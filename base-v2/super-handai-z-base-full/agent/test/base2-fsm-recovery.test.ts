// test/base2-fsm-recovery.test.ts — B3 (K5): персистентность FSM и восстановление
// после падения (kill в RUNNING + рестарт → FSM и счётчики из state-файла).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutopilotFsm } from '../src/base2/autopilot/fsm.js';
import { FsmPersist } from '../src/base2/autopilot/fsmPersist.js';
import { TzQueue } from '../src/base2/autopilot/tzQueue.js';
import { TaskHub } from '../src/core/taskHub.js';
import { resetSlotBus, getSlotBus } from '../src/base2/slotBus.js';
import { BusEvents, type TaskFinishedEvent } from '../src/base2/types.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config.js';
import type { Outflow } from '../src/base2/autopilot/outflow.js';
import type { Escalation } from '../src/base2/autopilot/escalation.js';

let dir: string;
let persist: FsmPersist;
let hub: TaskHub;
let outbox: Record<string, unknown>[];
let escalations: { reason: string; dispatchHelper: boolean }[];

const CFG: AgentConfig = { ...DEFAULT_CONFIG, workspaceRoot: join(tmpdir(), 'shai-fsm-ws') };

function mocks() {
  outbox = [];
  escalations = [];
  const outflow = {
    buildTurnReport: (p: { record: { taskId: string; engineStatus?: string; reportMd?: string }; turn: number }) => ({
      kind: 'turn-report',
      chatId: 'c',
      agentId: 'a',
      text: 'turn ' + p.turn + ' ' + (p.record.engineStatus ?? ''),
      truncated: false,
      redactionHits: { tokens: 0, paths: 0, urls: 0 },
    }),
    buildCustom: () => ({ kind: 'escalation', chatId: 'c', agentId: 'a', text: 'esc', truncated: false, redactionHits: { tokens: 0, paths: 0, urls: 0 } }),
  } as unknown as Outflow;
  const escalation = {
    raise: async (input: { reason: string; dispatchHelper: boolean }) => {
      escalations.push({ reason: input.reason, dispatchHelper: input.dispatchHelper });
      return { file: 'x.md', helperDispatched: input.dispatchHelper };
    },
  } as unknown as Escalation;
  return { outflow, escalation };
}

function makeFsm(): AutopilotFsm {
  const { outflow, escalation } = mocks();
  return new AutopilotFsm({
    cfg: CFG,
    hub,
    persist,
    queue: new TzQueue(600000),
    bridge: null,
    outflow,
    escalation,
    broadcast: (m) => outbox.push(m),
  });
}

const FAIL_FP = { step: 1, cls: 'EXPECT' as const, exitCode: 1, message: 'expect не совпал' };

describe('B3 (K5): персистентность и восстановление FSM', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shai-fsm-'));
    persist = new FsmPersist(dir);
    hub = new TaskHub();
    resetSlotBus();
  });
  afterEach(() => {
    resetSlotBus();
    rmSync(dir, { recursive: true, force: true });
  });

  it('state-файл создаётся атомарно и переживает «рестарт» (новый экземпляр читает)', async () => {
    const fsm1 = makeFsm();
    fsm1.start();
    fsm1.beginTurn('chat-1', 'bot', 'task_1', 'conv:chat:chat-1', '# ЗАДАЧ: x');
    fsm1.rememberHash('chat-1', 'a'.repeat(64));
    await new Promise((r) => setTimeout(r, 30));
    expect(existsSync(persist.path)).toBe(true);
    const raw = JSON.parse(readFileSync(persist.path, 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.loops[0].state).toBe('turn-running');

    // «рестарт»: свежий FSM из того же state-файла
    const fsm2 = makeFsm();
    fsm2.start();
    const loops = fsm2.snapshotAll();
    expect(loops).toHaveLength(1);
    expect(loops[0].chatId).toBe('chat-1');
    expect(fsm2.dedupList('chat-1')).toEqual(['a'.repeat(64)]);
    fsm1.stop();
    fsm2.stop();
  });

  it('kill в RUNNING + рестарт: оборот фиксируется как INTERRUPTED, счётчики восстановлены, политика прогнана', async () => {
    // Падение: в state-файле петля turn-running с двумя отказами ДО него.
    persist.write({
      version: 1,
      loops: [
        {
          conversationKey: 'conv:chat:chat-9',
          chatId: 'chat-9',
          agentId: 'bot',
          state: 'turn-running',
          turn: 2,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          pendingTaskId: 'task_dead',
          turns: [
            { n: 1, taskId: 't1', ts: new Date().toISOString(), engineStatus: 'PARTIAL', fingerprint: FAIL_FP },
            { n: 2, taskId: 't2', ts: new Date().toISOString(), engineStatus: 'PARTIAL', fingerprint: FAIL_FP },
          ],
        },
      ],
      dedups: {},
    });

    const fsm = makeFsm();
    fsm.start();
    const loops = fsm.snapshotAll();
    expect(loops).toHaveLength(1);
    expect(loops[0].turn).toBe(3); // прерванный оборот посчитан
    expect(loops[0].turns[2].fingerprint?.cls).toBe('INTERRUPTED');
    // 2 EXPECT + INTERRUPTED ≠ 3 одинаковых; без SUCCESS — 3 < 5 → await-answer
    expect(loops[0].state).toBe('await-answer');
    fsm.stop();
  });

  it('восстановление доводит до стоп-критерия: 4 отказа + INTERRUPTED = 5 без SUCCESS → эскалация', async () => {
    persist.write({
      version: 1,
      loops: [
        {
          conversationKey: 'conv:chat:chat-10',
          chatId: 'chat-10',
          agentId: 'bot',
          state: 'turn-running',
          turn: 4,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          pendingTaskId: 'task_dead',
          turns: [1, 2, 3, 4].map((n) => ({
            n,
            taskId: 't' + n,
            ts: new Date().toISOString(),
            engineStatus: 'PARTIAL' as const,
            fingerprint: { ...FAIL_FP, message: 'varies ' + n, step: n },
          })),
        },
      ],
      dedups: {},
    });
    const fsm = makeFsm();
    fsm.start();
    const loops = fsm.snapshotAll();
    expect(loops[0].state).toBe('stopped');
    expect(loops[0].stopReason).toBe('no-success-N');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].reason).toBe('no-success-N');
    expect(escalations[0].dispatchHelper).toBe(false); // не по отпечаткам — помощник не дёргается
    fsm.stop();
  });

  it('task.finished чужого origin (human) НЕ трогает петлю автопилота', async () => {
    const fsm = makeFsm();
    fsm.start();
    fsm.beginTurn('chat-2', 'bot', 'task_a', 'conv:chat:chat-2', '# ЗАДАЧ: x');
    await getSlotBus().emit<TaskFinishedEvent>(BusEvents.taskFinished, {
      taskId: 'task_human',
      conversationKey: 'conv:ui',
      origin: { type: 'human', agentId: 'op' },
      state: 'done',
      engineStatus: 'SUCCESS',
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(fsm.snapshotAll()[0].turn).toBe(0); // оборот не записан
    fsm.stop();
  });

  it('полный цикл в памяти: отказ → await-answer → контрактное завершение → стоп в успехе', async () => {
    const fsm = makeFsm();
    fsm.start();
    const convKey = 'conv:chat:chat-3';
    fsm.beginTurn('chat-3', 'bot', 'task_b', convKey, '# ЗАДАЧ: x');
    // задача завершилась успехом (как будто из taskService)
    hub.create('autopilot', { origin: { type: 'autopilot', agentId: 'bot' }, conversationId: 'chat-3' });
    await getSlotBus().emit<TaskFinishedEvent>(BusEvents.taskFinished, {
      taskId: hub.recent(1)[0].taskId,
      conversationKey: convKey,
      origin: { type: 'autopilot', agentId: 'bot' },
      state: 'done',
      engineStatus: 'SUCCESS',
      reportMd: '# ОТЧЁТ',
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(fsm.snapshotAll()[0].state).toBe('await-answer');
    expect(outbox.length).toBe(1);
    expect((outbox[0] as { type: string }).type).toBe('autopilot.outbox');
    // контрактное завершение (не подстрока!) — стоп в успехе, БЕЗ эскалации
    fsm.notifyComplete('chat-3', 'bot');
    await new Promise((r) => setTimeout(r, 30));
    const loop = fsm.snapshotAll()[0];
    expect(loop.state).toBe('stopped');
    expect(loop.stopReason).toBe('complete');
    expect(escalations).toHaveLength(0);
    fsm.stop();
  });
});
