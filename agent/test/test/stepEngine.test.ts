// test/stepEngine.test.ts — FakePty, без реального node-pty.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { executeDoc, type EngineResult } from '../src/core/stepEngine.js';
import type { AgentConfig } from '../src/config.js';
import { parseTz } from '../src/tz/parser.js';
import * as ptyManager from '../src/core/ptyManager.js';
import { _setJournalPathForTest } from '../src/core/journal.js';

// Fake IPty-совместимый объект
class FakeProc {
  dataCbs: ((data: string) => void)[] = [];
  exitCbs: ((e: { exitCode?: number; signal?: number }) => void)[] = [];
  killed = false;
  onData(cb: (data: string) => void) {
    this.dataCbs.push(cb);
  }
  onExit(cb: (e: { exitCode?: number; signal?: number }) => void) {
    this.exitCbs.push(cb);
  }
  kill() {
    this.killed = true;
  }
  emit(data: string) {
    for (const cb of this.dataCbs) cb(data);
  }
  exit(code: number) {
    for (const cb of this.exitCbs) cb({ exitCode: code });
  }
}

interface FakePlan {
  // Скрипт → ответ {data: string, exit: number, delayMs: number}
  // Совпадение проверяем по подстроке в скрипте.
  outputs: { match: string; data: string; exit: number; delayMs?: number }[];
}

function makeFakePty(plan: FakePlan) {
  return {
    spawn: vi.fn((file: string, args: string[], opts: any) => {
      const proc = new FakeProc();
      // Извлечь скрипт — последний аргумент (для bash -c это args[-1], для pwsh тоже -Command)
      const script = args[args.length - 1] ?? '';
      const match = plan.outputs.find((o) => script.includes(o.match));
      const delay = match?.delayMs ?? 1;
      setTimeout(() => {
        if (proc.killed) return;
        if (match?.data) proc.emit(match.data);
        proc.exit(match?.exit ?? 0);
      }, delay);
      return proc as unknown as FakeProc;
    }),
  } as unknown as typeof import('@lydell/node-pty');
}

let workspaceRoot: string;
let logDir: string;
let reportsDir: string;
let tmpRoot: string;
let originalPty: any = null;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'shz-'));
  workspaceRoot = join(tmpRoot, 'workspace');
  logDir = join(tmpRoot, 'logs');
  reportsDir = join(tmpRoot, 'reports');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  _setJournalPathForTest(join(tmpRoot, 'journal.jsonl'));
  originalPty = (ptyManager as any).ptyImpl;
});

afterEach(() => {
  ptyManager.injectPtyImpl(originalPty);
  rmSync(tmpRoot, { recursive: true, force: true });
  _setJournalPathForTest(null);
});

function cfgForTest(): AgentConfig {
  return {
    port: 8787,
    workspaceRoot,
    shells: {
      pwsh: { cmd: '/nonexistent/pwsh', args: ['-NoLogo', '-Command'] },
      bash: { cmd: '/nonexistent/bash', args: ['-c'] },
      pwshFallback: { cmd: 'powershell.exe', args: ['-NoLogo', '-Command'] },
      linuxBash: { cmd: '/bin/bash', args: ['-c'] },
    },
    stepTimeoutSec: 5,
    maxOutputBytes: 1048576,
    deny: [],
  };
}

async function runDoc(tz: string, fake?: FakePlan) {
  const cfg = cfgForTest();
  if (fake) {
    ptyManager.injectPtyImpl(makeFakePty(fake));
  } else {
    ptyManager.injectPtyImpl(null);
  }
  const parsed = parseTz(tz);
  expect(parsed.ok).toBe(true);
  const taskId = 'test_' + Date.now();
  const result = await executeDoc(
    parsed.doc!,
    cfg,
    taskId,
    {
      onStepStatus: () => {},
      onPtyData: () => {},
      onNote: () => {},
    },
    { stopped: false },
    logDir,
  );
  return { result, workspace: join(workspaceRoot, 'test-task') };
}

describe('stepEngine (FakePty)', () => {
  it('happy path из 3 шагов (RUN+EXPECT, WRITE+file exists, GIT)', async () => {
    const tz = `# ЗАДАЧ: Happy
# META
workdir: new:test-task
mode: auto
on_fail: stop
cycle: 1

## ШАГ 1. Первый
RUN shell: bash
\`\`\`bash
echo hello
\`\`\`
EXPECT exit=0
EXPECT stdout contains:hello

## ШАГ 2. Write
WRITE report.txt
\`\`\`text
hello world
\`\`\`
EXPECT file exists:report.txt

## ШАГ 3. GIT
GIT commit: "init: тест"
`;
    const fake: FakePlan = {
      outputs: [{ match: 'echo hello', data: 'hello\n', exit: 0 }],
    };
    const { result, workspace } = await runDoc(tz, fake);
    expect(result.status).toBe('SUCCESS');
    expect(result.results.length).toBe(3);
    expect(result.results[0].status).toBe('ok');
    expect(result.results[1].status).toBe('ok');
    expect(result.results[2].status).toBe('ok');
    // Файл должен существовать
    expect(existsSync(join(workspace, 'report.txt'))).toBe(true);
    expect(readFileSync(join(workspace, 'report.txt'), 'utf8')).toContain('hello world');
  });

  it('EXPECT fail при on_fail: stop → PARTIAL, последующие skip', async () => {
    const tz = `# ЗАДАЧ: FailStop
# META
workdir: new:test-task-2
mode: auto
on_fail: stop
cycle: 1

## ШАГ 1. Запустим с ошибкой
RUN shell: bash
\`\`\`bash
echo bad
\`\`\`
EXPECT exit=1
EXPECT stdout contains:good

## ШАГ 2. Должен быть skip
NOTE не должен выполниться
`;
    const fake: FakePlan = {
      outputs: [{ match: 'echo bad', data: 'bad\n', exit: 0 }],
    };
    const { result } = await runDoc(tz, fake);
    expect(result.status).toBe('PARTIAL');
    expect(result.results[0].status).toBe('fail');
    expect(result.results[1].status).toBe('skip');
  });

  it('on_fail: continue — следующий шаг не skip', async () => {
    const tz = `# ЗАДАЧ: FailCont
# META
workdir: new:test-task-3
mode: auto
on_fail: continue
cycle: 1

## ШАГ 1. Ошибка
RUN shell: bash
\`\`\`bash
echo bad
\`\`\`
EXPECT exit=1

## ШАГ 2. Должен выполниться
RUN shell: bash
\`\`\`bash
echo ok
\`\`\`
EXPECT exit=0
`;
    const fake: FakePlan = {
      outputs: [
        { match: 'echo bad', data: 'bad\n', exit: 0 },
        { match: 'echo ok', data: 'ok\n', exit: 0 },
      ],
    };
    const { result } = await runDoc(tz, fake);
    expect(result.status).toBe('PARTIAL'); // т.к. был fail
    expect(result.results[1].status).toBe('ok'); // но не skip
  });

  it('таймаут → fail', async () => {
    // Используем реальный bash, который долго выполняется.
    // Поставим очень маленький timeout.
    const tz = `# ЗАДАЧ: Timeout
# META
workdir: new:to-task
mode: auto
on_fail: continue
cycle: 1

## ШАГ 1. Долгая команда
RUN shell: bash
\`\`\`bash
sleep 10
\`\`\`
EXPECT exit=0
`;
    // Используем реальный /bin/bash с быстрым таймаутом
    const cfg = cfgForTest();
    cfg.stepTimeoutSec = 1; // 1 секунда
    const parsed = parseTz(tz);
    expect(parsed.ok).toBe(true);
    const taskId = 'to_' + Date.now();
    const result = await executeDoc(
      parsed.doc!,
      cfg,
      taskId,
      {
        onStepStatus: () => {},
        onPtyData: () => {},
        onNote: () => {},
      },
      { stopped: false },
      logDir,
    );
    expect(result.results[0].status).toBe('fail');
    expect(result.status).toBe('PARTIAL');
  });

  it('RUN_BG: маркер найден → ok', async () => {
    const tz = `# ЗАДАЧ: BgOk
# META
workdir: new:bg-ok
mode: auto
on_fail: stop
cycle: 1

## ШАГ 1. Фон
RUN_BG shell: bash
\`\`\`bash
echo "start"; echo "listening:3456"
\`\`\`
WAIT stdout: listening:3456
`;
    const fake: FakePlan = {
      outputs: [
        {
          match: 'listening:3456',
          data: 'starting\nlistening:3456\n',
          exit: 0,
          delayMs: 10,
        },
      ],
    };
    const { result } = await runDoc(tz, fake);
    expect(result.results[0].status).toBe('ok');
    expect(result.status).toBe('SUCCESS');
  });

  it('RUN_BG: маркер не найден за таймаут → fail', async () => {
    const tz = `# ЗАДАЧ: BgFail
# META
workdir: new:bg-fail
mode: auto
on_fail: stop
cycle: 1

## ШАГ 1. Фон без маркера
RUN_BG shell: bash
\`\`\`bash
echo "no marker here"
\`\`\`
WAIT stdout: listening:3456
`;
    // Используем реальный bash с маленьким таймаутом
    const cfg = cfgForTest();
    cfg.stepTimeoutSec = 1;
    const parsed = parseTz(tz);
    expect(parsed.ok).toBe(true);
    const taskId = 'bgfail_' + Date.now();
    const result = await executeDoc(
      parsed.doc!,
      cfg,
      taskId,
      {
        onStepStatus: () => {},
        onPtyData: () => {},
        onNote: () => {},
      },
      { stopped: false },
      logDir,
    );
    expect(result.results[0].status).toBe('fail');
  });
});
