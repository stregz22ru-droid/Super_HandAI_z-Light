// base2/autopilot/fsmPersist.ts — B3 (K5): персистентность FSM автопилота.
// data/autopilot-state.json, атомарная запись (tmp+rename), восстановление
// после падения: петли, счётчики оборотов, отпечатки и дедуп-хэши выживают.
import { resolve as resolvePath } from 'node:path';
import { writeJsonAtomic, readJsonSafe } from '../atomic.js';
import type { TurnRecord } from './ledger.js';

export type LoopState = 'turn-running' | 'await-answer' | 'stopped';

export interface LoopSnapshot {
  conversationKey: string;
  chatId: string;
  agentId: string;
  state: LoopState;
  turn: number;
  startedAt: string;
  updatedAt: string;
  stopReason?: string;
  completeRequested?: boolean;
  pendingTaskId?: string;
  turns: TurnRecord[];
}

export interface AutopilotStateFile {
  version: 1;
  loops: LoopSnapshot[];
  dedups: Record<string, string[]>;
}

export class FsmPersist {
  private file: string;

  constructor(root: string) {
    this.file = resolvePath(root, 'data', 'autopilot-state.json');
  }

  get path(): string {
    return this.file;
  }

  write(state: AutopilotStateFile): void {
    writeJsonAtomic(this.file, state);
  }

  read(): AutopilotStateFile {
    return readJsonSafe<AutopilotStateFile>(this.file, { version: 1, loops: [], dedups: {} });
  }
}
