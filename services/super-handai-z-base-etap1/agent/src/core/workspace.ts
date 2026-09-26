// core/workspace.ts — общая очистка workspace (используется HTTP /workspace/purge
// и MCP-инструментом purge_workspace; одна реализация — одинаковая семантика).
import { readdir, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/**
 * Удаляет ВСЕ записи внутри workspaceRoot (содержимое, не сам корень).
 * Возвращает число удалённых записей. Защиту активной задачи выполняет
 * вызывающая сторона (TaskHub.preflightCheck) — здесь только файловая работа.
 */
export async function purgeWorkspace(workspaceRoot: string): Promise<number> {
  const root = resolve(workspaceRoot);
  const entries = await readdir(root, { withFileTypes: true });
  let removed = 0;
  for (const e of entries) {
    const full = resolve(root, e.name);
    if (!full.startsWith(root + sep) && full !== root) continue; // страховка от выхода за корень
    await rm(full, { recursive: true, force: true });
    removed++;
  }
  return removed;
}
