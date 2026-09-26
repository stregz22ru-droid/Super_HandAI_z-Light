// base2/slotBus.ts — подписываемые слоты-события (П-4).
// autopilot-FSM и taskService эмитят state.changed / loop.stopped /
// escalation.raised / task.started / task.finished сюда; будущие подписчики
// (WCP-канал, другие агенты, память) подключаются БЕЗ правки эмиттеров.
// Паттерн повторяет контракт слотов ядра: ошибка одного подписчика не роняет
// остальных и не роняет эмиттер.
export type SlotHandler<T = unknown> = (payload: T) => void | Promise<void>;

export class SlotBus {
  private handlers = new Map<string, Set<SlotHandler>>();

  /** Подписка; возвращает функцию отписки. */
  on<T>(name: string, handler: SlotHandler<T>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as SlotHandler);
    return () => set!.delete(handler as SlotHandler);
  }

  /** Эмит: все подписчики получают payload, ошибки изолируются (console.error). */
  async emit<T>(name: string, payload: T): Promise<void> {
    const set = this.handlers.get(name);
    if (!set || set.size === 0) return;
    for (const h of [...set]) {
      try {
        await h(payload);
      } catch (e) {
        console.error('[base2:slot] обработчик "' + name + '" упал: ' + (e instanceof Error ? e.message : String(e)));
      }
    }
  }

  listenerCount(name: string): number {
    return this.handlers.get(name)?.size ?? 0;
  }

  clear(): void {
    this.handlers.clear();
  }
}

// Синглтон: все модули процесса (ядро, фичи, base2) разделяют одну шину.
let bus: SlotBus | null = null;

export function getSlotBus(): SlotBus {
  if (!bus) bus = new SlotBus();
  return bus;
}

/** Для тестов: полный сброс шины. */
export function resetSlotBus(): void {
  if (bus) bus.clear();
  bus = null;
}
