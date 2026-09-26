// base2/autopilot/stopPolicy.ts — B3: стоп-критерии петли автопилота.
//  1) N оборотов без SUCCESS (рекомендация Мастера: 5);
//  2) три одинаковых отпечатка отказа подряд (per-инициатор, K9);
//  3) КОНТРАКТНОЕ поле завершения (complete: true / маркер) — стоп в УСПЕХЕ.
// Подстрока «задача завершена» в свободном тексте НИКОГДА не останавливает:
// сюда попадает только результат контрактного распознавания (tzContract).
import type { Ledger } from './ledger.js';

export type StopReason = 'no-success-N' | 'same-fingerprint-3' | 'complete';

export interface StopDecision {
  stop: boolean;
  reason?: StopReason;
  detail?: string;
}

export interface StopPolicyInput {
  ledger: Ledger;
  /** true — контрактное поле завершения распознано (успешный стоп). */
  complete: boolean;
  maxTurnsNoSuccess: number;
  fingerprintThreshold: number; // 3
}

export function evaluateStopPolicy(input: StopPolicyInput): StopDecision {
  // 3) контрактное завершение — приоритетнее (успех).
  if (input.complete) {
    return { stop: true, reason: 'complete', detail: 'контрактное поле завершения' };
  }
  const sinceSuccess = input.ledger.turnsSinceSuccess();
  const consecutive = input.ledger.consecutiveSameFingerprints();

  // 2) три одинаковых отпечатка подряд.
  if (consecutive >= input.fingerprintThreshold) {
    return {
      stop: true,
      reason: 'same-fingerprint-3',
      detail: `${consecutive} одинаковых отпечатков подряд (порог ${input.fingerprintThreshold})`,
    };
  }
  // 1) N оборотов без SUCCESS.
  if (sinceSuccess >= input.maxTurnsNoSuccess) {
    return {
      stop: true,
      reason: 'no-success-N',
      detail: `${sinceSuccess} оборотов без SUCCESS (порог ${input.maxTurnsNoSuccess})`,
    };
  }
  return { stop: false };
}
