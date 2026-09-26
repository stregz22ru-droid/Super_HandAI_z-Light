// base2/atomic.ts — атомарные и append-only записи состояния (K5-гигиена).
// Все записи состояния Base-этапа 2 идут через эти хелперы: атомарный JSON
// (tmp+rename, Windows-safe: MoveFileEx с заменой) и append-only JSONL.
import { existsSync, mkdirSync, readFileSync, renameSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Атомарная запись JSON: mkdir → tmp-файл → rename поверх цели. */
export function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + randomBytes(4).toString('hex');
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, file);
}

/** Append-only строка JSONL. Ошибка диска НЕ роняет вызывающий код (журналы —
 *  наблюдаемость, не бизнес-логика), но возвращается для диагностики. */
export function appendJsonl(file: string, obj: unknown): { ok: boolean; error?: string } {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Чтение JSON с fallback (битый/отсутствующий файл не роняет загрузку). */
export function readJsonSafe<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Чтение сырого JSON-объекта конфига (без merge) — для read-modify-write одного ключа. */
export function readRawJsonObject(file: string): Record<string, unknown> {
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
