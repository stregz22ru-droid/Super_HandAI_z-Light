// base2/check/types.ts — вердикты CHECK.
export type CheckVerdict = 'ALLOW' | 'DENY' | 'CONFIRM' | 'MODIFY';

export interface CheckDecisionEntry {
  ts: string;
  taskId: string;
  agentId: string;
  step: number;
  kind: string;
  cmdHash: string;
  cmd: string;
  verdict: CheckVerdict;
  source: 'cache' | 'agp' | 'fail-closed' | 'guard-final';
  latencyMs: number;
  reason?: string;
  mode: string;
}
