// proto.ts — протокол WS-сообщений между UI и агентом.
// Клиент → сервер
export type ClientMsg =
  | { type: 'auth'; token: string }
  | { type: 'task.start'; tzText: string }
  | { type: 'task.stop' }
  | { type: 'task.pause' }
  | { type: 'task.resume' }
  | { type: 'confirm.answer'; id: string; answer: boolean | string };

// Сервер → клиент
export type StepState = 'run' | 'ok' | 'fail' | 'skip' | 'denied' | 'confirm';
export type TaskStatus = 'SUCCESS' | 'PARTIAL' | 'STOPPED' | 'DENIED';

export type ServerMsg =
  | { type: 'task.accepted'; taskId: string; steps: { i: number; title: string }[] }
  | { type: 'step.status'; i: number; state: StepState; exit?: number; ms?: number; msg?: string }
  | { type: 'pty.data'; task: string; data: string }
  | { type: 'pty.write'; task: string; data: string }
  | { type: 'pty.resize'; cols: number; rows: number }
  | {
      type: 'confirm.request';
      id: string;
      kind: 'deny' | 'ask';
      text: string;
      options?: string[];
    }
  | { type: 'task.done'; status: TaskStatus; reportMd: string }
  | { type: 'lint.result'; issues: { line: number; level: 'error' | 'warn'; msg: string }[] };

export function encode(msg: ServerMsg): string {
  return JSON.stringify(msg);
}

export function decode<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
