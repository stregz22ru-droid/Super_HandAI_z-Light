// test/taskHub.test.ts — единый выделитель задач (ЭТАП 1, МОДУЛЬ 1 п. 1.4):
// ин-процесс занятость, кросс-процессный lock (свежий блокирует, протухший
// сносится), «отмена оператора = SKIP», реестр задач для get_status.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { TaskHub, type TaskRecord } from '../src/core/taskHub.js';

let stateDir: string;

beforeEach(() => {
  stateDir = join(mkdtempSync(join(tmpdir(), 'shz-hub-')), 'state');
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function makeRecord(taskId: string, owner: 'http' | 'mcp' = 'mcp'): TaskRecord {
  return {
    taskId,
    owner,
    pid: process.pid,
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    stepCount: 2,
    steps: [
      { i: 1, title: 'шаг раз', status: 'pending' },
      { i: 2, title: 'шаг два', status: 'pending' },
    ],
    notes: [],
    additionalContext: [],
  };
}

function liveExternalPid(): Promise<number> {
  return new Promise((res) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},100)'], { stdio: 'ignore' });
    setTimeout(() => res(child.pid!), 150);
    child.unref();
  });
}

describe('TaskHub — единый выделитель задач (HTTP+MCP)', () => {
  it('begin/finish: активная задача видна; после finish — снята и lock удалён', () => {
    const hub = new TaskHub({ owner: 'mcp', stateDir });
    expect(hub.preflightCheck().ok).toBe(true);

    const rec = makeRecord('task_1001');
    hub.begin(rec);
    expect(hub.activeTaskId).toBe('task_1001');
    expect(hub.preflightCheck().ok).toBe(false);
    expect(existsSync(join(stateDir, 'task.lock.json'))).toBe(true);

    rec.status = 'SUCCESS';
    hub.finish(rec);
    expect(hub.activeTaskId).toBeNull();
    expect(hub.preflightCheck().ok).toBe(true);
    expect(existsSync(join(stateDir, 'task.lock.json'))).toBe(false);
    // рекорд остался в реестре задач
    const rec2 = hub.loadRecord('task_1001');
    expect(rec2?.status).toBe('SUCCESS');
    expect(rec2?.finishedAt).toBeTruthy();
  });

  it('кросс-процессный lock: ЖИВОЙ чужой процесс блокирует (external=true)', async () => {
    const pid = await liveExternalPid();
    try {
      const ext = { taskId: 'task_ext1', owner: 'http', pid, startedAt: new Date().toISOString(), hb: Date.now() };
      writeFileSync(join(stateDir, 'task.lock.json'), JSON.stringify(ext), 'utf8');
      const hub = new TaskHub({ owner: 'mcp', stateDir });
      const pre = hub.preflightCheck();
      expect(pre.ok).toBe(false);
      expect(pre.blocker?.external).toBe(true);
      expect(pre.blocker?.taskId).toBe('task_ext1');
      // begin тоже отказывает
      expect(() => hub.begin(makeRecord('task_1002'))).toThrow(/занято другим процессом/);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* уже мёртв */ }
    }
  });

  it('кросс-процессный lock: МЁРТВЫЙ процесс (pid неживой) не блокирует', async () => {
    const pid = await liveExternalPid();
    const ext = { taskId: 'task_dead', owner: 'http', pid, startedAt: new Date().toISOString(), hb: Date.now() };
    writeFileSync(join(stateDir, 'task.lock.json'), JSON.stringify(ext), 'utf8');
    try { process.kill(pid, 'SIGKILL'); } catch { /* уже мёртв */ }
    // даём ОС прибрать процесс
    await new Promise((r) => setTimeout(r, 120));

    const hub = new TaskHub({ owner: 'mcp', stateDir });
    expect(hub.preflightCheck().ok).toBe(true);
    const rec = makeRecord('task_1003');
    expect(() => hub.begin(rec)).not.toThrow();
    hub.finish(rec);
  });

  it('кросс-процессный lock: протухший heartbeat живого процесса НЕ блокирует (steal)', async () => {
    const pid = await liveExternalPid();
    try {
      const ext = { taskId: 'task_stale', owner: 'http', pid, startedAt: new Date().toISOString(), hb: Date.now() - 60_000 };
      writeFileSync(join(stateDir, 'task.lock.json'), JSON.stringify(ext), 'utf8');
      const hub = new TaskHub({ owner: 'mcp', stateDir, staleMs: 5000 });
      expect(hub.preflightCheck().ok).toBe(true);
      const rec = makeRecord('task_1004');
      expect(() => hub.begin(rec)).not.toThrow(); // steal: свой lock поверх протухшего
      hub.finish(rec);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* уже мёртв */ }
    }
  });

  it('отмена оператора = SKIP: стоп-сигнал поднят, висящий confirm разрешается false', async () => {
    const hub = new TaskHub({ owner: 'http', stateDir });
    const rec = makeRecord('task_1005', 'http');
    hub.begin(rec);
    const confirmPromise = hub.requestConfirm('task_1005', 2, 'RUN');
    expect(hub.stopOperator()).toBe(true);
    await expect(confirmPromise).resolves.toBe(false); // «false» → движок даёт шагу skip
    expect(hub.stopSignal?.stopped).toBe(true);
    expect(hub.pendingConfirm).toBeNull();
    hub.finish(rec);
    expect(hub.stopOperator()).toBe(false); // после завершения отменять нечего
  });

  it('answerConfirm: отвечает и снимает pending; без pending — false', async () => {
    const hub = new TaskHub({ owner: 'http', stateDir });
    expect(hub.answerConfirm(true)).toBe(false);
    const rec = makeRecord('task_1006', 'http');
    hub.begin(rec);
    const p = hub.requestConfirm('task_1006', 1, 'RUN_BG');
    expect(hub.answerConfirm(true)).toBe(true);
    await expect(p).resolves.toBe(true);
    expect(hub.answerConfirm(true)).toBe(false);
    hub.finish(rec);
  });

  it('nextTaskId: уникализует при коллизии по реестру', () => {
    const hub = new TaskHub({ owner: 'mcp', stateDir });
    const now = 1_700_000_000_000;
    const id1 = hub.nextTaskId(now);
    expect(id1).toBe('task_' + now);
    // имитируем запись прошлой задачи с тем же id
    const rec = makeRecord(id1);
    rec.status = 'SUCCESS';
    hub.finish({ ...rec, taskId: id1 } as TaskRecord); // finish записывает в tasks.json
    const id2 = hub.nextTaskId(now);
    expect(id2).toBe('task_' + now + '-2');
  });

  it('loadRecord: видит задачи другого входа через tasks.json (HTTP ↔ MCP)', () => {
    const httpHub = new TaskHub({ owner: 'http', stateDir });
    const rec = makeRecord('task_http_1', 'http');
    rec.status = 'PARTIAL';
    rec.additionalContext = ['ctx: из HTTP'];
    httpHub.finish(rec); // finish пишет в общий tasks.json

    const mcpHub = new TaskHub({ owner: 'mcp', stateDir });
    const seen = mcpHub.loadRecord('task_http_1');
    expect(seen?.owner).toBe('http');
    expect(seen?.status).toBe('PARTIAL');
    expect(seen?.additionalContext).toEqual(['ctx: из HTTP']);
  });

  it('finish: рекорд без статуса получает FAILED (crash-гигиена)', () => {
    const hub = new TaskHub({ owner: 'mcp', stateDir });
    const rec = makeRecord('task_1007');
    hub.begin(rec);
    hub.finish(rec);
    expect(rec.status).toBe('FAILED');
  });
});
