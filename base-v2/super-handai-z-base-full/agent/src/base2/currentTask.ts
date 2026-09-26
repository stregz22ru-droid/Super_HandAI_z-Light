// base2/currentTask.ts — контекст исполняемой задачи (AsyncLocalStorage).
// Нужен, чтобы фичи (например, check-directive в слоте beforeRun) знали,
// какая задача/origin сейчас исполняется, БЕЗ расширения сигнатуры слотов ядра:
// stepEngine вызывает featuresBeforeRun(i, directive) — контракт не меняется.
// AsyncLocalStorage безопасен при параллельных задачах (П-1): у каждого
// executeDoc свой контекст, промисы не перетирают друг друга.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface CurrentTaskContext {
  taskId: string;
  conversationKey: string;
  origin: { type: string; agentId: string };
  mode: string;
}

const als = new AsyncLocalStorage<CurrentTaskContext>();

/** Выполнить fn внутри контекста задачи. */
export function runWithTask<T>(ctx: CurrentTaskContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

/** Контекст текущей задачи или null (вне исполнения). */
export function getCurrentTask(): CurrentTaskContext | null {
  return als.getStore() ?? null;
}
