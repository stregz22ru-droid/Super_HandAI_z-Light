"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckOperationSchema = exports.OP_PREVIEW_MAX = exports.AGP_OPERATIONS = exports.NotifySchema = exports.BatchSchema = exports.BATCH_MAX = exports.PoliciesSchema = exports.PolicyRuleSchema = exports.InboundIntentSchema = exports.UUID_RE = void 0;
const zod_1 = require("zod");
// RFC 4122/9562 формат (любая версия, регистр не важен); v7 проверяется отдельно по позиции версии
exports.UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Схема входящего интента для POST /check.
 * Все поля обязательны, payload/context/ts — опциональны.
 * ВАЖНО: eventId здесь — просто непустая строка. UUID-валидность проверяется
 * отдельно (Этап 2, шаг 3): невалидный eventId НЕ отклоняется, а заменяется
 * серверным uuid-v7 (в ответе возвращается eventId_used).
 */
exports.InboundIntentSchema = zod_1.z.object({
    eventId: zod_1.z.string().min(1),
    agentId: zod_1.z.string().min(1),
    action: zod_1.z.string().min(1),
    target: zod_1.z.string().min(1),
    payload: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional(),
    context: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional(),
    ts: zod_1.z.string().optional(),
});
exports.PolicyRuleSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    type: zod_1.z.enum(['ethics', 'business', 'security']),
    priority: zod_1.z.number().int(),
    status: zod_1.z.enum(['DRAFT', 'SHADOW', 'ACTIVE']),
    match: zod_1.z.object({
        action: zod_1.z.string().optional(),
        targetPattern: zod_1.z.string().optional(),
    }),
    decision: zod_1.z.enum(['ALLOW', 'DENY', 'REVIEW']),
    reason: zod_1.z.string().optional(),
    limit: zod_1.z.number().int().positive().optional(),
});
/** Схема для POST /policies — полный массив правил (замена набора целиком). */
exports.PoliciesSchema = zod_1.z.array(exports.PolicyRuleSchema);
/** Лимит пакета /check/batch (Этап 3, шаг 2): до 50 интентов за один вызов. */
exports.BATCH_MAX = 50;
exports.BatchSchema = zod_1.z.array(exports.InboundIntentSchema).min(1).max(exports.BATCH_MAX);
/** Webhook /agent/notify (Этап 3, шаг 3): RESULT-отчёт агента об исполнении. */
exports.NotifySchema = zod_1.z.object({
    eventId: zod_1.z.string().min(1), // eventId из решения (eventId_used, если сервер генерировал свой)
    result: zod_1.z.enum(['success', 'fail']),
    durationMs: zod_1.z.number().int().nonnegative(),
});
/**
 * Этап 4 (шаг 1): POST /agent/check-operation — обёртка для клиента
 * Super_HandAI_z (ТЗ-формат: шаги RUN/RUN_BG/WRITE, workspace-изоляция, guard).
 * Вместо сырого интента клиент присылает операцию из своего формата; сервер
 * маппит её на интент (action=operation, target=targetPath||preview).
 * eventId клиент НЕ передаёт — сервер генерирует uuid-v7 сам (он вернётся
 * в стандартном решении и используется для /agent/notify).
 */
exports.AGP_OPERATIONS = ['run', 'write', 'git'];
/** preview — первая строка команды/контента; сервер дополнительно режет до этой длины. */
exports.OP_PREVIEW_MAX = 500;
exports.CheckOperationSchema = zod_1.z.object({
    agentId: zod_1.z.string().min(1),
    operation: zod_1.z.enum(exports.AGP_OPERATIONS),
    preview: zod_1.z.string().min(1),
    targetPath: zod_1.z.string().min(1).optional(), // путь цели (для write/git); иначе target = preview
    workspace: zod_1.z.string().min(1).optional(), // корень workspace-изоляции клиента (для правила ops-ws-001)
});
//# sourceMappingURL=schemas.js.map