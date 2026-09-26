// server.ts — HTTP + WS сервер агента (v4.2: стабильный токен в файле).
// BASE ЭТАП 2: единый билдер задач — base2/taskService.startTz (П-1, один
// билдер на всех потребителей: WS-мост, HTTP /tasks, MCP, автопилот, помощь);
// WS-расширения — ЕДИНСТВЕННАЯ секция patch-маркеров «ЭТАП 2»: ping/status.get/
// mode.*/glm.ingest/autopilot.state + reqId-ответы на task.start.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';

import { AgentConfig } from './config.js';
import { parseTz } from './tz/parser.js';
import { executeDoc } from './core/stepEngine.js';
import { renderReport, saveReport } from './core/reporter.js';
import { ServerMsg } from './proto.js';
// СИСТЕМА ФИЧ: HTTP-обработчики + лог-синк в терминал UI
import { handleFeaturesApi } from './features/http.js';
import { setFeatureLogSink, type FeatureRegistry } from './features/registry.js';
// BASE ЭТАП 1: единый выделитель задач + очистка workspace (новые модули)
import { TaskHub } from './core/taskHub.js';
import { purgeWorkspace, workspaceRootOf } from './core/workspace.js';
// BASE ЭТАП 2: единый билдер задач + runtime этапа
import { initBase2Runtime, getBase2 } from './base2/runtime.js';
import { sanitizeWireOrigin, BusEvents } from './base2/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  cfg: AgentConfig;
  publicDir: string;
  reportsDir: string;
  logDir: string;
  packDir?: string;
  // Путь к файлу стабильного токена (data/state/agent.token)
  tokenFile?: string;
  // СИСТЕМА ФИЧ (additive): реестр + динамические маршруты фич (context-pack и др.)
  features?: {
    registry: FeatureRegistry;
    routes: { method: string; path: string; handler: (req: any, res: any) => void }[];
    featuresDir: string;
    cfgPath: string;
    root: string;
  };
}

function readBody(req: any, maxBytes = 2 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolveP, rejectP) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      if (chunks.reduce((s, b) => s + b.length, 0) > maxBytes) {
        rejectP(new Error('body слишком большой'));
        req.destroy();
      }
    });
    req.on('end', () => resolveP(Buffer.concat(chunks)));
    req.on('error', rejectP);
  });
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
  const workspaceRoot = workspaceRootOf(cfg.workspaceRoot);
  // BASE ЭТАП 1: единый выделитель задач — один реестр для WS-моста, HTTP /tasks и MCP-прокси
  const hub = new TaskHub();

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
    // BASE ЭТАП 1: занятость читается из TaskHub (единый выделитель), удаление — core/workspace.ts
    if (url.pathname === '/workspace/purge' && req.method === 'POST') {
      if (hub.isBusy()) {
        res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'идёт задача ' + hub.activeTaskId + ' — очистка отклонена' }));
        return;
      }
      const purge = await purgeWorkspace(workspaceRoot);
      if (!purge.ok) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: purge.error }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, removed: purge.removed }));
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

    // === BASE ЭТАП 1: единый выделитель задач — HTTP-вход (сюда ходит MCP-прокси) ===
    // Тот же токен-гейт, что у /features и /workspace/purge (?t=).
    // ЭТАП 2: исполнение — через ЕДИНЫЙ taskService (как у WS и автопилота).
    if (url.pathname === '/tasks' || url.pathname.startsWith('/tasks/')) {
      const t = url.searchParams.get('t');
      if (t !== token) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'token required (параметр ?t=)' }));
        return;
      }
      // POST /tasks {tzText} — валидация + запуск; ответ {taskId} СРАЗУ, не ждём конца исполнения.
      if (url.pathname === '/tasks' && req.method === 'POST') {
        let body: any;
        try {
          body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        } catch {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'тело должно быть JSON {tzText}' }));
          return;
        }
        const tzText = body?.tzText;
        if (typeof tzText !== 'string' || tzText.trim() === '') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'tzText обязателен (строка с ТЗ в формате format-spec)' }));
          return;
        }
        const rt = getBase2();
        const r = rt
          ? rt.taskService.startTz(tzText, sanitizeWireOrigin(body?.origin), { sessionId: body?.sessionId, conversationId: body?.conversationId ?? 'http' })
          : legacySubmitTask(tzText, 'http');
        if (!r.ok) {
          res.writeHead(r.conflict ? 409 : 400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: r.error }));
          return;
        }
        res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, taskId: r.taskId }));
        return;
      }
      // GET /tasks — реестр задач TaskHub (новые сверху)
      if (url.pathname === '/tasks' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, tasks: hub.list(), active: hub.activeTaskId }));
        return;
      }
      // GET /tasks/:id — карточка задачи (канал get_status MCP-прокси)
      if (req.method === 'GET') {
        const taskId = decodeURIComponent(url.pathname.slice('/tasks/'.length));
        const rec = hub.get(taskId);
        if (!rec) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'задача не найдена: ' + taskId }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, task: rec }));
        return;
      }
    }

    // === СИСТЕМА ФИЧ: маршруты под токен-гейтом (как /workspace/purge) ===
    if (url.pathname === '/features' || url.pathname.startsWith('/features/')) {
      const t = url.searchParams.get('t');
      if (t !== token) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'token required (параметр ?t=)' }));
        return;
      }
      const feats = opts.features;
      if (!feats) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'система фич не инициализирована' }));
        return;
      }
      const handled = await handleFeaturesApi(req, res, url, {
        registry: feats.registry,
        cfg,
        cfgPath: feats.cfgPath,
        root: feats.root,
      });
      if (handled) return;
      // Динамические маршруты, зарегистрированные фичами (напр. context-pack)
      const dyn = feats.routes.find((r) => r.method === req.method && r.path === url.pathname);
      if (dyn) {
        try {
          await dyn.handler(req, res);
        } catch (e) {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          }
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        }
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'unknown features route' }));
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

  // Легатси-переменная для лог-синка (какая задача сейчас «на экране»)
  let activeTaskId: string | null = null;

  const broadcast = (msg: ServerMsg) => {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) {
      if (c.readyState === 1) c.send(data);
    }
  };

  // СИСТЕМА ФИЧ: логи фич — в терминал UI (магента; ошибки красным) + консоль
  setFeatureLogSink((level, line) => {
    const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[35m';
    broadcast({ type: 'pty.data', task: activeTaskId ?? '__features__', data: `${color}${line}\x1b[0m\r\n` });
  });

  // === BASE ЭТАП 2: рантайм этапа (taskService/mode/bridge/fsm/memory).
  // Инициализация ДОРАБОТАНА до использования в WS-обработчиках; идемпотентна.
  const base2 = initBase2Runtime({
    cfg,
    hub,
    reportsDir,
    logDir,
    broadcast: (msg) => broadcast(msg as ServerMsg),
    agentToken: token,
  });

  // ЭТАП 2: ретрансляция событий шины слотов в WS-клиенты (П-4):
  // тумблер UI синхронизируется по mode.changed; панели/наблюдатели —
  // по autopilot.state.changed. Подписчики ядра не правятся.
  base2.bus.on(BusEvents.modeChanged, (e) => {
    broadcast({ type: 'mode.changed', ...(e as Record<string, unknown>) } as unknown as ServerMsg);
  });
  base2.bus.on(BusEvents.autopilotState, (e) => {
    broadcast({ type: 'autopilot.state.changed', ...(e as Record<string, unknown>) } as unknown as ServerMsg);
  });

  /**
   * Легатси-путь (используется только если base2 не инициализирован —
   * теоретически невозможный случай; сохранён для целостности контракта HTTP).
   */
  const legacySubmitTask = (
    tzText: string,
    source: 'ws' | 'http',
  ): { ok: true; taskId: string } | { ok: false; error: string; conflict?: boolean } => {
    if (hub.isBusy()) {
      return { ok: false, conflict: true, error: 'task already running (' + hub.activeTaskId + ')' };
    }
    const parsed = parseTz(tzText);
    if (!parsed.ok || !parsed.doc) {
      return {
        ok: false,
        error: 'parse errors:\n' + parsed.errors.map((e) => `  line ${e.line}: ${e.message}`).join('\n'),
      };
    }
    if (!parsed.doc.steps || parsed.doc.steps.length === 0) {
      return { ok: false, error: 'ОТКЛОНЕНО: в ТЗ нет ни одного шага (## ШАГ N). Пустая задача не запускается.' };
    }
    if (!parsed.doc.meta.workdir || parsed.doc.meta.workdir.trim() === '') {
      return { ok: false, error: 'ОТКЛОНЕНО: в META не указан workdir. Каждая задача обязана иметь изолированную папку.' };
    }
    const rec = hub.create(source);
    if (!hub.begin(rec.taskId, 'legacy')) {
      hub.abandon(rec.taskId);
      return { ok: false, conflict: true, error: 'task already running (' + hub.activeTaskId + ')' };
    }
    const taskId = rec.taskId;
    const steps = parsed.doc.steps.map((s, i) => ({ i: i + 1, title: s.title }));
    broadcast({ type: 'task.accepted', taskId, steps });
    void (async () => {
      let engineError: string | undefined;
      const result = await executeDoc(parsed.doc!, cfg, taskId, {
        onStepStatus: (i, state, extra) => broadcast({ type: 'step.status', i, state, ...extra }),
        onPtyData: (task, data) => broadcast({ type: 'pty.data', task, data }),
        onNote: (text) => broadcast({ type: 'pty.data', task: taskId, data: `\x1b[33m${text}\x1b[0m\r\n` }),
      }, { stopped: false }, logDir).catch((e: unknown) => {
        engineError = e instanceof Error ? e.message : String(e);
        return { status: 'STOPPED' as const, results: [], notes: ['engine error: ' + engineError], workspace: cfg.workspaceRoot };
      });
      try {
        const reportMd = renderReport(parsed.doc!, result, taskId);
        saveReport(reportMd, reportsDir, taskId);
        broadcast({ type: 'task.done', status: result.status, reportMd });
        const state = result.status === 'DENIED' ? 'denied' : result.status === 'STOPPED' ? 'stopped' : 'done';
        hub.finish(taskId, {
          state,
          engineStatus: result.status,
          steps: result.results,
          notes: result.notes,
          workspace: result.workspace,
          reportMd,
        });
      } catch (e) {
        hub.fail(taskId, 'report error: ' + (e instanceof Error ? e.message : String(e)));
      }
    })();
    return { ok: true, taskId };
  };

  // === BASE ЭТАП 2: единый путь запуска задачи для ОБОИХ входов (WS-мост и HTTP/MCP) ===
  const submitTask = (
    tzText: string,
    source: 'ws' | 'http',
    extras?: { origin?: unknown; sessionId?: string; conversationId?: string },
  ): { ok: true; taskId: string } | { ok: false; error: string; conflict?: boolean } => {
    const origin = sanitizeWireOrigin(extras?.origin);
    const conversationId = extras?.conversationId ?? (source === 'ws' ? 'ui' : 'http');
    const r = base2.taskService.startTz(tzText, origin, {
      sessionId: extras?.sessionId,
      conversationId,
    });
    if (r.ok) activeTaskId = r.taskId;
    return r.ok ? { ok: true, taskId: r.taskId } : { ok: false, error: r.error, conflict: 'conflict' in r ? r.conflict : undefined };
  };

  wss.on('connection', (ws: WebSocket) => {
    let authed = false;

    const send = (msg: Record<string, unknown>) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    };
    // Ответ на reqId-запрос: единая форма task.result/mode.result/... формируется в кейсах.
    const replyOk = (reqId: string | undefined, payload: Record<string, unknown>) => {
      if (reqId) send({ reqId, ...payload });
    };

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
          // BASE ЭТАП 1: единый путь через TaskHub — тот же, что и у HTTP /tasks (MCP-прокси)
          // ЭТАП 2: origin с провода разрешён только human|mcp (sanitizeWireOrigin);
          // reqId → немедленный адресный ответ {ok, taskId}.
          const r = submitTask(String(msg.tzText ?? ''), 'ws', {
            origin: msg.origin,
            sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : undefined,
            conversationId: typeof msg.conversationId === 'string' ? msg.conversationId : undefined,
          });
          if (msg.reqId) {
            send({
              type: 'task.result',
              reqId: msg.reqId,
              ok: r.ok,
              ...(r.ok ? { taskId: r.taskId } : { error: r.error }),
            });
          }
          if (!r.ok) send({ type: 'error', msg: r.error });
          return;
        }
        case 'task.stop': {
          const n = base2.taskService.stopTask(typeof msg.taskId === 'string' ? msg.taskId : undefined);
          if (n === 0) { /* легатси-совместимость: сигналов нет — ничего */ }
          return;
        }
        case 'confirm.answer': {
          const answer = !!msg.answer;
          const routed = base2.taskService.answerConfirm(typeof msg.taskId === 'string' ? msg.taskId : undefined, answer);
          if (!routed) { /* нет ожидающих — молча (легатси-семантика) */ }
          return;
        }
        // ==== ЭТАП 2: WS-расширения (ЕДИНСТВЕННАЯ секция) ====
        case 'ping': {
          send({ type: 'pong', reqId: msg.reqId });
          return;
        }
        case 'status.get': {
          // get_status из ЕДИНОГО стора (TaskHub) с грейкой {state, engineStatus, steps}
          const rec = hub.get(String(msg.taskId ?? ''));
          send({
            type: 'task.result',
            reqId: msg.reqId,
            ok: !!rec,
            ...(rec ? { task: rec } : { error: 'задача не найдена: ' + String(msg.taskId ?? '') }),
          });
          return;
        }
        case 'mode.get': {
          send({
            type: 'mode.result',
            reqId: msg.reqId,
            ok: true,
            agentId: typeof msg.agentId === 'string' && msg.agentId ? msg.agentId : 'operator',
            mode: base2.modeStore.getMode(typeof msg.agentId === 'string' && msg.agentId ? msg.agentId : 'operator'),
          });
          return;
        }
        case 'mode.list': {
          send({
            type: 'mode.result',
            reqId: msg.reqId,
            ok: true,
            modes: base2.modeStore.listModes(),
            pendingDrain: undefined,
          });
          return;
        }
        case 'mode.set': {
          // Тумблер UI. MCP-канал не имеет mode.set (agentLink не экспортирует) — read-only (П-2).
          const agentId = typeof msg.agentId === 'string' && msg.agentId ? msg.agentId : 'operator';
          const mode = msg.mode === 'autopilot' ? 'autopilot' : msg.mode === 'manual' ? 'manual' : null;
          if (!mode) {
            send({ type: 'mode.result', reqId: msg.reqId, ok: false, agentId, error: 'mode должен быть manual|autopilot' });
            return;
          }
          const r = base2.modeGate.request(agentId, mode, 'ui', typeof msg.reason === 'string' ? msg.reason : undefined);
          if (r.ok) {
            send({
              type: 'mode.result',
              reqId: msg.reqId,
              ok: true,
              agentId,
              mode: r.mode,
              applied: 'applied' in r ? r.applied : true,
              pendingDrain: 'pendingDrain' in r ? r.pendingDrain : false,
            });
          } else {
            send({ type: 'mode.result', reqId: msg.reqId, ok: false, agentId, error: r.reason });
          }
          return;
        }
        case 'glm.ingest': {
          // Программный вход ответа GLM в мост (B2): без UI-автоматизации.
          const r = await base2.bridge.ingestAnswer({
            answerText: String(msg.answerText ?? ''),
            chatId: String(msg.chatId ?? ''),
            agentId: typeof msg.agentId === 'string' ? msg.agentId : undefined,
            source: 'ws',
          });
          send({
            type: 'ingest.result',
            reqId: msg.reqId,
            ok: r.outcome === 'started' || r.outcome === 'complete' || r.outcome === 'queued',
            outcome: r.outcome,
            ...(r.taskId ? { taskId: r.taskId } : {}),
            ...(r.reason ? { reason: r.reason } : {}),
          });
          return;
        }
        case 'autopilot.state': {
          send({ type: 'autopilot.state.result', reqId: msg.reqId, loops: base2.fsm.snapshotAll() });
          return;
        }
        // ==== конец секции ЭТАПА 2 ====
        default:
          return;
      }
    });
  });

  httpServer.listen(cfg.port, '127.0.0.1', () => { });

  const close = async () => {
    setFeatureLogSink(null);
    wss.close();
    httpServer.close();
  };

  return { token, port: cfg.port, close };
}
