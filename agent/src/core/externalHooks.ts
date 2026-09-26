// core/externalHooks.ts — внешние хуки сессии с Windows-гигиеной.
// Источник паттернов: Ponytail v4.9.0, tests/hooks-windows.test.js (MIT,
// (c) 2026 DietrichGebert) — см. THIRD-PARTY-NOTICES.md. Заимствуются ПАТТЕРНЫ,
// не предметный контент. Правила гигиены (спека Этапа 1, п. 2.4):
//   1) plain node: скрипт запускается как [process.execPath, <путь>],
//      shell: false — никаких exec/&&/cmd.exe (камни #593/#527/#569 донора);
//   2) allowlist путей: исполняются ТОЛЬКО файлы *.hook.js, лежащие прямо в
//      каталоге хуков (без подкаталогов, без абсолютных путей снаружи);
//   3) BOM-strip на входе: вывод хука чистится от U+FEFF в начале;
//   4) CRLF-толерантность: \r\n и \r нормализуются к \n;
//   5) never-block: бюджет времени на хук; зависший убивается, цикл задачи
//      продолжается (silent fail — ошибка пишется в журнал, не бросается).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export interface ExternalHookResult {
  file: string;          // имя файла (без пути)
  ok: boolean;           // exit=0 и не таймаут
  lines: string[];       // нормализованный stdout (BOM-strip, CRLF→LF, непустые)
  error?: string;
  durationMs: number;
  timedOut?: boolean;
  exitCode?: number | null;
}

export interface ExternalHooksReport {
  ran: ExternalHookResult[];
  /** Плоский список строк контекста (по ≤2000 символов) для additionalContext. */
  lines: string[];
}

const HOOK_NAME_RE = /^[a-z0-9][a-z0-9._-]*\.hook\.js$/;
const MAX_LINES_PER_HOOK = 50;
const MAX_LINE_LEN = 2000;

/** BOM-strip + CRLF-нормализация + разбиение на непустые строки. */
export function normalizeHookOutput(raw: string): string[] {
  let s = raw;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // BOM
  s = s.replace(/\r\n?/g, '\n'); // CRLF и одиночный CR
  return s
    .split('\n')
    .map((l) => l.replace(/\u0000/g, '').trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(0, MAX_LINES_PER_HOOK)
    .map((l) => (l.length > MAX_LINE_LEN ? l.slice(0, MAX_LINE_LEN) + '…' : l));
}

/**
 * Allowlist-листинг: только имена вида *.hook.js из корня каталога хуков.
 * Подкаталоги, скрытые файлы и всё вне каталога игнорируются.
 */
export function listExternalHooks(hooksDir: string): string[] {
  if (!existsSync(hooksDir)) return [];
  try {
    return readdirSync(hooksDir, { withFileTypes: true })
      .filter((d) => d.isFile() && HOOK_NAME_RE.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Запуск ОДНОГО хука: plain node, без шелла, с бюджетом времени. */
export function runExternalHook(
  scriptPath: string,
  opts: { hooksDir: string; budgetMs: number; cwd?: string },
): Promise<ExternalHookResult> {
  const startedAt = Date.now();
  const file = resolve(scriptPath).split(sep).pop() ?? scriptPath;
  const base: ExternalHookResult = { file, ok: false, lines: [], durationMs: 0 };

  // Allowlist: файл обязан лежать ПРЯМО в каталоге хуков.
  const dirAbs = resolve(opts.hooksDir);
  const scriptAbs = resolve(scriptPath);
  if (!scriptAbs.startsWith(dirAbs + sep)) {
    return Promise.resolve({ ...base, error: 'путь вне каталога хуков (allowlist): ' + scriptPath });
  }
  if (!HOOK_NAME_RE.test(file)) {
    return Promise.resolve({ ...base, error: 'имя не проходит allowlist (*.hook.js): ' + file });
  }

  return new Promise<ExternalHookResult>((res) => {
    let out = '';
    let killed = false;
    let settled = false;
    // plain node: [process.execPath, script] — без shell, без аргументов, без &&.
    const child = spawn(process.execPath, [scriptAbs], {
      cwd: opts.cwd ?? dirAbs,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* уже мёртв */ }
    }, Math.max(1, opts.budgetMs));

    const finish = (r: Partial<ExternalHookResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ ...base, durationMs: Date.now() - startedAt, ...r } as ExternalHookResult);
    };

    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.on('error', (e) => {
      finish({ ok: false, error: 'spawn: ' + (e instanceof Error ? e.message : String(e)) });
    });
    child.on('close', (code, signal) => {
      const lines = normalizeHookOutput(out);
      if (killed || signal === 'SIGKILL' || signal === 'SIGTERM') {
        finish({ ok: false, timedOut: true, lines, error: `бюджет ${opts.budgetMs}ms исчерпан — хук убит (never-block)` });
        return;
      }
      finish({ ok: code === 0, lines, exitCode: code, error: code === 0 ? undefined : `exit=${code}` });
    });
  });
}

/**
 * Сессийный прогон всех внешних хуков каталога (вызывается из stepEngine на
 * onSessionStart). Ошибки НИКОГДА не бросаются — silent fail + журнал.
 */
export async function runExternalHooksOnSessionStart(
  hooksDir: string,
  budgetMs: number,
): Promise<ExternalHooksReport> {
  const files = listExternalHooks(hooksDir);
  const ran: ExternalHookResult[] = [];
  for (const f of files) {
    try {
      ran.push(await runExternalHook(resolve(hooksDir, f), { hooksDir, budgetMs }));
    } catch (e) {
      ran.push({ file: f, ok: false, lines: [], durationMs: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const lines: string[] = [];
  for (const r of ran) {
    for (const l of r.lines) lines.push(`[hook:${r.file}] ${l}`);
  }
  return { ran, lines };
}
