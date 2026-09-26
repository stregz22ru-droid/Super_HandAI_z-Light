// Типы AGP-MVP — согласованы с WCP v0.3 Draft (поля BaseEvent)
export type Decision = 'ALLOW' | 'DENY' | 'REVIEW';
export type PolicyType = 'ethics' | 'business' | 'security';
export type PolicyStatus = 'DRAFT' | 'SHADOW' | 'ACTIVE';

export interface AgentIntent {
  eventId: string;            // uuid-v7 желателен
  agentId: string;
  action: string;             // 'call_api' | 'write_file' | 'shell' | ...
  target: string;             // URL/путь/получатель
  payload?: Record<string, unknown>;
  context?: Record<string, unknown>;
  ts: string;
}

export interface PolicyRule {
  id: string;
  type: PolicyType;
  priority: number;           // выше = важнее
  status: PolicyStatus;
  match: { action?: string; targetPattern?: string };
  decision: Decision;
  reason?: string;
  limit?: number;             // rate-limit (запросов/мин на agentId), напр. biz-001
}

export interface GovernanceDecision {
  eventId: string;
  decision: Decision;
  matchedPolicy?: string;
  reason?: string;
  ts: string;
}

// WCP-таксономия аудита: INTENT (решение шлюза) и RESULT (отчёт агента
// об исполнении) — обе живут в одной append-only хеш-цепочке.
export type AuditKind = 'INTENT' | 'RESULT';

export interface AgentResult {
  eventId: string;            // eventId из решения (eventId_used, если заменялся)
  result: 'success' | 'fail';
  durationMs: number;
}

export interface AuditIntentEntry {
  seq: number;
  ts: string;
  kind: AuditKind;            // 'INTENT'
  intent: AgentIntent;
  decision: GovernanceDecision;
  prevHash: string;
  hash: string;               // sha256(seq|ts|intent|decision|prevHash) — формула не менялась с Этапа 1
}

export interface AuditResultEntry {
  seq: number;
  ts: string;
  kind: AuditKind;            // 'RESULT'
  result: AgentResult;
  prevHash: string;
  hash: string;               // sha256(seq|ts|RESULT|result|prevHash) — доменная метка RESULT
}

export type AuditEntry = AuditIntentEntry | AuditResultEntry;
