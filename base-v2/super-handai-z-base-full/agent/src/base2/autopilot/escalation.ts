// base2/autopilot/escalation.ts — B3 (K7): эскалация в ТРИ+ОДИН приёмник.
//  1) чат GLM — через outbox (WS broadcast 'autopilot.outbox');
//  2) терминал — console + broadcast pty.data;
//  3) файл data/reports/escalation-<ts>.md;
//  4) ПРИЁМНИК-АГЕНТ (эскалация-к-агенту, хотелка №9): сводка уходит
//     выбранному агенту-помощнику как ТЗ-запрос помощи; порог — ТОТ ЖЕ
//     «3 одинаковых отпечатка» (не дёргать с первого FAIL); agentId помощника
//     только из trusted-списка (config.helpers.trustedAgents, дефолт пусто).
import { resolve as resolvePath } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { getSlotBus } from '../slotBus.js';
import { BusEvents, type AgentMode } from '../types.js';
import { appendJsonl } from '../atomic.js';
import type { Ledger, TurnRecord } from './ledger.js';
import type { Outflow } from './outflow.js';

export interface EscalationDeps {
  root: string;
  reportsDir: string;
  broadcast: (msg: Record<string, unknown>) => void;
  outflow: Outflow;
  trustedAgents: string[];
  helperAgentId: string;
  kFingerprints: number;
  log?: (level: string, msg: string) => void;
}

export interface EscalationInput {
  chatId: string;
  agentId: string;
  mode: AgentMode;
  reason: string;
  detail?: string;
  ledger: Ledger;
  reportFiles?: (string | undefined)[];
  /** dispatchHelper=true — только для стопа «3 одинаковых отпечатка». */
  dispatchHelper: boolean;
}

export interface EscalationResult {
  file?: string;
  helperDispatched: boolean;
  helperReason?: string;
}

export class Escalation {
  private bus = getSlotBus();
  private journalFile: string;

  constructor(private deps: EscalationDeps) {
    this.journalFile = resolvePath(deps.root, 'data', 'logs', 'escalation.jsonl');
  }

  async raise(input: EscalationInput): Promise<EscalationResult> {
    const ts = new Date().toISOString();
    const k = Math.max(1, this.deps.kFingerprints);
    const last: TurnRecord[] = input.ledger.lastK(k);

    const lines: string[] = [];
    lines.push('# ЭСКАЛАЦИЯ автопилота');
    lines.push('');
    lines.push(`- ts: ${ts}`);
    lines.push(`- чат: ${input.chatId}`);
    lines.push(`- агент: ${input.agentId} (режим: ${input.mode})`);
    lines.push(`- причина: ${input.reason}${input.detail ? ' — ' + input.detail : ''}`);
    lines.push(`- оборотов в петле: ${input.ledger.length}`);
    lines.push('');
    lines.push(`## Последние ${last.length} отпечатка (K4)`);
    for (const t of last) {
      const fp = t.fingerprint
        ? `шаг ${t.fingerprint.step} | ${t.fingerprint.cls} | exit=${t.fingerprint.exitCode ?? '-'} | ${t.fingerprint.message}`
        : '(без отпечатка)';
      lines.push(`- оборот ${t.n} (${t.ts}): ${t.engineStatus} — ${fp}`);
    }
    lines.push('');
    lines.push('## Ссылки на отчёты оборотов');
    const files = (input.reportFiles ?? []).filter((f): f is string => !!f);
    if (files.length === 0) lines.push('- (отчёты не сохранены)');
    for (const f of files) lines.push(`- data/reports/${f.replace(/\\/g, '/').split('/').pop()}`);
    lines.push('');
    lines.push('## Что пробовали');
    if (last.length === 0) lines.push('- (оборотов нет)');
    for (const t of last) {
      lines.push(`- оборот ${t.n}: ${t.engineStatus}${t.fingerprint ? ' → ' + t.fingerprint.cls + ' на шаге ' + t.fingerprint.step : ''}`);
    }
    lines.push('');
    lines.push('## Что ожидается');
    lines.push('- Решение человека: продолжить петлю (снять стоп, изменить ТЗ/политики) или закрыть задачу.');
    lines.push('- Ответ оформи по контракту моста: ```shai-tz ...``` (или complete: true).');

    const summaryMd = lines.join('\n');

    // (1) чат GLM — outbox (redaction per-agent применяется в outflow)
    const msg = this.deps.outflow.buildCustom({ kind: 'escalation', chatId: input.chatId, agentId: input.agentId, body: summaryMd });
    this.deps.broadcast({
      type: 'autopilot.outbox',
      kind: 'escalation',
      chatId: input.chatId,
      agentId: input.agentId,
      text: msg.text,
      truncated: msg.truncated,
    });

    // (2) терминал
    const firstFp = last.length > 0 && last[last.length - 1].fingerprint
      ? `${last[last.length - 1].fingerprint!.cls}@шаг${last[last.length - 1].fingerprint!.step}`
      : '—';
    console.log(`\x1b[41m[ЭСКАЛАЦИЯ] ${input.reason}${input.detail ? ' — ' + input.detail : ''} | чат ${input.chatId} | оборотов: ${input.ledger.length} | последний отпечаток: ${firstFp}\x1b[0m`);
    this.deps.broadcast({
      type: 'pty.data',
      task: '__autopilot__',
      data: `\x1b[41m[ЭСКАЛАЦИЯ] ${input.reason} — чат ${input.chatId}, оборотов ${input.ledger.length}\x1b[0m\r\n`,
    });

    // (3) файл
    const tsFile = ts.replace(/[:.]/g, '-');
    const file = resolvePath(this.deps.reportsDir, `escalation-${tsFile}.md`);
    try {
      mkdirSync(this.deps.reportsDir, { recursive: true });
      writeFileSync(file, summaryMd, 'utf8');
    } catch (e) {
      this.deps.log?.('error', '[escalation] файл сводки не записан: ' + (e instanceof Error ? e.message : String(e)));
    }

    appendJsonl(this.journalFile, { ts, chatId: input.chatId, agentId: input.agentId, reason: input.reason, file });

    // событие для подписчиков (П-4) и памяти
    void this.bus.emit(BusEvents.autopilotEscalation, { ts, chatId: input.chatId, agentId: input.agentId, reason: input.reason, file });

    // (4) приёмник-агент — ТОЛЬКО для стопа по отпечаткам и только trusted.
    let helperDispatched = false;
    let helperReason: string | undefined;
    if (input.dispatchHelper) {
      const helper = this.deps.helperAgentId;
      if (!helper) helperReason = 'помощник не настроен (config.autopilot.helperAgentId пуст) — только человек';
      else if (helper === input.agentId) helperReason = 'помощник совпадает с проблемным агентом — не отправляю';
      else if (!this.deps.trustedAgents.includes(helper)) helperReason = `помощник "${helper}" не в trusted-списке (config.helpers.trustedAgents) — только человек`;
      else {
        const helpBody = summaryMd + '\n\n[формат ответа: блок ```shai-tz``` — ТЗ помощи; ответ придёт в петлю с origin autopilot-help]';
        const helpMsg = this.deps.outflow.buildCustom({ kind: 'escalation', chatId: input.chatId + ':help', agentId: helper, body: helpBody });
        this.deps.broadcast({
          type: 'autopilot.outbox',
          kind: 'help-request',
          chatId: input.chatId,
          toAgent: helper,
          text: helpMsg.text,
        });
        helperDispatched = true;
        helperReason = `сводка отправлена помощнику "${helper}" (origin help-request)`;
      }
    } else {
      helperReason = 'стоп не по отпечаткам — помощник не вызывается (порог: 3 одинаковых отпечатка)';
    }
    if (helperReason) this.deps.log?.('info', '[escalation] помощник: ' + helperReason);

    return { file, helperDispatched, helperReason };
  }
}
