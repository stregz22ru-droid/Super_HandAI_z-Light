// core/ptyManager.ts — обёртка над @lydell/node-pty с ленивым импортом.
// На тестах можно подменить через injectPtyImpl.
import { spawnSync } from 'node:child_process';
import { spawn, type IPty } from '@lydell/node-pty';

export interface PtyRunOptions {
  cmd: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  cols?: number;
  rows?: number;
}

export interface PtyRunEvents {
  onData?: (data: string) => void;
  onExit?: (code: number, signal?: number) => void;
}

export interface PtyRunResult {
  exitCode: number | null;
  output: string; // полный буфер (до 1 МБ в памяти для EXPECT/отчёта)
  durationMs: number;
  killedByTimeout: boolean;
}

export interface BgHandle {
  process: IPty;
  marker: string;
  output: string;
  found: boolean;
}

let ptyImpl: typeof import('@lydell/node-pty') | null = null;

export function injectPtyImpl(impl: typeof import('@lydell/node-pty') | null): void {
  ptyImpl = impl;
}

async function getPty(): Promise<typeof import('@lydell/node-pty')> {
  if (ptyImpl) return ptyImpl;
  try {
    const mod = (await import('@lydell/node-pty')) as unknown as typeof import('@lydell/node-pty');
    ptyImpl = mod;
    return mod;
  } catch (e) {
    throw new Error(
      'Не удалось загрузить @lydell/node-pty. Установите пакет: cd agent && npm install. ' +
        (e instanceof Error ? e.message : String(e)),
    );
  }
}

// Убийство ВСЕГО дерева процессов.
// ВАЖНО: proc.kill() на Windows терминирует только оболочку (pwsh/bash);
// её потомки (node dist/server.js и т.п.) выживают и продолжают держать порты.
// taskkill /T /F по PID оболочки убивает всё дерево. На POSIX — штатный kill.
function killTree(proc: IPty): void {
  const pid = proc.pid;
  if (process.platform === 'win32' && pid) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false });
    } catch {
      // ignore — ниже дублирующая попытка штатным kill
    }
  }
  try {
    proc.kill();
  } catch {
    // ignore
  }
}

// Запуск команды с ожиданием выхода и сбором вывода.
export async function run(
  opts: PtyRunOptions,
  events: PtyRunEvents = {},
): Promise<PtyRunResult> {
  const pty = await getPty();
  const startedAt = Date.now();
  const outputChunks: string[] = [];
  let fullSize = 0;
  const MAX = 1024 * 1024; // 1 МБ храним в памяти

  return new Promise<PtyRunResult>((resolveP) => {
    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number | null, killed: boolean) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      const output = outputChunks.join('');
      events.onExit?.(code ?? -1);
      resolveP({
        exitCode: code,
        output,
        durationMs: Date.now() - startedAt,
        killedByTimeout: killed,
      });
    };

    const proc = pty.spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      env: process.env as Record<string, string>,
    });

    proc.onData((data: string) => {
      outputChunks.push(data);
      fullSize += data.length;
      if (fullSize > MAX) {
        const joined = outputChunks.join('');
        outputChunks.length = 0;
        outputChunks.push(joined.slice(-MAX));
        fullSize = outputChunks[0].length;
      }
      events.onData?.(data);
    });

    proc.onExit(({ exitCode, signal }) => {
      finish(exitCode ?? null, false);
      if (signal) {
        // intentionally ignore
      }
    });

    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(proc);
        finish(null, true);
      }, opts.timeoutMs);
    }
  });
}

// Запуск фонового процесса.
export async function runBg(
  opts: Omit<PtyRunOptions, 'timeoutMs'>,
  marker: string,
  onData?: (data: string) => void,
): Promise<BgHandle> {
  const pty = await getPty();
  const output = '';
  const proc = pty.spawn(opts.cmd, opts.args, {
    cwd: opts.cwd,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    env: process.env as Record<string, string>,
  });
  const handle: BgHandle = {
    process: proc,
    marker,
    output,
    found: false,
  };
  proc.onData((data: string) => {
    handle.output += data;
    if (!handle.found && handle.marker && handle.output.includes(handle.marker)) {
      handle.found = true;
    }
    onData?.(data);
  });
  return handle;
}

// Ожидание маркера в выводе фонового процесса.
export async function waitFor(
  handle: BgHandle,
  timeoutMs: number,
): Promise<boolean> {
  if (handle.found) return true;
  const start = Date.now();
  return new Promise<boolean>((resolveWait) => {
    const interval = setInterval(() => {
      if (handle.found) {
        clearInterval(interval);
        resolveWait(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        clearInterval(interval);
        resolveWait(false);
      }
    }, 100);
  });
}

// Список активных фоновых процессов — для killAll.
const bgHandles: BgHandle[] = [];
export function trackBg(handle: BgHandle): void {
  bgHandles.push(handle);
}
export function killAll(): void {
  for (const h of bgHandles) {
    killTree(h.process);
  }
  bgHandles.length = 0;
}