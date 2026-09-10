import { z } from 'zod';

// RFC 4122/9562 формат (любая версия, регистр не важен); v7 проверяется отдельно по позиции версии
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Схема входящего интента для POST /check.
 * Все поля обязательны, payload/context/ts — опциональны.
 * ВАЖНО: eventId здесь — просто непустая строка. UUID-валидность проверяется
 * отдельно (Этап 2, шаг 3): невалидный eventId НЕ отклоняется, а заменяется
 * серверным uuid-v7 (в ответе возвращается eventId_used).
 */
export const InboundIntentSchema = z.object({
  eventId: z.string().min(1),
  agentId: z.string().min(1),
  action: z.string().min(1),
  target: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  ts: z.string().optional(),
});

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['ethics', 'business', 'security']),
  priority: z.number().int(),
  status: z.enum(['DRAFT', 'SHADOW', 'ACTIVE']),
  match: z.object({
    action: z.string().optional(),
    targetPattern: z.string().optional(),
  }),
  decision: z.enum(['ALLOW', 'DENY', 'REVIEW']),
  reason: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

/** Схема для POST /policies — полный массив правил (замена набора целиком). */
export const PoliciesSchema = z.array(PolicyRuleSchema);

/** Лимит пакета /check/batch (Этап 3, шаг 2): до 50 интентов за один вызов. */
export const BATCH_MAX = 50;
export const BatchSchema = z.array(InboundIntentSchema).min(1).max(BATCH_MAX);

/** Webhook /agent/notify (Этап 3, шаг 3): RESULT-отчёт агента об исполнении. */
export const NotifySchema = z.object({
  eventId: z.string().min(1),   // eventId из решения (eventId_used, если сервер генерировал свой)
  result: z.enum(['success', 'fail']),
  durationMs: z.number().int().nonnegative(),
});

/**
 * Этап 4 (шаг 1): POST /agent/check-operation — обёртка для клиента
 * Super_HandAI_z (ТЗ-формат: шаги RUN/RUN_BG/WRITE, workspace-изоляция, guard).
 * Вместо сырого интента клиент присылает операцию из своего формата; сервер
 * маппит её на интент (action=operation, target=targetPath||preview).
 * eventId клиент НЕ передаёт — сервер генерирует uuid-v7 сам (он вернётся
 * в стандартном решении и используется для /agent/notify).
 */
export const AGP_OPERATIONS = ['run', 'write', 'git'] as const;
export type AgpOperation = (typeof AGP_OPERATIONS)[number];

/** preview — первая строка команды/контента; сервер дополнительно режет до этой длины. */
export const OP_PREVIEW_MAX = 500;

export const CheckOperationSchema = z.object({
  agentId: z.string().min(1),
  operation: z.enum(AGP_OPERATIONS),
  preview: z.string().min(1),
  targetPath: z.string().min(1).optional(),   // путь цели (для write/git); иначе target = preview
  workspace: z.string().min(1).optional(),    // корень workspace-изоляции клиента (для правила ops-ws-001)
});
