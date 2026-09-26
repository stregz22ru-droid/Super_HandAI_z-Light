// base2/modeGate.ts — B1: ПОЛИТИКИ переключения режима (modeStore хранит,
// modeGate решает).
//  • manual → autopilot: только при agent.idle (нет активных/queued задач).
//  • autopilot → manual: drain-политика — режим применяется ПОСЛЕ завершения
//    активной задачи агента (активная задача доезжает, новые обороты мост
//    уже не подаёт — он читает целевой режим сразу).
//  • Переключение при открытой confirm-панели агента — БЛОКИРУЕТСЯ.
//  • Атрибуция origin в каждой записи журнала (by= — кто переключил).
//  • MCP — read-only: метода setMode в MCP-канале нет (agentLink не экспортирует).
import { getSlotBus } from './slotBus.js';
import { BusEvents, type AgentMode, type TaskFinishedEvent } from './types.js';
import type { ModeStore } from './modeStore.js';
import type { TaskService } from './taskService.js';

export type TransitionResult =
  | { ok: true; applied: true; agentId: string; mode: AgentMode }
  | { ok: true; applied: false; pendingDrain: true; agentId: string; mode: AgentMode; reason: string }
  | { ok: false; agentId: string; reason: string };

export class ModeGate {
  private pendingDrain = new Set<string>();
  private offTaskFinished: () => void;

  constructor(
    private store: ModeStore,
    private tasks: TaskService | null,
  ) {
    const bus = getSlotBus();
    // Drain: после завершения ЛЮБОЙ задачи проверяем ожидающие переключения.
    this.offTaskFinished = bus.on<TaskFinishedEvent>(BusEvents.taskFinished, () => {
      this.flushDrain();
    });
  }

  /** Отписка (для тестов). */
  dispose(): void {
    this.offTaskFinished();
    this.pendingDrain.clear();
  }

  /** Запрос переключения режима агента. by — атрибуция ('ui'|'mcp'|...). */
  request(agentId: string, target: AgentMode, by: string, reason?: string): TransitionResult {
    const current = this.store.getMode(agentId);
    if (current === target) {
      return { ok: true, applied: true, agentId, mode: target };
    }

    // Блок: открытая confirm-панель у активной задачи этого агента.
    if (this.tasks?.pendingConfirmFor(agentId)) {
      return { ok: false, agentId, reason: 'переключение заблокировано: открыта confirm-панель задачи агента' };
    }

    if (target === 'autopilot') {
      // Вход в автопилот — только при idle.
      if (this.tasks && !this.tasks.isIdle(agentId)) {
        return { ok: false, agentId, reason: 'агент не idle: manual→autopilot возможен только без активных/queued задач' };
      }
      const r = this.store.setMode(agentId, target, { by, reason });
      return r.ok
        ? { ok: true, applied: true, agentId, mode: target }
        : { ok: false, agentId, reason: r.error ?? 'config.mode не записан' };
    }

    // autopilot → manual: drain-политика.
    const busy = this.tasks ? !this.tasks.isIdle(agentId) : false;
    if (!busy) {
      const r = this.store.setMode(agentId, target, { by, reason: reason ?? 'drain: агент был idle' });
      this.pendingDrain.delete(agentId);
      return r.ok
        ? { ok: true, applied: true, agentId, mode: target }
        : { ok: false, agentId, reason: r.error ?? 'config.mode не записан' };
    }
    // Занят: режим применится после завершения активной задачи (drain).
    this.pendingDrain.add(agentId);
    return {
      ok: true,
      applied: false,
      pendingDrain: true,
      agentId,
      mode: target,
      reason: 'drain: режим будет применён после завершения активной задачи',
    };
  }

  private flushDrain(): void {
    if (this.pendingDrain.size === 0) return;
    for (const agentId of [...this.pendingDrain]) {
      if (!this.tasks || this.tasks.isIdle(agentId)) {
        this.pendingDrain.delete(agentId);
        const r = this.store.setMode(agentId, 'manual', { by: 'drain', reason: 'активная задача завершена' });
        if (!r.ok) {
          // не критично: попытка повторится на следующем task.finished
          this.pendingDrain.add(agentId);
        }
      }
    }
  }

  /** Ожидает ли агент drain-переключения (для маршрута диагностики). */
  isPendingDrain(agentId: string): boolean {
    return this.pendingDrain.has(agentId);
  }
}
