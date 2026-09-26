// base2/autopilot/fsm.ts — B3: FSM петли автопилота.
// FSM — PER-TASK (каждый оборот = задача со своей карточкой в TaskHub), петля —
// контейнер PER-CONVERSATION (разные чаты/агенты крутятся независимо, П-1).
// События — через шину слотов (П-4): autopilot.state.changed /
// autopilot.loop.stopped / autopilot.escalation.raised — будущие подписчики
// (WCP-канал, другие агенты) подключаются без правки FSM.
import { getSlotBus } from '../slotBus.js';
import { BusEvents, type TaskFinishedEvent, type TaskStartedEvent } from '../types.js';
import type { TaskHub, TaskRecord } from '../../core/taskHub.js';
import type { AgentConfig } from '../../config.js';
import { fingerprintOf, Ledger, type TurnRecord } from './ledger.js';
import { evaluateStopPolicy } from './stopPolicy.js';
import { tzFingerprint } from './tzContract.js';
import type { TzQueue } from './tzQueue.js';
import type { BridgeIn } from './bridgeIn.js';
import type { Outflow } from './outflow.js';
import type { Escalation } from './escalation.js';
import { FsmPersist, type AutopilotStateFile, type LoopSnapshot } from './fsmPersist.js';

export interface FsmDeps {
  cfg: AgentConfig;
  hub: TaskHub;
  persist: FsmPersist;
  queue: TzQueue;
  bridge: BridgeIn | null; // присваивается после создания (разрыв цикла)
  outflow: Outflow;
  escalation: Escalation;
  broadcast: (msg: Record<string, unknown>) => void;
  log?: (level: string, msg: string) => void;
}

export class AutopilotFsm {
  private bus = getSlotBus();
  private loops = new Map<string, LoopSnapshot>(); // conversationKey -> snapshot
  private dedups = new Map<string, string[]>(); // chatId -> hashes (cap 100)
  private offs: (() => void)[] = [];
  private bridge: BridgeIn | null = null;

  constructor(private deps: FsmDeps) {}

  /** Разрыв цикла создания: bridge создаётся после FSM. */
  attachBridge(bridge: BridgeIn): void {
    this.bridge = bridge;
    this.deps.bridge = bridge;
  }

  /** Подписки на слоты ядра — вызывается один раз из runtime. */
  start(): void {
    this.offs.push(
      this.bus.on<TaskFinishedEvent>(BusEvents.taskFinished, (e) => void this.onTaskFinished(e)),
    );
    this.offs.push(
      this.bus.on<TaskStartedEvent>(BusEvents.taskStarted, (e) => this.onTaskStarted(e)),
    );
    this.recover();
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  // ---------- LoopPort (используется bridgeIn) ----------

  beginTurn(chatId: string, agentId: string, taskId: string, conversationKey: string, tzText: string): void {
    const existing = this.loops.get(conversationKey);
    const now = new Date().toISOString();
    if (existing && existing.state !== 'stopped') {
      existing.state = 'turn-running';
      existing.pendingTaskId = taskId;
      existing.updatedAt = now;
      this.persist();
      this.emitState(existing, 'turn-running');
      return;
    }
    const snap: LoopSnapshot = {
      conversationKey,
      chatId,
      agentId,
      state: 'turn-running',
      turn: existing?.state === 'stopped' ? 0 : 0, // инкрементируется в onTaskFinished
      startedAt: now,
      updatedAt: now,
      pendingTaskId: taskId,
      turns: [],
    };
    this.loops.set(conversationKey, snap);
    void tzFingerprint(tzText); // контрактная нормализация уже сделана в bridge (дедуп)
    this.persist();
    this.emitState(snap, 'turn-running');
  }

  notifyComplete(chatId: string, agentId: string): void {
    const key = this.keyOf(chatId);
    const snap = this.loops.get(key);
    if (!snap || snap.state === 'stopped') return;
    if (snap.state === 'turn-running') {
      // Задача в полёте: стоп применится после её завершения (успехом).
      snap.completeRequested = true;
      snap.updatedAt = new Date().toISOString();
      this.persist();
      return;
    }
    this.finishLoop(snap, 'complete', 'контрактное поле завершения', false);
  }

  isDuplicate(chatId: string, hash: string): boolean {
    return (this.dedups.get(chatId) ?? []).includes(hash);
  }

  rememberHash(chatId: string, hash: string): void {
    const list = this.dedups.get(chatId) ?? [];
    if (!list.includes(hash)) list.push(hash);
    while (list.length > 100) list.shift();
    this.dedups.set(chatId, list);
    this.persist();
  }

  // ---------- Реакции на слоты ядра ----------

  private onTaskStarted(e: TaskStartedEvent): void {
    // Ничего не делаем: обороты регистрирует beginTurn (единственный вход),
    // чтобы петля не создавалась задачами, запущенными мимо моста.
    void e;
  }

  private async onTaskFinished(e: TaskFinishedEvent): Promise<void> {
    try {
      // Ответ помощника (autopilot-help): отчёт → подсказка в исходный чат.
      if (e.origin.type === 'autopilot-help') {
        await this.deliverHelpHint(e);
        return;
      }
      if (e.origin.type !== 'autopilot') return;
      const snap = this.loops.get(e.conversationKey);
      if (!snap) return; // задача не из петли (человеческая/MCP) — FSM не реагирует

      if (snap.state === 'stopped') return;

      const record = this.deps.hub.get(e.taskId);
      const fp = record ? fingerprintOf(record) : null;
      const turn: Omit<TurnRecord, 'n'> = {
        taskId: e.taskId,
        ts: new Date().toISOString(),
        engineStatus: (e.engineStatus as TurnRecord['engineStatus']) ?? 'PARTIAL',
        ...(fp ? { fingerprint: fp } : {}),
        ...(record?.reportPath ? { reportFile: record.reportPath } : {}),
      };
      snap.turns.push({ ...turn, n: snap.turns.length + 1 });
      snap.turn = snap.turns.length;
      snap.pendingTaskId = undefined;
      snap.updatedAt = new Date().toISOString();

      // Исходящее сообщение оборота (redaction per-agent + квота — outflow).
      const msg = this.deps.outflow.buildTurnReport({
        record:
          record ??
          ({
            taskId: e.taskId,
            source: 'autopilot',
            state: e.state,
            createdAt: '',
            engineStatus: e.engineStatus as TaskRecord['engineStatus'],
            reportMd: e.reportMd,
          } as TaskRecord),
        chatId: snap.chatId,
        agentId: snap.agentId,
        turn: snap.turn,
        reportFile: record?.reportPath,
      });
      this.deps.broadcast({
        type: 'autopilot.outbox',
        kind: 'turn-report',
        chatId: snap.chatId,
        agentId: snap.agentId,
        turn: snap.turn,
        engineStatus: msg.engineStatus,
        text: msg.text,
      });

      // Контрактное завершение, запрошенное во время полёта задачи.
      const decision = evaluateStopPolicy({
        ledger: this.ledgerOf(snap),
        complete: snap.completeRequested === true,
        maxTurnsNoSuccess: this.deps.cfg.autopilot?.maxTurnsNoSuccess ?? 5,
        fingerprintThreshold: 3,
      });

      if (decision.stop) {
        snap.completeRequested = undefined;
        this.finishLoop(snap, decision.reason!, decision.detail, decision.reason === 'same-fingerprint-3');
        return;
      }

      // Следующий оборот — только из слота очереди (idle-gate соблюдён: задача
      // только что завершилась); иначе ждём ответ GLM.
      const next = this.deps.queue.peek(e.conversationKey);
      if (next) {
        snap.state = 'turn-running'; // оборот стартует в dispatch ниже
        snap.updatedAt = new Date().toISOString();
        this.persist();
        const r = await this.bridge?.dispatch(e.conversationKey, snap.chatId, snap.agentId, 'loop');
        if (!r || r.outcome !== 'started') {
          snap.state = 'await-answer';
          snap.updatedAt = new Date().toISOString();
          this.persist();
          this.emitState(snap, 'await-answer');
        }
        return;
      }
      snap.state = 'await-answer';
      snap.updatedAt = new Date().toISOString();
      this.persist();
      this.emitState(snap, 'await-answer');
    } finally {
      // Насос слотов: чужие разговоры, чей агент стал idle (П-1 мульти-чат).
      await this.bridge?.pumpIdle();
    }
  }

  private async deliverHelpHint(e: TaskFinishedEvent): Promise<void> {
    const origChatId = e.conversationKey.replace(/^conv:chat:/, '').replace(/:help$/, '');
    const record = this.deps.hub.get(e.taskId);
    const helperId = e.origin.agentId;
    const body =
      `## Подсказка помощника (${helperId}) по чату ${origChatId}\n\n` +
      `ВЕРДИКТ: ${e.engineStatus ?? e.state}\n\n` +
      (e.reportMd ?? '(отчёт помощника недоступен)');
    const msg = this.deps.outflow.buildCustom({ kind: 'hint', chatId: origChatId, agentId: helperId, body });
    this.deps.broadcast({
      type: 'autopilot.outbox',
      kind: 'hint',
      chatId: origChatId,
      fromAgent: helperId,
      taskId: e.taskId,
      text: msg.text,
    });
    this.deps.log?.('info', `[fsm] подсказка помощника ${helperId} доставлена в чат ${origChatId}`);
    void record;
  }

  /** Остановка петли: стоп-критерий или контрактное завершение (успех). */
  private finishLoop(snap: LoopSnapshot, reason: string, detail: string | undefined, dispatchHelper: boolean): void {
    snap.state = 'stopped';
    snap.stopReason = reason;
    snap.updatedAt = new Date().toISOString();
    this.persist();
    this.emitState(snap, 'stopped');

    void this.bus.emit(BusEvents.autopilotStopped, {
      conversationKey: snap.conversationKey,
      chatId: snap.chatId,
      agentId: snap.agentId,
      reason,
      detail,
      turns: snap.turns.length,
      ts: snap.updatedAt,
    });

    if (reason === 'complete') {
      this.deps.log?.('info', `[fsm] петля ${snap.chatId} завершена УСПЕХОМ (контрактное поле, оборотов: ${snap.turns.length})`);
      return;
    }
    void this.deps.escalation.raise({
      chatId: snap.chatId,
      agentId: snap.agentId,
      mode: 'autopilot',
      reason,
      detail,
      ledger: this.ledgerOf(snap),
      reportFiles: snap.turns.map((t) => t.reportFile),
      dispatchHelper,
    });
  }

  // ---------- Восстановление после падения (K5) ----------

  private recover(): void {
    const state = this.deps.persist.read();
    for (const [chatId, hashes] of Object.entries(state.dedups ?? {})) {
      this.dedups.set(chatId, [...hashes]);
    }
    for (const snap of state.loops ?? []) {
      if (!snap || !snap.conversationKey) continue;
      const s: LoopSnapshot = { ...snap, turns: [...(snap.turns ?? [])] };
      this.loops.set(s.conversationKey, s);
      if (s.state === 'turn-running') {
        // Процесс упал во время оборота: задача мертва — фиксируем
        // INTERRUPTED-отпечаток и прогоняем политику на восстановленных данных.
        const fp = { step: 0, cls: 'INTERRUPTED' as const, exitCode: null, message: 'процесс убит до завершения оборота (восстановлено после рестарта)' };
        s.turns.push({ n: s.turns.length + 1, taskId: s.pendingTaskId ?? '(неизвестно)', ts: new Date().toISOString(), engineStatus: 'STOPPED', fingerprint: fp });
        s.turn = s.turns.length;
        s.pendingTaskId = undefined;
        const decision = evaluateStopPolicy({
          ledger: this.ledgerOf(s),
          complete: false,
          maxTurnsNoSuccess: this.deps.cfg.autopilot?.maxTurnsNoSuccess ?? 5,
          fingerprintThreshold: 3,
        });
        if (decision.stop) {
          this.finishLoop(s, decision.reason!, decision.detail, decision.reason === 'same-fingerprint-3');
        } else {
          s.state = 'await-answer';
          s.updatedAt = new Date().toISOString();
          this.persist();
          this.emitState(s, 'await-answer');
        }
      }
    }
    if ((state.loops?.length ?? 0) > 0) {
      this.deps.log?.('info', `[fsm] восстановлено петель: ${this.loops.size} из ${this.deps.persist.path}`);
    }
  }

  // ---------- Утилиты ----------

  private ledgerOf(snap: LoopSnapshot): Ledger {
    const l = new Ledger();
    l.load(snap.turns);
    return l;
  }

  private keyOf(chatId: string): string {
    return 'conv:chat:' + chatId;
  }

  private emitState(snap: LoopSnapshot, to: string): void {
    void this.bus.emit(BusEvents.autopilotState, {
      conversationKey: snap.conversationKey,
      chatId: snap.chatId,
      agentId: snap.agentId,
      state: to,
      turn: snap.turn,
      ts: snap.updatedAt,
    });
  }

  private persist(): void {
    const state: AutopilotStateFile = {
      version: 1,
      loops: [...this.loops.values()],
      dedups: Object.fromEntries(this.dedups),
    };
    try {
      this.deps.persist.write(state);
    } catch (e) {
      this.deps.log?.('error', '[fsm] state-файл не записан: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  snapshotAll(): LoopSnapshot[] {
    return [...this.loops.values()].map((s) => ({ ...s, turns: [...s.turns] }));
  }

  /** Для тестов: дедуп-хэши чата. */
  dedupList(chatId: string): string[] {
    return [...(this.dedups.get(chatId) ?? [])];
  }
}
