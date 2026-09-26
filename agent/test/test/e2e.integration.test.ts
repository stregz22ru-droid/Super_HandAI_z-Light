// test/e2e.integration.test.ts — интеграционный тест на реальном /bin/bash + node-pty.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startServer } from '../src/server.js';
import type { AgentConfig } from '../src/config.js';

let tmpRoot: string;
let workspaceRoot: string;
let publicDir: string;
let reportsDir: string;
let logDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'shz-e2e-'));
  workspaceRoot = join(tmpRoot, 'workspace');
  publicDir = join(tmpRoot, 'public');
  reportsDir = join(tmpRoot, 'reports');
  logDir = join(tmpRoot, 'logs');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  // Минимальный index.html для проверки статики
  const fs = require('node:fs');
  fs.writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>e2e</title>');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeCfg(): AgentConfig {
  return {
    port: 0, // не используется, передаём случайный через явный порт ниже
    workspaceRoot,
    shells: {
      pwsh: { cmd: '/nonexistent/pwsh', args: ['-NoLogo', '-Command'] },
      bash: { cmd: '/nonexistent/bash', args: ['-c'] },
      pwshFallback: { cmd: 'powershell.exe', args: ['-NoLogo', '-Command'] },
      linuxBash: { cmd: '/bin/bash', args: ['-c'] },
    },
    stepTimeoutSec: 30,
    maxOutputBytes: 1048576,
    deny: [],
  };
}

function randomPort(): number {
  // Выбираем случайный порт в динамическом диапазоне.
  return 30000 + Math.floor(Math.random() * 30000);
}

describe('e2e integration (real /bin/bash + node-pty)', () => {
  it('запускает полный цикл из 3 шагов и возвращает SUCCESS', async () => {
    const tzText = `\`\`\`tz
# ЗАДАЧ: E2E интеграция
# META
workdir: new:e2e-task
mode: auto
on_fail: stop
cycle: 1

## ШАГ 1. Создать файл
RUN shell: bash
\`\`\`bash
echo hello > out.txt && cat out.txt
\`\`\`
EXPECT exit=0
EXPECT stdout contains:hello

## ШАГ 2. Записать report
WRITE report.txt
\`\`\`text
end of e2e
\`\`\`

## ШАГ 3. GIT commit
GIT commit: "e2e: done"
\`\`\``;

    // Случайный порт, чтобы не пересекаться с другими тестами.
    const cfg = makeCfg();
    cfg.port = randomPort();
    // ЭТАП 1: изолированный stateDir — единый выделитель задач (lock) не должен
    // пересекаться между тест-файлами (vitest гоняет их параллельно).
    const srv = startServer({ cfg, publicDir, reportsDir, logDir, stateDir: join(tmpRoot, 'state'), hooksDir: join(tmpRoot, 'hooks') });

    const wsUrl = `ws://127.0.0.1:${cfg.port}/ws`;
    const ws = new WebSocket(wsUrl);

    const received: any[] = [];
    const done = new Promise<{
      status: string;
      reportMd: string;
    }>((resolveDone) => {
      ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());
        received.push(msg);
        if (msg.type === 'task.done') {
          resolveDone({ status: msg.status, reportMd: msg.reportMd });
        }
      });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: srv.token }));
        ws.send(JSON.stringify({ type: 'task.start', tzText }));
      });
    });

    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('timeout waiting task.done')), 30000),
    );
    const result = (await Promise.race([done, timeout])) as {
      status: string;
      reportMd: string;
    };

    ws.close();
    await srv.close();

    expect(result.status).toBe('SUCCESS');
    expect(result.reportMd).toContain('E2E интеграция');
    // Проверка файлов
    const wsTaskDir = join(workspaceRoot, 'e2e-task');
    expect(existsSync(join(wsTaskDir, 'out.txt'))).toBe(true);
    expect(readFileSync(join(wsTaskDir, 'out.txt'), 'utf8')).toContain('hello');
    expect(existsSync(join(wsTaskDir, 'report.txt'))).toBe(true);
    expect(readFileSync(join(wsTaskDir, 'report.txt'), 'utf8')).toContain('end of e2e');
    // Принят task.accepted
    expect(received.some((m) => m.type === 'task.accepted')).toBe(true);
    // Был step.status ok на шаге 1
    expect(received.some((m) => m.type === 'step.status' && m.i === 1 && m.state === 'ok')).toBe(true);
  }, 60000);
});
