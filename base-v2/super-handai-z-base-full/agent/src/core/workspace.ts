// core/workspace.ts — корень workspace и его очистка (Base Этап 1).
// Логика вынесена из server.ts без изменения семантики: удаляются все
// НЕПОСРЕДСТВЕННЫЕ записи корня workspace (recursive+force), выход за
// пределы корня отсекается проверкой startsWith(root + sep).
import { readdir, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export interface PurgeResult {
  ok: boolean;
  removed?: number;
  error?: string;
}

/** Нормализованный абсолютный корень workspace из конфига. */
export function workspaceRootOf(cfgWorkspaceRoot: string): string {
  return resolve(cfgWorkspaceRoot);
}

/** Полная очистка workspace (Долг N18). Вызывающий обязан заранее проверить,
 *  что активная задача не исполняется (TaskHub.isBusy()). */
export async function purgeWorkspace(root: string): Promise<PurgeResult> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    let removed = 0;
    for (const e of entries) {
      const full = resolve(root, e.name);
      if (!full.startsWith(root + sep) && full !== root) continue;
      await rm(full, { recursive: true, force: true });
      removed++;
    }
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
