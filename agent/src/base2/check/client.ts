// base2/check/client.ts — B4: клиент AGP /agent/check-operation.
// Бюджет 1.5 с (таймаут), ответ маппится на вердикты CHECK:
//   AGP ALLOW  → ALLOW
//   AGP REVIEW → CONFIRM (требуется оператор)
//   AGP DENY   → DENY
//   MODIFY     → DENY с предложением в комментарии (авто-подмена вне первой версии)
import type { CheckVerdict } from './types.js';

export interface CheckOperationInput {
  url: string;
  timeoutMs: number;
  agentId: string;
  operation: 'run';
  script: string;
  workspace: string;
  mode: string;
  step: number;
  taskId: string;
}

export interface CheckRemoteResult {
  verdict: CheckVerdict;
  source: 'agp';
  latencyMs: number;
  reason?: string;
  eventId?: string;
}

interface AgpResponse {
  ok?: boolean;
  error?: string;
  issues?: string[];
  decision?: { decision?: string; reason?: string; eventId?: string };
  eventIdUsed?: string;
}

/** Вызов шлюза. Ошибка (недоступен/таймаут/невалидный ответ) — throw; решение
 *  fail-closed принимает вызывающий код (check/directive.ts) по классу команды. */
export async function checkOperation(input: CheckOperationInput): Promise<CheckRemoteResult> {
  const started = Date.now();
  const body = {
    agentId: input.agentId,
    operation: input.operation,
    preview: input.script.split('\n')[0] || input.script,
    workspace: input.workspace,
  };
  const res = await fetch(input.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  const latencyMs = Date.now() - started;
  const text = await res.text();
  let parsed: AgpResponse;
  try {
    parsed = JSON.parse(text) as AgpResponse;
  } catch {
    throw new Error(`AGP вернул не-JSON (HTTP ${res.status}): ${text.slice(0, 120)}`);
  }
  if (!res.ok || parsed.error) {
    throw new Error(`AGP HTTP ${res.status}: ${parsed.error ?? '(без ошибки)'}${parsed.issues?.length ? ' — ' + parsed.issues.join('; ') : ''}`);
  }
  const raw = (parsed.decision?.decision ?? '').toUpperCase();
  const reason = parsed.decision?.reason;
  const eventId = parsed.decision?.eventId ?? parsed.eventIdUsed;
  let verdict: CheckVerdict;
  if (raw === 'ALLOW') verdict = 'ALLOW';
  else if (raw === 'REVIEW') verdict = 'CONFIRM';
  else if (raw === 'DENY') verdict = 'DENY';
  else if (raw === 'MODIFY') verdict = 'MODIFY';
  else throw new Error(`AGP вернул неизвестный вердикт "${raw}"`);
  return { verdict, source: 'agp', latencyMs, ...(reason ? { reason } : {}), ...(eventId ? { eventId } : {}) };
}
