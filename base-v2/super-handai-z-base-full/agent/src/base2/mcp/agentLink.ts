// base2/mcp/agentLink.ts — B0: транспорт MCP-процесса к агенту.
// ЭТАП 2: HTTP-эндпоинтов задач в агенте НЕТ и не будет (дизайн) — все
// задачные операции идут по WS ws://127.0.0.1:<port>/ws с auth по стабильному
// токену data/state/agent.token (канал доказан end-to-end у команды).
//
// Контракт:
//  • call(type, payload) — RPC с корреляцией reqId: сервер отвечает сообщением
//    с тем же reqId (task.result / mode.result / ingest.result / pong / ...);
//  • onEvent(type, fn) — подписка на широковещательные события сервера
//    (task.accepted / task.done / pty.data / autopilot.outbox / mode.changed);
//  • НАМЕРЕННО НЕТ setMode: MCP — read-only по режиму (П-2).
import WebSocket from 'ws';

export interface AgentLinkOptions {
  port?: number;
  url?: string;            // полный ws:// URL; иначе собирается из port
  token: string;
  connectTimeoutMs?: number;
  authProbeTimeoutMs?: number;
}

type Pending = {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export class AgentLink {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private eventHandlers = new Map<string, Set<(msg: Record<string, unknown>) => void>>();
  private closedByUs = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on('message', (raw: Buffer) => this.onMessage(raw));
    this.ws.on('close', () => this.onClose());
    this.ws.on('error', () => { /* обрабатывается close/reject'ами */ });
  }

  /** Подключение + auth + проба канала (ping). Бросает с понятной диагностикой. */
  static async connect(opts: AgentLinkOptions): Promise<AgentLink> {
    const url = opts.url ?? 'ws://127.0.0.1:' + (opts.port ?? 8787) + '/ws';
    const connectTimeoutMs = opts.connectTimeoutMs ?? 10000;
    const authProbeTimeoutMs = opts.authProbeTimeoutMs ?? 5000;

    const ws = await new Promise<WebSocket>((resolveW, rejectW) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        try { socket.terminate(); } catch { /* no-op */ }
        rejectW(new Error(`агент недоступен по ${url} за ${connectTimeoutMs}мс — запусти агента (run.cmd / node dist/main.js)`));
      }, connectTimeoutMs);
      socket.once('open', () => { clearTimeout(timer); resolveW(socket); });
      socket.once('error', (e: Error) => {
        clearTimeout(timer);
        rejectW(new Error(`WS-подключение к агенту не удалось (${url}): ${e.message}`));
      });
    });

    // auth: сервер молча ставит флаг; неверный токен → close 4001.
    const link = new AgentLink(ws);
    let closedCode: number = 0;
    const closePromise = new Promise<number>((resolveClose) => {
      ws.once('close', (code: number) => {
        closedCode = code;
        resolveClose(code);
      });
    });
    ws.send(JSON.stringify({ type: 'auth', token: opts.token }));

    // Проба канала: pong обязателен — он же маркер наличия WS-расширений Этапа 2.
    const probe = link.call('ping', {}, authProbeTimeoutMs).then(
      () => 'pong' as const,
      (e: Error) => 'probe-error: ' + e.message,
    );
    const winner = await Promise.race([probe, closePromise.then(() => 'closed' as const)]);
    if (winner === 'closed') {
      const code = closedCode;
      try { ws.close(); } catch { /* no-op */ }
      throw new Error(
        code === 4001
          ? 'auth отклонён агентом (неверный токен) — проверь data/state/agent.token'
          : `WS закрыт агентом (code=${code})`,
      );
    }
    if (winner !== 'pong') {
      try { ws.close(); } catch { /* no-op */ }
      throw new Error(
        'агент не отвечает на ping: ' + String(winner) +
        ' — на агенте не применён патч Этапа 2 (WS-расширения server.ts) либо агент завис',
      );
    }
    return link;
  }

  private onMessage(raw: Buffer): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      return;
    }
    const reqId = typeof msg.reqId === 'string' ? msg.reqId : undefined;
    if (reqId) {
      const p = this.pending.get(reqId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(reqId);
        p.resolve(msg);
        return;
      }
    }
    const type = typeof msg.type === 'string' ? msg.type : '';
    const set = this.eventHandlers.get(type);
    if (set) {
      for (const fn of [...set]) {
        try { fn(msg); } catch { /* обработчик не должен ронять линк */ }
      }
    }
  }

  private onClose(): void {
    const err = new Error(this.closedByUs ? 'WS-линк закрыт' : 'WS-линк закрыт агентом (агент остановлен?)');
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** RPC-вызов: ответ — первое сообщение с тем же reqId. */
  call(type: string, payload: Record<string, unknown> = {}, timeoutMs = 15000): Promise<Record<string, unknown>> {
    if (this.ws.readyState !== this.ws.OPEN) {
      return Promise.reject(new Error('WS-линк не открыт (readyState=' + this.ws.readyState + ')'));
    }
    const reqId = 'r' + ++this.seq;
    return new Promise<Record<string, unknown>>((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        rejectP(new Error(`таймаут ${timeoutMs}мс запроса ${type} (reqId=${reqId}) — агент жив, но не отвечает`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve: resolveP, reject: rejectP, timer });
      try {
        this.ws.send(JSON.stringify({ type, reqId, ...payload }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        rejectP(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Подписка на широковещательные события сервера. Возвращает отписку. */
  onEvent(type: string, fn: (msg: Record<string, unknown>) => void): () => void {
    let set = this.eventHandlers.get(type);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(type, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  // ---- Высокоуровневые операции (задачные — ТОЛЬКО WS; HTTP-эндпоинтов задач нет) ----

  /** run_tz: немедленный {taskId}. origin {type:'mcp', agentId} присваивает MCP (П-1). */
  async startTz(tzText: string): Promise<string> {
    const r = await this.call('task.start', {
      tzText,
      origin: { type: 'mcp', agentId: 'mcp' },
      conversationId: 'mcp',
    });
    if (r.ok !== true || typeof r.taskId !== 'string') {
      throw new Error('run_tz отклонён агентом: ' + String(r.error ?? 'неизвестная ошибка'));
    }
    return r.taskId;
  }

  /** get_status: карточка из ЕДИНОГО TaskHub агента (грейка {state, engineStatus, steps}). */
  async getStatus(taskId: string): Promise<Record<string, unknown>> {
    const r = await this.call('status.get', { taskId });
    if (r.ok !== true || !r.task || typeof r.task !== 'object') {
      throw new Error('get_status: агент не вернул карточку задачи: ' + String(r.error ?? '(пустой ответ)'));
    }
    return r.task as Record<string, unknown>;
  }

  /** Режим агента — только ЧТЕНИЕ (П-2: MCP read-only, setMode не существует). */
  async modeGet(agentId?: string): Promise<{ agentId: string; mode: string }> {
    const r = await this.call('mode.get', { agentId: agentId ?? 'operator' });
    if (r.ok !== true) throw new Error('mode.get отклонён: ' + String(r.error ?? ''));
    return { agentId: String(r.agentId), mode: String(r.mode) };
  }

  close(): void {
    this.closedByUs = true;
    try { this.ws.close(); } catch { /* no-op */ }
  }
}
