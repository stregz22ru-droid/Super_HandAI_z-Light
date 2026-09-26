// base2/autopilot/bridgeIn.ts — B2: вход моста автопилота.
// GLM-ответ (программно, без UI-автоматизации) → контракт tzContract →
// валидация штатным parser'ом → дедуп sha256 → очередь (1 слот, TTL) →
// idle-gate → запуск задачи origin {type:'autopilot', agentId} (П-1).
// КАЖДЫЙ отказ распознавания журналируется с причиной (data/logs/bridge-in.jsonl).
// В режиме manual мост задачи НЕ подаёт (критерий B2).
import { resolve as resolvePath } from 'node:path';
import type { ModeStore } from '../modeStore.js';
import type { TaskService } from '../taskService.js';
import { conversationKeyOf } from '../taskService.js';
import { appendJsonl } from '../atomic.js';
import { extractContract, tzFingerprint, validateContractTz } from './tzContract.js';
import { TzQueue } from './tzQueue.js';

export interface IngestInput {
  answerText: string;
  chatId: string;
  agentId?: string;
  source?: string; // 'ws' | 'sim' | 'helper' | ...
}

export type IngestOutcome =
  | 'started'
  | 'queued'
  | 'complete'
  | 'duplicate'
  | 'no-block'
  | 'refused'
  | 'manual-skip'
  | 'start-failed'
  | 'bad-input';

export interface IngestResult {
  outcome: IngestOutcome;
  reason?: string;
  taskId?: string;
  conversationKey?: string;
}

/** Порт петли автопилота (реализует fsm.ts). Разделён, чтобы bridge не
 *  импортировал fsm (циклический импорт), а только интерфейс. */
export interface LoopPort {
  beginTurn(chatId: string, agentId: string, taskId: string, conversationKey: string, tsText: string): void;
  notifyComplete(chatId: string, agentId: string): void;
  isDuplicate(chatId: string, hash: string): boolean;
  rememberHash(chatId: string, hash: string): void;
}

export interface BridgeInDeps {
  modes: ModeStore;
  tasks: TaskService;
  queue: TzQueue;
  loop: LoopPort;
  root: string; // корень репо (для data/logs)
  log?: (level: string, msg: string) => void;
}

export function conversationKeyForChat(chatId: string): string {
  return conversationKeyOf({ type: 'autopilot', agentId: 'autopilot' }, { conversationId: 'chat:' + chatId });
}

export class BridgeIn {
  private journalFile: string;

  constructor(private deps: BridgeInDeps) {
    this.journalFile = resolvePath(deps.root, 'data', 'logs', 'bridge-in.jsonl');
  }

  /** Точка входа ответа GLM (WS glm.ingest / симуляция / ответ помощника). */
  async ingestAnswer(input: IngestInput): Promise<IngestResult> {
    const chatId = String(input.chatId ?? '').trim();
    const agentId = (input.agentId ?? '').trim() || 'operator';
    const source = input.source ?? 'ws';
    if (chatId === '' || typeof input.answerText !== 'string') {
      this.journal(chatId, agentId, source, 'bad-input', 'нет chatId или answerText');
      return { outcome: 'bad-input', reason: 'нужны chatId и answerText' };
    }

    const contract = extractContract(input.answerText);
    const mode = this.deps.modes.getMode(agentId);

    // 1) Контрактное завершение (без ТЗ) — стоп петли в УСПЕХЕ.
    if (contract.complete && !contract.refusal) {
      this.journal(chatId, agentId, source, 'complete', 'контрактное поле завершения');
      this.deps.loop.notifyComplete(chatId, agentId);
      return { outcome: 'complete' };
    }
    // 2) Отказы контракта.
    if (contract.refusal) {
      this.journal(chatId, agentId, source, 'refused', contract.refusal.code + ': ' + contract.refusal.message);
      return { outcome: 'refused', reason: contract.refusal.code + ': ' + contract.refusal.message };
    }
    // 3) Блока нет вовсе.
    if (!contract.blockFound || !contract.tzText) {
      this.journal(chatId, agentId, source, 'no-block', 'блок shai-tz не найден');
      return { outcome: 'no-block', reason: 'блок shai-tz не найден в ответе' };
    }
    // 4) Режим: manual — мост не подаёт задачи.
    if (mode !== 'autopilot') {
      this.journal(chatId, agentId, source, 'manual-skip', `режим агента "${agentId}" = ${mode}: мост не подаёт задачи в manual`);
      return { outcome: 'manual-skip', reason: `режим ${mode}: мост не подаёт задачи` };
    }
    // 5) Валидация штатным parser'ом.
    const v = validateContractTz(contract.tzText);
    if (!v.ok) {
      this.journal(chatId, agentId, source, 'refused', v.refusal.code + ': ' + v.refusal.message.slice(0, 400));
      return { outcome: 'refused', reason: 'ТЗ не прошло parser: ' + v.refusal.message.slice(0, 300) };
    }
    // 6) Дедуп по sha256 нормализованного текста.
    const hash = tzFingerprint(contract.tzText);
    if (this.deps.loop.isDuplicate(chatId, hash)) {
      this.journal(chatId, agentId, source, 'duplicate', 'повтор той же ТЗ (sha256 совпал)');
      return { outcome: 'duplicate', reason: 'повтор той же ТЗ отброшен дедупом' };
    }
    // 7) Очередь: один слот с TTL.
    const convKey = conversationKeyForChat(chatId);
    const offered = this.deps.queue.offer(convKey, { tzText: contract.tzText, chatId, agentId });
    if (!offered.ok) {
      const msg = offered.reason === 'same-pending' ? 'то же ТЗ уже ждёт в слоте' : 'слот занят другим ТЗ (keep-oldest)';
      this.journal(chatId, agentId, source, 'refused', msg);
      return { outcome: 'refused', reason: msg };
    }
    this.deps.loop.rememberHash(chatId, hash);
    // 8) Idle-gate: подача задачи только при agent.idle; иначе ждёт в слоте.
    if (!this.deps.tasks.isIdle(agentId)) {
      this.journal(chatId, agentId, source, 'queued', 'агент занят — ТЗ ждёт в слоте (idle-gate)');
      return { outcome: 'queued', reason: 'агент занят: ТЗ в слоте очереди (TTL)', conversationKey: convKey };
    }
    // 9) Запуск.
    return this.dispatch(convKey, chatId, agentId, source);
  }

  /** Забрать ТЗ из слота и запустить оборот (вызывается и FSM после task.done). */
  async dispatch(conversationKey: string, chatId: string, agentId: string, source: string): Promise<IngestResult> {
    const item = this.deps.queue.take(conversationKey);
    if (!item) return { outcome: 'no-block', reason: 'слот пуст (TTL истёк или уже забран)' };
    // чат с суффиксом :help — ответ ПОМОЩНИКА: origin 'autopilot-help' (директива
    // «Эскалация-к-агенту»: ответ помощника возвращается в петлю с этим origin)
    const isHelp = chatId.endsWith(':help');
    const r = this.deps.tasks.startTz(
      item.tzText,
      { type: isHelp ? 'autopilot-help' : 'autopilot', agentId },
      { conversationId: 'chat:' + chatId, sessionId: chatId },
    );
    if (!r.ok) {
      this.journal(chatId, agentId, source, 'start-failed', r.error.slice(0, 400));
      return { outcome: 'start-failed', reason: r.error };
    }
    this.deps.loop.beginTurn(chatId, agentId, r.taskId, r.conversationKey, item.tzText);
    this.journal(chatId, agentId, source, 'started', 'оборот запущен: ' + r.taskId + (isHelp ? ' (help)' : ''));
    return { outcome: 'started', taskId: r.taskId, conversationKey: r.conversationKey };
  }

  /** Насос слотов: разговоры, чей агент УЖЕ idle. Вызывается FSM после каждого
   *  task.finished (и доступен внешним колл-точкам). Idle-gate соблюдается:
   *  диспетч идёт только при agent.idle; после запуска агент занят — насос
   *  останавливается. Атомарность: take+startTz+beginTurn синхронны. */
  async pumpIdle(): Promise<number> {
    let pumped = 0;
    for (const { key, item } of this.deps.queue.snapshot()) {
      if (!this.deps.tasks.isIdle(item.agentId)) continue;
      const r = await this.dispatch(key, item.chatId, item.agentId, 'slot-pump');
      if (r.outcome === 'started') {
        pumped++;
      } else if (r.outcome === 'no-block') {
        // слот опустел (TTL/забран) — просто идём дальше
      } else {
        this.journal(item.chatId, item.agentId, 'slot-pump', 'pump-failed', r.reason);
      }
    }
    return pumped;
  }

  private journal(chatId: string, agentId: string, source: string, outcome: string, reason?: string): void {
    appendJsonl(this.journalFile, {
      ts: new Date().toISOString(),
      chatId,
      agentId,
      source,
      mode: this.deps.modes.getMode(agentId),
      outcome,
      ...(reason ? { reason } : {}),
    });
    this.deps.log?.('info', `[bridge-in] ${chatId}: ${outcome}${reason ? ' — ' + reason : ''}`);
  }
}
