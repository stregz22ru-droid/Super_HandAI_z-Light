// proto.ts — протокол WS-сообщений между UI и агентом.
// ЭТАП 2: добавлены task.result/mode.*/glm.ingest/autopilot.* — аддитивно,
// старые сообщения не изменились.
// Клиент → сервер
export type ClientMsg =
  | { type: 'auth'; token: string }
  | { type: 'task.start'; tzText: string; reqId?: string; origin?: { type: string; agentId?: string }; sessionId?: string; conversationId?: string }
  | { type: 'task.stop'; taskId?: string }
  | { type: 'task.pause' }
  | { type: 'task.resume' }
  | { type: 'confirm.answer'; id: string; answer: boolean | string; taskId?: string }
  // ==== ЭТАП 2 (аддитивно) ====
  | { type: 'ping'; reqId?: string }
  | { type: 'status.get'; taskId: string; reqId?: string }
  | { type: 'mode.get'; agentId?: string; reqId?: string }
  | { type: 'mode.set'; agentId: string; mode: 'manual' | 'autopilot'; reqId?: string }
  | { type: 'mode.list'; reqId?: string }
  | { type: 'glm.ingest'; answerText: string; chatId: string; agentId?: string; reqId?: string }
  | { type: 'autopilot.state'; reqId?: string };

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
      kind: 'deny' | 'ask' | 'RUN' | 'RUN_BG';
      text: string;
      options?: string[];
      taskId?: string;
    }
  | { type: 'task.done'; status: TaskStatus; reportMd: string; taskId?: string }
  | { type: 'lint.result'; issues: { line: number; level: 'error' | 'warn'; msg: string }[] }
  // ==== ЭТАП 2 (аддитивно) ====
  | { type: 'pong'; reqId?: string }
  | { type: 'task.result'; reqId?: string; ok: boolean; taskId?: string; error?: string; task?: unknown }
  | { type: 'mode.result'; reqId?: string; ok: boolean; agentId?: string; mode?: string; applied?: boolean; pendingDrain?: boolean; modes?: Record<string, string>; error?: string }
  | { type: 'ingest.result'; reqId?: string; ok: boolean; outcome?: string; taskId?: string; reason?: string }
  | { type: 'autopilot.state.result'; reqId?: string; loops?: unknown[] }
  | { type: 'mode.changed'; agentId: string; from: string; to: string; by: string; ts: string }
  | { type: 'autopilot.outbox'; kind: 'turn-report' | 'escalation' | 'hint' | 'help-request'; chatId: string; agentId?: string; toAgent?: string; fromAgent?: string; turn?: number; engineStatus?: string; text: string; truncated?: boolean };

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
