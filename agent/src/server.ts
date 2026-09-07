// server.ts — HTTP + WS сервер агента (v4.2: стабильный токен в файле).
import { createServer } from 'node:http';
import { readFile, readdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';

import { AgentConfig } from './config.js';
import { parseTz } from './tz/parser.js';
import { lint } from './tz/linter.js';
import { executeDoc, type EngineResult } from './core/stepEngine.js';
import { renderReport, saveReport } from './core/reporter.js';
import { ServerMsg } from './proto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  cfg: AgentConfig;
  publicDir: string;
  reportsDir: string;
  logDir: string;
  packDir?: string;
  // Путь к файлу стабильного токена (data/state/agent.token)
  tokenFile?: string;
}

// Стабильный токен: создаётся один раз, живёт между рестартами.
// Юзер вводит его в мост один раз за жизнь установки.
function loadOrCreateToken(tokenFile?: string): string {
  if (tokenFile && existsSync(tokenFile)) {
    const t = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
    if (t.length >= 16) return t;
  }
  const fresh = randomBytes(16).toString('hex');
  if (tokenFile) {
    try {
      const dir = resolve(tokenFile, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(tokenFile, fresh, 'utf8');
    } catch { /* файл недоступен — живём временным токеном */ }
  }
  return fresh;
}

export function startServer(opts: ServerOptions): { token: string; port: number; close: () => Promise<void> } {
  const { cfg, publicDir, reportsDir, logDir } = opts;
  const packDir = opts.packDir ? resolve(opts.packDir) : null;
  // Долг N1-мат: стабильный токен вместо нового при каждом старте
  const token = loadOrCreateToken(opts.tokenFile);
  const publicRoot = resolve(publicDir);
  const workspaceRoot = resolve(cfg.workspaceRoot);

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/favicon.ico') {
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
        `<rect width="64" height="64" rx="14" fill="#0c0d10"/>` +
        `<g fill="none" stroke="#4a9eff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">` +
        `<path d="M10 22 v20"/><path d="M10 24 h12 a5 5 0 0 1 5 5 v3"/>` +
        `<path d="M10 40 h12 a5 5 0 0 0 5 -5 v-3"/>` +
        `<path d="M54 22 v20"/><path d="M54 24 h-12 a5 5 0 0 0 -5 5 v3"/>` +
        `<path d="M54 40 h-12 a5 5 0 0 1 -5 -5 v-3"/>` +
        `</g><circle cx="32" cy="32" r="4.5" fill="#ffd166"/></svg>`;
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      res.end(svg);
      return;
    }

    // === Долг N18: полная очистка workspace (защита активной задачи) ===
    if (url.pathname === '/workspace/purge' && req.method === 'POST') {
      if (activeTaskId) {
        res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'идёт задача ' + activeTaskId + ' — очистка отклонена' }));
        return;
      }
      try {
        const entries = await readdir(workspaceRoot, { withFileTypes: true });
        let removed = 0;
        for (const e of entries) {
          const full = resolve(workspaceRoot, e.name);
          if (!full.startsWith(workspaceRoot + sep) && full !== workspaceRoot) continue;
          await rm(full, { recursive: true, force: true });
          removed++;
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, removed }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }

    if (packDir && (url.pathname === '/pack' || url.pathname.startsWith('/pack/'))) {
      const rel = url.pathname === '/pack' ? 'templates.json' : decodeURIComponent(url.pathname.slice('/pack/'.length));
      const allow = ['templates.json', 'glm-system.md', 'context.txt'];
      if (!allow.includes(rel)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      try {
        const buf = await readFile(resolve(packDir, rel));
        const ct = rel.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
        res.writeHead(200, { 'content-type': ct, 'cache-control': 'no-store' });
        res.end(buf);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('pack file missing');
      }
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const t = url.searchParams.get('t');
      if (t !== token) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('token required');
        return;
      }
      try {
        const html = (await readFile(resolve(publicRoot, 'index.html'), 'utf8')).split('TOKEN').join(token);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('index.html not found');
      }
      return;
    }

    {
      const t = url.searchParams.get('t');
      if (t !== token) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('token required');
        return;
      }
      const filePath = resolve(publicRoot, '.' + url.pathname);
      if (!filePath.startsWith(publicRoot + sep)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      try {
        const buf = await readFile(filePath);
        const ext = url.pathname.split('.').pop() ?? '';
        const ct = ext === 'js' ? 'application/javascript' : ext === 'css' ? 'text/css' : ext === 'html' ? 'text/html' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': `${ct}; charset=utf-8` });
        res.end(buf);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
      return;
    }
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  let activeTaskId: string | null = null;
  let stopSignal: { stopped: boolean } | null = null;
  let pendingConfirm: { resolve: (v: boolean) => void } | null = null;

  const broadcast = (msg: ServerMsg) => {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) {
      if (c.readyState === 1) c.send(data);
    }
  };

  wss.on('connection', (ws: WebSocket) => {
    let authed = false;

    ws.on('message', async (raw: Buffer) => {
      let msg: any = null;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!authed) {
        if (msg.type === 'auth' && msg.token === token) {
          authed = true;
          return;
        }
        ws.close(4001, 'unauthorized');
        return;
      }
      switch (msg.type) {
        case 'task.start': {
          if (activeTaskId) {
            ws.send(JSON.stringify({ type: 'error', msg: 'task already running' }));
            return;
          }
          const tzText: string = msg.tzText;
          const parsed = parseTz(tzText);
          if (!parsed.ok || !parsed.doc) {
            ws.send(JSON.stringify({
              type: 'error',
              msg: 'parse errors:\n' + parsed.errors.map((e) => `  line ${e.line}: ${e.message}`).join('\n'),
            }));
            return;
          }
          if (!parsed.doc.steps || parsed.doc.steps.length === 0) {
            ws.send(JSON.stringify({
              type: 'error',
              msg: 'ОТКЛОНЕНО: в ТЗ нет ни одного шага (## ШАГ N). Пустая задача не запускается.',
            }));
            return;
          }
          if (!parsed.doc.meta.workdir || parsed.doc.meta.workdir.trim() === '') {
            ws.send(JSON.stringify({
              type: 'error',
              msg: 'ОТКЛОНЕНО: в META не указан workdir. Каждая задача обязана иметь изолированную папку.',
            }));
            return;
          }
          const issues = lint(parsed.doc);
          broadcast({ type: 'lint.result', issues });
          activeTaskId = 'task_' + Date.now();
          stopSignal = { stopped: false };
          const taskId = activeTaskId;
          const steps = parsed.doc.steps.map((s, i) => ({ i: i + 1, title: s.title }));
          broadcast({ type: 'task.accepted', taskId, steps });

          (async () => {
            let result: EngineResult;
            try {
              result = await executeDoc(
                parsed.doc!,
                cfg,
                taskId,
                {
                  onStepStatus: (i, state, extra) => broadcast({ type: 'step.status', i, state, ...extra }),
                  onPtyData: (task, data) => broadcast({ type: 'pty.data', task, data }),
                  onNote: (text) => broadcast({ type: 'pty.data', task: taskId, data: `\x1b[33m${text}\x1b[0m\r\n` }),
                  onNeedConfirm: (i, kind, preview) => {
                    return new Promise<boolean>((resolveC) => {
                      pendingConfirm = { resolve: resolveC };
                      broadcast({
                        type: 'confirm.request',
                        id: taskId + ':' + i,
                        kind: kind,
                        text: 'ШАГ ' + i + ' [' + kind + ']: ' + preview,
                      } as any);
                    });
                  },
                },
                stopSignal!,
                logDir,
              );
            } catch (e) {
              result = {
                status: 'STOPPED',
                results: [],
                notes: ['engine error: ' + (e instanceof Error ? e.message : String(e))],
                workspace: cfg.workspaceRoot,
              };
            }
            const reportMd = renderReport(parsed.doc!, result, taskId);
            saveReport(reportMd, reportsDir, taskId);
            broadcast({ type: 'task.done', status: result.status, reportMd });
            activeTaskId = null;
            stopSignal = null;
            pendingConfirm = null;
          })();
          return;
        }
        case 'task.stop': {
          if (stopSignal) stopSignal.stopped = true;
          if (pendingConfirm) { pendingConfirm.resolve(false); pendingConfirm = null; }
          return;
        }
        case 'confirm.answer': {
          if (pendingConfirm) {
            pendingConfirm.resolve(!!msg.answer);
            pendingConfirm = null;
          }
          return;
        }
        default:
          return;
      }
    });
  });

  httpServer.listen(cfg.port, '127.0.0.1', () => { });

  const close = async () => {
    wss.close();
    httpServer.close();
  };

  return { token, port: cfg.port, close };
}