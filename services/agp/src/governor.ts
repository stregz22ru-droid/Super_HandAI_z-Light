import type { AgentIntent, PolicyRule, GovernanceDecision, Decision } from './types.js';

export function decide(intent: AgentIntent, policies: PolicyRule[]): GovernanceDecision {
  const ts = new Date().toISOString();
  const active = policies
    .filter(p => p.status === 'ACTIVE' || p.status === 'SHADOW')
    .filter(p => {
      if (p.match.action && p.match.action !== intent.action) return false;
      if (p.match.targetPattern && !new RegExp(p.match.targetPattern).test(intent.target)) return false;
      return true;
    })
    .sort((a, b) => b.priority - a.priority);

  const shadowHits = active.filter(p => p.status === 'SHADOW');
  const enforce = active.filter(p => p.status === 'ACTIVE');

  let decision: Decision = 'ALLOW';
  let matchedPolicy: string | undefined;
  for (const p of enforce) {
    decision = p.decision;
    matchedPolicy = p.id;
    if (p.decision === 'DENY') break; // первый DENY по приоритету — финален
  }
  // SHADOW не влияет на решение, но должен попасть в reason
  const reasonParts: string[] = [];
  if (shadowHits.length) reasonParts.push('shadow:' + shadowHits.map(s => s.id).join(','));
  if (matchedPolicy) reasonParts.push('matched:' + matchedPolicy);
  return { eventId: intent.eventId, decision, matchedPolicy, reason: reasonParts.join('; ') || 'default-allow', ts };
}
