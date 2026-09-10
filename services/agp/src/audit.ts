import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { AgentIntent, AgentResult, AuditEntry, AuditIntentEntry, AuditResultEntry, GovernanceDecision } from './types.js';

export class GhostweaveAudit {
  constructor(private filePath: string) {}
  private lastHash(): string {
    if (!existsSync(this.filePath)) return '0'.repeat(64);
    const lines = readFileSync(this.filePath, 'utf8').trim().split('\n');
    const last = lines[lines.length - 1];
    try { return (JSON.parse(last) as AuditEntry).hash; } catch { return '0'.repeat(64); }
  }
  // INTENT-событие: решение шлюза по интенту (формула хеша неизменна с Этапа 1)
  append(intent: AgentIntent, decision: GovernanceDecision): AuditIntentEntry {
    const prev = this.lastHash();
    const seq = this.size() + 1;
    const ts = new Date().toISOString();
    const hash = createHash('sha256')
      .update(seq + '|' + ts + '|' + JSON.stringify(intent) + '|' + JSON.stringify(decision) + '|' + prev)
      .digest('hex');
    const entry: AuditIntentEntry = { seq, ts, kind: 'INTENT', intent, decision, prevHash: prev, hash };
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  }
  // RESULT-событие: отчёт агента «действие выполнено» (Этап 3, шаг 3)
  appendResult(result: AgentResult): AuditResultEntry {
    const prev = this.lastHash();
    const seq = this.size() + 1;
    const ts = new Date().toISOString();
    // Доменная метка 'RESULT' в хеше: INTENT- и RESULT-записи невозможно спутать
    const hash = createHash('sha256')
      .update(seq + '|' + ts + '|RESULT|' + JSON.stringify(result) + '|' + prev)
      .digest('hex');
    const entry: AuditResultEntry = { seq, ts, kind: 'RESULT', result, prevHash: prev, hash };
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  }
  size(): number {
    if (!existsSync(this.filePath)) return 0;
    return readFileSync(this.filePath, 'utf8').trim().split('\n').filter(Boolean).length;
  }
  verify(): { ok: boolean; brokenAt?: number } {
    if (!existsSync(this.filePath)) return { ok: true };
    const lines = readFileSync(this.filePath, 'utf8').trim().split('\n').filter(Boolean);
    let prev = '0'.repeat(64);
    for (let i = 0; i < lines.length; i++) {
      let e: any;
      try { e = JSON.parse(lines[i]); }
      catch { return { ok: false, brokenAt: i + 1 }; } // битый JSON = битая цепь (fail-secure)
      // Записи без kind (Этапы 1–2) трактуются как INTENT — обратная совместимость
      const expect = e && e.kind === 'RESULT'
        ? createHash('sha256')
            .update(e.seq + '|' + e.ts + '|RESULT|' + JSON.stringify(e.result) + '|' + prev)
            .digest('hex')
        : createHash('sha256')
            .update(e.seq + '|' + e.ts + '|' + JSON.stringify(e.intent) + '|' + JSON.stringify(e.decision) + '|' + prev)
            .digest('hex');
      if (e.prevHash !== prev || e.hash !== expect) return { ok: false, brokenAt: i + 1 };
      prev = e.hash;
    }
    return { ok: true };
  }
}
