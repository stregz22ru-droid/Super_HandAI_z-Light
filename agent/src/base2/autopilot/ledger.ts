// base2/autopilot/ledger.ts — B3: журнал оборотов и вердиктов с отпечатками
// отказов (K4) и изоляцией по инициатору (K9): отпечатки каждого инициатора
// считаются ОТДЕЛЬНО (экземпляр Ledger на разговор/чат).
// K4: fingerprint = норм. четвёрка [номер шага, класс отказа, exit-code, норм. сообщение].
import { fingerprintKey, type Fingerprint, type FailClass } from '../types.js';
import type { TaskRecord } from '../../core/taskHub.js';

export interface TurnRecord {
  n: number;
  taskId: string;
  ts: string;
  engineStatus: 'SUCCESS' | 'PARTIAL' | 'STOPPED' | 'DENIED';
  fingerprint?: Fingerprint;
  reportFile?: string;
}

/** Нормализация сообщения отпечатка: без абсолютных путей, регистр и пробелы схлопнуты. */
export function normalizeFpMessage(msg: string): string {
  return String(msg ?? '')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"`<>|]{2,}/g, '<ПУТЬ>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 300);
}

/** Отпечаток K4 из карточки задачи: первый неуспешный шаг. */
export function fingerprintOf(record: TaskRecord): Fingerprint | null {
  const steps = record.steps ?? [];
  const bad = steps.find((s) => s.status === 'fail' || s.status === 'denied');
  if (!bad) {
    // Отказ без шагов (engine error / STOPPED на старте).
    if (record.state === 'failed' && record.error) {
      return { step: 0, cls: 'EXIT', exitCode: null, message: normalizeFpMessage(record.error) };
    }
    return null;
  }
  let cls: FailClass;
  if (bad.status === 'denied') cls = 'GUARD';
  else if ((bad.failReason ?? '').includes('таймаут')) cls = 'TIMEOUT';
  else if ((bad.failReason ?? '').startsWith('EXPECT')) cls = 'EXPECT';
  else cls = 'EXIT';
  return {
    step: bad.i,
    cls,
    exitCode: bad.exitCode ?? null,
    message: normalizeFpMessage(bad.failReason ?? ('exit=' + (bad.exitCode ?? '-'))),
  };
}

export class Ledger {
  private turns: TurnRecord[] = [];

  /** Добавить оборот; возвращает статистику подряд. */
  addTurn(t: Omit<TurnRecord, 'n'>): {
    consecutiveSame: number;
    turnsSinceSuccess: number;
    total: number;
  } {
    const n = this.turns.length + 1;
    this.turns.push({ ...t, n });
    return {
      consecutiveSame: this.consecutiveSameFingerprints(),
      turnsSinceSuccess: this.turnsSinceSuccess(),
      total: this.turns.length,
    };
  }

  /** Сколько ПОСЛЕДНИХ отпечатков совпадают подряд (K4/K9). */
  consecutiveSameFingerprints(): number {
    const fps = this.turns.map((t) => (t.fingerprint ? fingerprintKey(t.fingerprint) : null));
    let i = fps.length - 1;
    if (i < 0 || fps[i] === null) return 0;
    const last = fps[i];
    let count = 0;
    while (i >= 0 && fps[i] === last) {
      count++;
      i--;
    }
    return count;
  }

  /** Оборотов с последнего SUCCESS (или с начала петли). */
  turnsSinceSuccess(): number {
    let count = 0;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].engineStatus === 'SUCCESS') break;
      count++;
    }
    return count;
  }

  /** K последних оборотов (для сводки эскалации K7). */
  lastK(k: number): TurnRecord[] {
    return this.turns.slice(-Math.max(1, k));
  }

  all(): TurnRecord[] {
    return [...this.turns];
  }

  get length(): number {
    return this.turns.length;
  }

  serialize(): TurnRecord[] {
    return this.turns;
  }

  load(records: TurnRecord[]): void {
    this.turns = records.map((r) => ({ ...r }));
  }
}
