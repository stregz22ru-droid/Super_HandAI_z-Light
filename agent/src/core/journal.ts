// core/journal.ts — append-only журнал действий.
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface JournalEntry {
  ts: string;
  taskId: string;
  step: number;
  action: string;
  exit?: number;
  durationMs?: number;
  note?: string;
}

let journalPath: string | null = null;

function resolveJournalPath(): string {
  if (journalPath) return journalPath;
  // dist/core/journal.js → __dirname = agent/dist/core → root = __dirname/../../..
  // src/core/journal.ts → __dirname = agent/src/core → root = __dirname/../../..
  const root = resolve(__dirname, '..', '..', '..');
  const p = resolve(root, 'data', 'state', 'journal.jsonl');
  mkdirSync(dirname(p), { recursive: true });
  journalPath = p;
  return p;
}

export function journalTail(n: number): JournalEntry[] {
  const p = resolveJournalPath();
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  const tail = lines.slice(-Math.max(1, n));
  const out: JournalEntry[] = [];
  for (const line of tail) {
    try { out.push(JSON.parse(line) as JournalEntry); } catch { out.push({ ts: new Date().toISOString(), taskId: '(битая запись)', step: 0, action: '(битая запись)' }); }
  }
  return out;
}

export function journalAppend(entry: JournalEntry): void {
  const p = resolveJournalPath();
  appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8');
}

// Сброс пути (для тестов).
export function _setJournalPathForTest(p: string | null): void {
  journalPath = p;
}
