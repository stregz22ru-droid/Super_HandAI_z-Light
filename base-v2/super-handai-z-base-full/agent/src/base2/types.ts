// base2/types.ts — общие типы Base-этапа 2 (режим/автопилот/память/CHECK).
// Слой не зависит от ядра: только чистые типы и константы.

/** Тип инициатора задачи (П-1). 'autopilot-help' добавлен директивой
 *  «Эскалация-к-агенту»: ответ помощника возвращается в петлю с этим origin. */
export type OriginType = 'human' | 'autopilot' | 'mcp' | 'help-request' | 'autopilot-help';

export interface TaskOrigin {
  type: OriginType;
  agentId: string;
}

/** Origin-типы, разрешённые С ПРОВОДА (WS/HTTP). 'autopilot', 'help-request'
 *  и 'autopilot-help' присваиваются только ВНУТРИ процесса (bridge/escalation) —
 *  внешний клиент не может выдать себя за автопилот. */
export const WIRE_ORIGIN_TYPES: readonly OriginType[] = ['human', 'mcp'];

export function sanitizeWireOrigin(raw: unknown): TaskOrigin {
  const o = (raw ?? {}) as { type?: unknown; agentId?: unknown };
  const type: OriginType =
    typeof o.type === 'string' && (WIRE_ORIGIN_TYPES as readonly string[]).includes(o.type)
      ? (o.type as OriginType)
      : 'human';
  const agentId = typeof o.agentId === 'string' && o.agentId.trim() !== '' ? o.agentId.trim().slice(0, 64) : 'operator';
  return { type, agentId };
}

/** Режим агента (П-2): per-agent карта, дефолт — manual (безопасный). */
export type AgentMode = 'manual' | 'autopilot';
export const MODES: readonly AgentMode[] = ['manual', 'autopilot'];
export const DEFAULT_AGENT_ID = 'operator';
export const DEFAULT_MODE: AgentMode = 'manual';

/** Класс отказа для отпечатка K4. */
export type FailClass = 'EXPECT' | 'EXIT' | 'GUARD' | 'TIMEOUT' | 'INTERRUPTED';

/** Отпечаток отказа K4: нормализованная четвёрка. */
export interface Fingerprint {
  step: number;
  cls: FailClass;
  exitCode: number | null;
  message: string;
}

export function fingerprintKey(fp: Fingerprint): string {
  return `${fp.step}|${fp.cls}|${fp.exitCode ?? '-'}|${fp.message}`;
}

/** События шины слотов (slotBus) — единственные имена, на которые можно подписываться. */
export const BusEvents = {
  taskStarted: 'task.started',
  taskFinished: 'task.finished',
  modeChanged: 'mode.changed',
  autopilotState: 'autopilot.state.changed',
  autopilotStopped: 'autopilot.loop.stopped',
  autopilotEscalation: 'autopilot.escalation.raised',
} as const;

export interface TaskStartedEvent {
  taskId: string;
  conversationKey: string;
  origin: TaskOrigin;
}

export interface TaskFinishedEvent {
  taskId: string;
  conversationKey: string;
  origin: TaskOrigin;
  state: string;
  engineStatus?: string;
  reportPath?: string;
  reportMd?: string;
  workspace?: string;
  error?: string;
}

export interface ModeChangedEvent {
  agentId: string;
  from: AgentMode;
  to: AgentMode;
  by: string;
  ts: string;
}
