// core/taskHub.ts — ЕДИНЫЙ ВЫДЕЛИТЕЛЬ ЗАДАЧ (HTTP + MCP).
// Проблема (Ponytail-Research, таблица 10, риск R1): dist/mcp.js — отдельный
// процесс; если HTTP-агент и MCP-сервер оба запускают задачи «в своих переменных»,
// возникает двойная активность. Решение: один и тот же TaskHub в обоих входах —
// ин-процесс состояние + кросс-процессный lock-файл data/state/task.lock.json
// с heartbeat. Мёртвый процесс (crash) определяется по heartbeat и отпирается.
// Отчёты о задачах дублируются в data/state/tasks.json — get_status видит
// задачи другого входа (HTTP ↔ MCP).
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export type TaskOwner = 'http' | 'mcp';

export type TaskRunStatus = 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'STOPPED' | 'DENIED' | 'FAILED';

export interface TaskStepSnapshot {
  i: number;
  title: string;
  status: 'run' | 'ok' | 'fail' | 'skip' | 'denied' | 'confirm' | 'pending';
}

export interface TaskRecord {
  taskId: string;
  owner: TaskOwner;
  pid: number;
  status: TaskRunStatus;
  startedAt: string; // ISO
  finishedAt?: string;
  workspace?: string;
  stepCount?: number;
  steps: TaskStepSnapshot[];
  notes: string[];
  /** additionalContext-канал (Модуль 2.2): контекст для журнала/следующего промта. */
  additionalContext: string[];
  reportPath?: string;
  error?: string;
}

export interface LockInfo {
  taskId: string;
  owner: TaskOwner;
  pid: number;
  startedAt: string;
  hb: number; // epoch ms последнего heartbeat
}

export interface BusyBlocker {
  taskId: string;
  owner: string;
  pid: number;
  /** true — блокер в ДРУГОМ процессе (внешний lock), false — в этом. */
  external: boolean;
}

const DEFAULT_HEARTBEAT_MS = 3000;
const DEFAULT_STALE_MS = 30000;

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0); // сигнал 0 = проверка существования
    return true;
  } catch (e: any) {
    return e && e.code === 'EPERM'; // EPERM = процесс есть, прав нет
  }
}

export class TaskHub {
  current: TaskRecord | null = null;
  stopSignal: { stopped: boolean } | null = null;
  pendingConfirm: { resolve: (v: boolean) => void; taskId: string; i: number; kind: string } | null = null;

  private readonly owner: TaskOwner;
  private readonly lockPath: string;
  private readonly recordsPath: string;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  private hbTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { owner: TaskOwner; stateDir: string; heartbeatMs?: number; staleMs?: number }) {
    this.owner = opts.owner;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
    mkdirSync(opts.stateDir, { recursive: true });
    this.lockPath = resolve(opts.stateDir, 'task.lock.json');
    this.recordsPath = resolve(opts.stateDir, 'tasks.json');
  }

  get activeTaskId(): string | null {
    return this.current ? this.current.taskId : null;
  }

  /** --- Кросс-процессный lock ---------------------------------------------- */

  static readLockFile(stateDir: string): LockInfo | null {
    const p = resolve(stateDir, 'task.lock.json');
    if (!existsSync(p)) return null;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as LockInfo;
      if (!raw || typeof raw.taskId !== 'string' || typeof raw.pid !== 'number') return null;
      return raw;
    } catch {
      return null; // битый lock — считаем отсутствующим
    }
  }

  private isFresh(ext: LockInfo): boolean {
    if (ext.pid === process.pid) return true; // наш pid — решает ин-процесс состояние
    if (!pidAlive(ext.pid)) return false; // процесс мёртв — lock протух
    return Date.now() - (ext.hb ?? 0) < this.staleMs;
  }

  /**
   * Предстартовая проверка: есть ли ЖИВАЯ задача в этом процессе или в другом
   * (по lock-файлу). Мёртвые/протухшие lock'и не блокируют (и убираются).
   */
  preflightCheck(): { ok: boolean; blocker?: BusyBlocker } {
    if (this.current) {
      return { ok: false, blocker: { taskId: this.current.taskId, owner: this.current.owner, pid: this.current.pid, external: false } };
    }
    const ext = TaskHub.readLockFile(resolve(this.lockPath, '..'));
    if (ext && this.isFresh(ext)) {
      return { ok: false, blocker: { taskId: ext.taskId, owner: ext.owner, pid: ext.pid, external: ext.pid !== process.pid } };
    }
    return { ok: true };
  }

  /**
   * Атомарная (по возможности) постановка lock-файла: флаг 'wx' падает, если
   * файл уже появился между проверкой и записью; тогда перечитываем и, если
   * он свежий — отказ. Протухший — сносим и ставим свой.
   */
  private claimLock(taskId: string, startedAt: string): void {
    for (let attempt = 0; attempt < 3; attempt++) {
      const info: LockInfo = { taskId, owner: this.owner, pid: process.pid, startedAt, hb: Date.now() };
      try {
        writeFileSync(this.lockPath, JSON.stringify(info, null, 2), { encoding: 'utf8', flag: 'wx' });
        return;
      } catch (e: any) {
        if (e && e.code === 'EEXIST') {
          const ext = TaskHub.readLockFile(resolve(this.lockPath, '..'));
          if (ext && this.isFresh(ext) && ext.pid !== process.pid) {
            throw new Error(`занято другим процессом: ${ext.owner}/pid ${ext.pid}, задача ${ext.taskId}`);
          }
          try { unlinkSync(this.lockPath); } catch { /* уже снесён соседом */ }
          continue;
        }
        throw e;
      }
    }
    throw new Error('lock: не удалось постановить task.lock.json за 3 попытки');
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.hbTimer = setInterval(() => {
      try {
        const info: LockInfo = { taskId: this.current!.taskId, owner: this.owner, pid: process.pid, startedAt: this.current!.startedAt, hb: Date.now() };
        writeFileSync(this.lockPath, JSON.stringify(info, null, 2), 'utf8');
      } catch { /* heartbeat не должен ронять задачу */ }
    }, this.heartbeatMs);
    this.hbTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
  }

  /** --- Реестр задач (память + tasks.json) --------------------------------- */

  private readRecords(): Record<string, TaskRecord> {
    if (!existsSync(this.recordsPath)) return {};
    try {
      return JSON.parse(readFileSync(this.recordsPath, 'utf8')) as Record<string, TaskRecord>;
    } catch {
      return {};
    }
  }

  private persistRecord(rec: TaskRecord): void {
    try {
      const all = this.readRecords();
      all[rec.taskId] = rec;
      // держим последние 50 задач, старые выметаем
      const keys = Object.keys(all).sort();
      while (keys.length > 50) {
        const k = keys.shift()!;
        if (k !== rec.taskId) delete all[k];
      }
      writeFileSync(this.recordsPath, JSON.stringify(all, null, 2), 'utf8');
    } catch { /* реестр — не критичный путь */ }
  }

  /** Рекорд задачи: из памяти этого процесса, иначе из tasks.json (чужой процесс). */
  loadRecord(taskId: string | null | undefined): TaskRecord | null {
    if (this.current && (!taskId || this.current.taskId === taskId)) return this.current;
    const all = this.readRecords();
    if (taskId) return all[taskId] ?? null;
    // без taskId — самая свежая задача (по startedAt)
    const list = Object.values(all).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return list[0] ?? null;
  }

  /** --- Жизненный цикл ------------------------------------------------------ */

  /**
   * Уникальный taskId формата task_<ts> (как в server.ts); при коллизии —
   * суффикс -2/-3 по реестру.
   */
  nextTaskId(now: number = Date.now()): string {
    let base = 'task_' + now;
    const all = this.readRecords();
    if (!all[base] && (!this.current || this.current.taskId !== base)) return base;
    for (let n = 2; n < 100; n++) {
      const cand = `${base}-${n}`;
      if (!all[cand]) return cand;
    }
    return base + '_' + randomBytes(3).toString('hex');
  }

  /** Начало задачи: ин-процесс состояние + lock + heartbeat + реестр. */
  begin(rec: TaskRecord): void {
    if (this.current) {
      throw new Error(`занято в этом процессе: ${this.current.owner}/${this.current.taskId}`);
    }
    this.claimLock(rec.taskId, rec.startedAt);
    this.current = rec;
    this.stopSignal = { stopped: false };
    this.pendingConfirm = null;
    this.startHeartbeat();
    this.persistRecord(rec);
  }

  /** Периодическая синхронизация текущего рекорда в tasks.json (шаги/прогресс). */
  flushCurrent(): void {
    if (this.current) this.persistRecord(this.current);
  }

  /** Завершение задачи: статус/финиш в реестр, lock снят, heartbeat остановлен. */
  finish(rec: TaskRecord): void {
    rec.status = rec.status === 'RUNNING' ? 'FAILED' : rec.status;
    rec.finishedAt = rec.finishedAt ?? new Date().toISOString();
    this.current = null;
    this.stopSignal = null;
    this.pendingConfirm = null;
    this.stopHeartbeat();
    try {
      const ext = TaskHub.readLockFile(resolve(this.lockPath, '..'));
      if (ext && ext.pid === process.pid && ext.taskId === rec.taskId) unlinkSync(this.lockPath);
    } catch { /* lock мог быть снесён */ }
    this.persistRecord(rec);
  }

  /**
   * Отмена оператора. Контракт (спека 1.3): отмена оператора = SKIP —
   * стоп-сигнал поднимается, висящий confirm разрешается как «false»
   * (движок трактует как «шаг отменён оператором» → статус skip).
   */
  stopOperator(): boolean {
    if (!this.current && !this.pendingConfirm) return false;
    if (this.stopSignal) this.stopSignal.stopped = true;
    if (this.pendingConfirm) {
      try { this.pendingConfirm.resolve(false); } catch { /* no-op */ }
      this.pendingConfirm = null;
    }
    return true;
  }

  answerConfirm(answer: boolean): boolean {
    if (!this.pendingConfirm) return false;
    const p = this.pendingConfirm;
    this.pendingConfirm = null;
    try { p.resolve(answer); } catch { /* no-op */ }
    return true;
  }

  /** Запрос подтверждения шага (вешает pendingConfirm, возвращает промис). */
  requestConfirm(taskId: string, i: number, kind: string): Promise<boolean> {
    return new Promise<boolean>((res) => {
      this.pendingConfirm = { resolve: res, taskId, i, kind };
    });
  }
}
