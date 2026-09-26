// base2/taskService.ts — ЕДИНЫЙ билдер запуска задач (П-1, Ponytail: один
// билдер на всех потребителей). ВСЕ входы — WS task.start, HTTP /tasks,
// MCP run_tz (через agentLink → WS), автопилот (bridgeIn), эскалация-к-агенту —
// идут через TaskService.startTz(tzText, origin, {sessionId, conversationId}).
//
// Гарантии:
//  • taskId возвращается НЕМЕДЛЕННО (исполнение в фоне);
//  • параллельность между разговорами (per-conversation очереди, FIFO внутри
//    разговора), глобальный предел — cfg.autopilot.maxParallel;
//  • per-task stopSignal и per-task confirm-маршрутизация (task.stop /
//    confirm.answer с taskId, легатси-вызовы без taskId маршрутизируются);
//  • события task.started / task.finished — через шину слотов (П-4);
//  • исполнение оборачивается в currentTask-контекст (для CHECK per-agent).
import { resolve as resolvePath } from 'node:path';
import { parseTz } from '../tz/parser.js';
import type { TzDoc } from '../tz/model.js';
import { lint } from '../tz/linter.js';
import { executeDoc, type EngineResult, type StepResult } from '../core/stepEngine.js';
import { renderReport, saveReport } from '../core/reporter.js';
import type { TaskHub, TaskRecord } from '../core/taskHub.js';
import type { AgentConfig } from '../config.js';
import { runWithTask } from './currentTask.js';
import { getSlotBus } from './slotBus.js';
import { BusEvents, type TaskOrigin, type TaskStartedEvent, type TaskFinishedEvent } from './types.js';

export interface StartTzOptions {
  sessionId?: string;
  conversationId?: string;
}

export type StartTzResult =
  | { ok: true; taskId: string; conversationKey: string; queued: boolean }
  | { ok: false; error: string; conflict?: boolean };

interface QueueEntry {
  taskId: string;
  doc: TzDoc;
}

export interface TaskServiceDeps {
  cfg: AgentConfig;
  hub: TaskHub;
  reportsDir: string;
  logDir: string;
  /** Широковещательная функция сервера (WS). */
  broadcast: (msg: Record<string, unknown>) => void;
}

export function conversationKeyOf(origin: TaskOrigin, opts?: StartTzOptions): string {
  if (opts?.conversationId && opts.conversationId.trim() !== '') return 'conv:' + opts.conversationId.trim();
  if (opts?.sessionId && opts.sessionId.trim() !== '') return 'sess:' + opts.sessionId.trim();
  return 'agent:' + origin.agentId;
}

/** Валидация ТЗ — единственный билдер правил приёмки ТЗ (используют и мост,
 *  и startTz). Возвращает человекочитаемые ошибки в формате server.ts. */
export function validateTzText(tzText: string): { ok: true; doc: TzDoc } | { ok: false; error: string } {
  if (typeof tzText !== 'string' || tzText.trim() === '') {
    return { ok: false, error: 'tzText обязателен (строка с ТЗ в формате format-spec)' };
  }
  const parsed = parseTz(tzText);
  if (!parsed.ok || !parsed.doc) {
    return {
      ok: false,
      error: 'parse errors:\n' + parsed.errors.map((e) => `  line ${e.line}: ${e.message}`).join('\n'),
    };
  }
  if (!parsed.doc.steps || parsed.doc.steps.length === 0) {
    return { ok: false, error: 'ОТКЛОНЕНО: в ТЗ нет ни одного шага (## ШАГ N). Пустая задача не запускается.' };
  }
  if (!parsed.doc.meta.workdir || parsed.doc.meta.workdir.trim() === '') {
    return { ok: false, error: 'ОТКЛОНЕНО: в META не указан workdir. Каждая задача обязана иметь изолированную папку.' };
  }
  return { ok: true, doc: parsed.doc };
}

export class TaskService {
  private queues = new Map<string, QueueEntry[]>();
  private running = new Map<string, string>(); // conversationKey -> taskId
  private stops = new Map<string, { stopped: boolean }>();
  private confirms = new Map<string, (v: boolean) => void>(); // taskId -> resolve
  private bus = getSlotBus();

  constructor(private deps: TaskServiceDeps) {}

  private get maxParallel(): number {
    const n = this.deps.cfg.autopilot?.maxParallel ?? 2;
    return Math.max(1, Math.floor(n));
  }

  /** Запуск ТЗ: валидация → постановка в очередь разговора → немедленный taskId. */
  startTz(tzText: string, origin: TaskOrigin, opts?: StartTzOptions): StartTzResult {
    const v = validateTzText(tzText);
    if (!v.ok) return { ok: false, error: v.error };

    const key = conversationKeyOf(origin, opts);
    const rec = this.deps.hub.create(this.sourceOf(origin), {
      origin,
      sessionId: opts?.sessionId,
      conversationId: opts?.conversationId,
    });

    let q = this.queues.get(key);
    if (!q) {
      q = [];
      this.queues.set(key, q);
    }
    q.push({ taskId: rec.taskId, doc: v.doc });

    // lint-трансляция (как в легатси submitTask) — для UI
    const issues = lint(v.doc);
    this.deps.broadcast({ type: 'lint.result', issues });

    this.pump();
    const queued = this.running.get(key) !== rec.taskId;
    return { ok: true, taskId: rec.taskId, conversationKey: key, queued };
  }

  private sourceOf(origin: TaskOrigin): TaskRecord['source'] {
    switch (origin.type) {
      case 'autopilot':
        return 'autopilot';
      case 'mcp':
        return 'mcp';
      case 'help-request':
        return 'help-request';
      case 'autopilot-help':
        return 'autopilot-help';
      default:
        return 'ws';
    }
  }

  /** Раздача очередей: разговор без активной задачи + глобальный лимит. */
  private pump(): void {
    for (const [key, q] of [...this.queues.entries()]) {
      if (q.length === 0) continue;
      if (this.running.has(key)) continue;
      if (this.running.size >= this.maxParallel) return; // глобальный предел
      this.startNext(key, q);
    }
  }

  private startNext(key: string, q: QueueEntry[]): void {
    const entry = q.shift()!;
    if (!this.deps.hub.begin(entry.taskId, key)) {
      // проиграла гонку (не должно случаться: очередь одна на разговор)
      this.deps.hub.abandon(entry.taskId);
      return;
    }
    this.running.set(key, entry.taskId);
    void this.execute(entry.taskId, entry.doc, key);
  }

  private async execute(taskId: string, doc: TzDoc, key: string): Promise<void> {
    const { cfg, hub, broadcast } = this.deps;
    const rec = hub.get(taskId);
    const origin: TaskOrigin = rec?.origin ?? { type: 'human', agentId: 'operator' };
    const stopSignal = { stopped: false };
    this.stops.set(taskId, stopSignal);

    const steps: { i: number; title: string }[] = doc.steps.map((s, i) => ({ i: i + 1, title: s.title }));
    broadcast({ type: 'task.accepted', taskId, steps } as Record<string, unknown>);
    void this.bus.emit<TaskStartedEvent>(BusEvents.taskStarted, { taskId, conversationKey: key, origin });

    let result: EngineResult;
    try {
      result = await runWithTask(
        { taskId, conversationKey: key, origin: { type: origin.type, agentId: origin.agentId }, mode: 'engine' },
        () =>
          executeDoc(
            doc,
            cfg,
            taskId,
            {
              onStepStatus: (i, state, extra) => broadcast({ type: 'step.status', i, state, ...extra } as Record<string, unknown>),
              onPtyData: (task, data) => broadcast({ type: 'pty.data', task, data } as Record<string, unknown>),
              onNote: (text) => broadcast({ type: 'pty.data', task: taskId, data: `\x1b[33m${text}\x1b[0m\r\n` } as Record<string, unknown>),
              onNeedConfirm: (i, kind, preview) =>
                new Promise<boolean>((resolveC) => {
                  this.confirms.set(taskId, resolveC);
                  broadcast({
                    type: 'confirm.request',
                    id: taskId + ':' + i,
                    taskId,
                    kind,
                    text: 'ШАГ ' + i + ' [' + kind + ']: ' + preview,
                  } as Record<string, unknown>);
                }),
            },
            stopSignal,
            this.deps.logDir,
          ),
      );
    } catch (e) {
      result = {
        status: 'STOPPED',
        results: [] as StepResult[],
        notes: ['engine error: ' + (e instanceof Error ? e.message : String(e))],
        workspace: cfg.workspaceRoot,
      };
    }

    let reportMd = '';
    let reportPath: string | undefined;
    try {
      reportMd = renderReport(doc, result, taskId);
      reportPath = saveReport(reportMd, this.deps.reportsDir, taskId);
      broadcast({ type: 'task.done', status: result.status, reportMd, taskId } as Record<string, unknown>);
    } catch (e) {
      const msg = 'report error: ' + (e instanceof Error ? e.message : String(e));
      hub.fail(taskId, msg);
      this.cleanup(taskId, key);
      void this.bus.emit<TaskFinishedEvent>(BusEvents.taskFinished, {
        taskId,
        conversationKey: key,
        origin,
        state: 'failed',
        error: msg,
      });
      this.pump();
      return;
    }

    const state =
      result.status === 'DENIED' ? 'denied' : result.status === 'STOPPED' ? 'stopped' : 'done';
    hub.finish(taskId, {
      state,
      engineStatus: result.status,
      steps: result.results,
      notes: result.notes,
      workspace: result.workspace,
      reportMd,
      reportPath: reportPath ? resolvePath(reportPath) : undefined,
    });

    this.cleanup(taskId, key);
    void this.bus.emit<TaskFinishedEvent>(BusEvents.taskFinished, {
      taskId,
      conversationKey: key,
      origin,
      state,
      engineStatus: result.status,
      reportPath: reportPath ? resolvePath(reportPath) : undefined,
      reportMd,
      workspace: result.workspace,
    });
    this.pump();
  }

  private cleanup(taskId: string, key: string): void {
    if (this.running.get(key) === taskId) this.running.delete(key);
    this.stops.delete(taskId);
    const c = this.confirms.get(taskId);
    if (c) {
      this.confirms.delete(taskId);
      try { c(false); } catch { /* no-op */ }
    }
  }

  /** Останов задачи (без taskId — все активные, легатси-семантика UI). */
  stopTask(taskId?: string): number {
    let n = 0;
    if (taskId) {
      const s = this.stops.get(taskId);
      if (s) { s.stopped = true; n++; }
      const c = this.confirms.get(taskId);
      if (c) { try { c(false); } catch { /* no-op */ } }
      return n;
    }
    for (const s of this.stops.values()) { s.stopped = true; n++; }
    for (const c of this.confirms.values()) { try { c(false); } catch { /* no-op */ } }
    return n;
  }

  /** Ответ на confirm-панель. С taskId — маршрутизация конкретной задаче;
   *  без taskId (легатси-UI) — единственной ожидающей. */
  answerConfirm(taskId: string | undefined, answer: boolean): boolean {
    if (taskId) {
      const c = this.confirms.get(taskId);
      if (!c) return false;
      this.confirms.delete(taskId);
      c(answer);
      return true;
    }
    if (this.confirms.size === 1) {
      const [only] = this.confirms.keys();
      const c = this.confirms.get(only)!;
      this.confirms.delete(only);
      c(answer);
      return true;
    }
    return false;
  }

  /** Есть ли открытая confirm-панель у активной задачи агента (Б1: блок переключения). */
  pendingConfirmFor(agentId: string): boolean {
    for (const [key, taskId] of this.running) {
      void key;
      const rec = this.deps.hub.get(taskId);
      if (rec?.origin?.agentId === agentId && this.confirms.has(taskId)) return true;
    }
    return false;
  }

  /** B1: агент idle = нет ни активных, ни queued задач этого агента. */
  isIdle(agentId: string): boolean {
    for (const taskId of this.running.values()) {
      const rec = this.deps.hub.get(taskId);
      if (rec?.origin?.agentId === agentId) return false;
    }
    for (const [key, q] of this.queues) {
      void key;
      for (const entry of q) {
        const rec = this.deps.hub.get(entry.taskId);
        if (rec?.origin?.agentId === agentId) return false;
      }
    }
    return true;
  }

  /** Диагностика: снапшот очередей и исполнений. */
  snapshot(): { running: { conversationKey: string; taskId: string }[]; queued: { conversationKey: string; count: number }[] } {
    const running = [...this.running.entries()].map(([conversationKey, taskId]) => ({ conversationKey, taskId }));
    const queued = [...this.queues.entries()]
      .filter(([, q]) => q.length > 0)
      .map(([conversationKey, q]) => ({ conversationKey, count: q.length }));
    return { running, queued };
  }
}
