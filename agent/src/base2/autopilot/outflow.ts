// base2/autopilot/outflow.ts — B3: выход моста. Сборка ИСХОДЯЩЕГО сообщения из
// отчёта reporter (чтение карточки TaskHub — reporter не трогается), redaction-
// фильтр PER-AGENT (П-3), квота размера (обрезка ЖУРНАЛИРУЕТСЯ).
// Канал доставки — WS-broadcast 'autopilot.outbox' (чат-коллектор: скрипт-клиент
// симуляции, будущий z.ai-мост; для будущей Persona стиль будет per-agent).
import { appendJsonl } from '../atomic.js';
import { resolve as resolvePath } from 'node:path';
import { profileFor, redact } from './redaction.js';
import type { RedactionConfigLike } from './redaction.js';
import type { TaskRecord } from '../../core/taskHub.js';
import type { TaskOrigin } from '../types.js';

export interface OutflowDeps {
  root: string;
  agentToken: string;
  redaction?: RedactionConfigLike;
  defaultQuota: number;
  log?: (level: string, msg: string) => void;
}

export interface OutgoingMessage {
  kind: 'turn-report' | 'escalation' | 'hint';
  chatId: string;
  agentId: string;
  taskId?: string;
  turn?: number;
  engineStatus?: string;
  text: string;
  truncated: boolean;
  redactionHits: { tokens: number; paths: number; urls: number };
}

export class Outflow {
  private journalFile: string;

  constructor(private deps: OutflowDeps) {
    this.journalFile = resolvePath(deps.root, 'data', 'logs', 'outflow.jsonl');
  }

  /** Исходящее сообщение отчёта оборота. */
  buildTurnReport(params: { record: TaskRecord; chatId: string; agentId: string; turn: number; reportFile?: string }): OutgoingMessage {
    const header = [
      `## Отчёт оборота ${params.turn} — ${params.record.taskId}`,
      `ВЕРДИКТ: ${params.record.engineStatus ?? params.record.state ?? '—'}`,
      params.reportFile ? `Полный отчёт: data/reports/${fileName(params.reportFile)}` : '',
      '',
    ].filter((l) => l !== '').join('\n');
    const body = header + (params.record.reportMd ?? '(отчёт недоступен)');
    return this.finish({
      kind: 'turn-report',
      chatId: params.chatId,
      agentId: params.agentId,
      taskId: params.record.taskId,
      turn: params.turn,
      engineStatus: params.record.engineStatus,
      body,
    });
  }

  /** Исходящее сообщение произвольного вида (эскалация/подсказка помощника) —
   *  проходит тот же redaction и квоту. */
  buildCustom(params: { kind: 'escalation' | 'hint'; chatId: string; agentId: string; body: string }): OutgoingMessage {
    return this.finish({
      kind: params.kind,
      chatId: params.chatId,
      agentId: params.agentId,
      body: params.body,
    });
  }

  private finish(p: {
    kind: OutgoingMessage['kind'];
    chatId: string;
    agentId: string;
    taskId?: string;
    turn?: number;
    engineStatus?: string;
    body: string;
  }): OutgoingMessage {
    const profile = profileFor(this.deps.redaction, p.agentId, this.deps.agentToken, this.deps.defaultQuota);
    const r = redact(p.body, profile);
    if (r.truncated || r.hits.tokens > 0 || r.hits.paths > 0 || r.hits.urls > 0) {
      appendJsonl(this.journalFile, {
        ts: new Date().toISOString(),
        kind: p.kind,
        chatId: p.chatId,
        agentId: p.agentId,
        taskId: p.taskId,
        truncated: r.truncated,
        quotaChars: profile.quotaChars,
        hits: r.hits,
      });
      if (r.truncated) this.deps.log?.('warn', `[outflow] отчёт ${p.taskId ?? ''} обрезан до квоты ${profile.quotaChars} — журнальная запись добавлена`);
    }
    return {
      kind: p.kind,
      chatId: p.chatId,
      agentId: p.agentId,
      taskId: p.taskId,
      turn: p.turn,
      engineStatus: p.engineStatus,
      text: r.text,
      truncated: r.truncated,
      redactionHits: r.hits,
    };
  }
}

function fileName(path: string): string {
  const norm = path.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(i + 1) : norm;
}

export type { TaskOrigin };
