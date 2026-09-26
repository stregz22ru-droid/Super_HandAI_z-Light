// core/taskHub.ts — единый выделитель задач (Base Этап 1, Модуль 1; расширен в Этапе 2).
// Один реестр задач для ВСЕХ входов: WS-мост (task.start), HTTP /tasks, MCP-прокси
// (через agentLink → WS task.start), автопилот и эскалация-к-агенту (через taskService).
//
// ЭТАП 2 (П-1): мульти-инициатор и мульти-агент.
//  • Очередь/активность ВЕДЁТСЯ per-conversation: задачи разных разговоров
//    исполняются ПАРАЛЛЕЛЬНО (глобальный предел — maxParallel в taskService),
//    внутри одного разговора — строго последовательно (FIFO).
//  • Каждая задача несёт origin {type, agentId} + sessionId/conversationId —
//    атрибуция обязательна для журналов, памяти и CHECK-статистики per-agent.
//  • FSM — per-task: карточка задачи в этом хабе и есть состояние оборота.
//
// КОНТРАКТ СТАТУС-КАНАЛА (ДОЗАКАЗ п.1): taskId, выданный run_tz, ОБЯЗАН
// находиться в ЭТОМ же экземпляре TaskHub — status.get (WS) читает hub.get()
// того же процесса, поэтому get_status всегда возвращает непустой
// {state, engineStatus, steps}. ВТОРОЙ экземпляр TaskHub для MCP запрещён:
// сплит-брейн store'ов = дефект.
import type { StepResult } from './stepEngine.js';
import type { TaskOrigin } from '../base2/types.js';

export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'denied';
export type TaskSource = 'ws' | 'http' | 'mcp' | 'autopilot' | 'help-request' | 'autopilot-help';

export interface TaskRecord {
  taskId: string;
  source: TaskSource;
  state: TaskState;
  createdAt: string;
  finishedAt?: string;
  // ЭТАП 2 (П-1): атрибуция инициатора
  origin?: TaskOrigin;
  sessionId?: string;
  conversationId?: string;
  // Вердикт движка (EngineResult.status): SUCCESS | PARTIAL | STOPPED | DENIED
  engineStatus?: 'SUCCESS' | 'PARTIAL' | 'STOPPED' | 'DENIED';
  steps?: StepResult[];
  notes?: string[];
  workspace?: string;
  reportMd?: string;
  reportPath?: string;
  error?: string;
}

let seq = 0;
function newTaskId(): string {
  seq = (seq + 1) % 10000;
  return 'task_' + Date.now() + '_' + String(seq).padStart(4, '0');
}

export class TaskHub {
  private tasks = new Map<string, TaskRecord>();
  // ЭТАП 2 (П-1): не один активный слот, а КАРТА активных задач по разговорам.
  // Ключ карты — taskId, значение — conversationKey.
  private active = new Map<string, string>();

  /** Зарегистрировать задачу (state=queued). Исполнение начинается после begin(). */
  create(source: TaskSource, attribution?: { origin?: TaskOrigin; sessionId?: string; conversationId?: string }): TaskRecord {
    const rec: TaskRecord = {
      taskId: newTaskId(),
      source,
      state: 'queued',
      createdAt: new Date().toISOString(),
      ...(attribution ?? {}),
    };
    this.tasks.set(rec.taskId, rec);
    return rec;
  }

  /**
   * Захват слота исполнения. ЭТАП 2: разрешает параллельность МЕЖДУ
   * разговорами — begin успешен, если этот разговор ещё не исполняет задачу.
   * Последовательность ВНУТРИ разговора обеспечивает taskService (FIFO-очередь).
   */
  begin(taskId: string, conversationKey: string): boolean {
    if (this.active.has(taskId)) return false;
    this.active.set(taskId, conversationKey);
    const rec = this.tasks.get(taskId);
    if (rec) rec.state = 'running';
    return true;
  }

  /** Отклонить queued-запись (проиграла гонку за слот исполнения). */
  abandon(taskId: string): void {
    const rec = this.tasks.get(taskId);
    if (rec && rec.state === 'queued') this.tasks.delete(taskId);
  }

  finish(taskId: string, patch: Partial<TaskRecord>): void {
    const rec = this.tasks.get(taskId);
    if (!rec) return;
    Object.assign(rec, patch);
    rec.finishedAt = new Date().toISOString();
    this.active.delete(taskId);
  }

  /** Аварийное завершение (ошибка движка/сервера) — state=failed + error. */
  fail(taskId: string, error: string): void {
    this.finish(taskId, { state: 'failed', error });
  }

  get(taskId: string): TaskRecord | undefined {
    const rec = this.tasks.get(taskId);
    return rec ? { ...rec } : undefined;
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()]
      .map((r) => ({ ...r }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  recent(n: number): TaskRecord[] {
    return this.list().slice(0, n);
  }

  /** Занят ли агент ЦЕЛИКОМ (для /workspace/purge): хоть одна активная задача. */
  isBusy(): boolean {
    return this.active.size > 0;
  }

  /** ЭТАП 2: активные задачи. */
  activeCount(): number {
    return this.active.size;
  }

  activeTaskIds(): string[] {
    return [...this.active.keys()];
  }

  /** Активная задача конкретного разговора (или null). */
  activeIn(conversationKey: string): string | null {
    for (const [taskId, key] of this.active) {
      if (key === conversationKey) return taskId;
    }
    return null;
  }

  /** ЛЕГАТСИ-алиас для старых вызовов (UI-статусы): любая активная задача. */
  get activeTaskId(): string | null {
    for (const taskId of this.active.keys()) return taskId;
    return null;
  }
}
