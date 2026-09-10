import express from 'express';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { GhostweaveAudit } from './audit.js';
import { decide } from './governor.js';
import { BatchSchema, CheckOperationSchema, InboundIntentSchema, NotifySchema, OP_PREVIEW_MAX, PoliciesSchema, UUID_RE } from './schemas.js';
import type { AgpOperation } from './schemas.js';
import type { AgentIntent, AgentResult, GovernanceDecision, PolicyRule } from './types.js';

const PORT = 8790;
const POLICIES_FILE = './data/policies.json';
const AUDIT_FILE = './data/audit.jsonl';
const KILL_FILE = './data/killswitch';
const DEFAULT_RATE_LIMIT = 100;  // запросов/мин на agentId (fallback, если в политиках нет biz-001.limit)
const RATE_WINDOW_MS = 60_000;   // фиксированное окно 60 секунд
// MVP-эвристика для policy-brief (Этап 3): условно безопасные действия, не
// требующие /check. Исчерпывающий per-policy расчёт «что можно» — PRO.
const DEFAULT_SAFE_ACTIONS = ['read_file'];

const audit = new GhostweaveAudit(AUDIT_FILE);

// Шаг 5 (Этап 2). Fail-secure boot (НФТ 4.3): нарушенная хеш-цепочка аудита = запрет старта.
// Сервер не обслуживает трафик, опираясь на скомпрометированный журнал.
const bootVerify = audit.verify();
if (!bootVerify.ok) {
  console.error(`[AGP] AUDIT CHAIN BROKEN at seq ${bootVerify.brokenAt ?? '?'}`);
  process.exit(1);
}

// Шаг 2 (Этап 2). Admin-аутентификация: токен из env AGP_ADMIN_TOKEN,
// иначе генерируется при старте (randomBytes(16).hex) и печатается в консоль.
const ADMIN_TOKEN = process.env.AGP_ADMIN_TOKEN ?? randomBytes(16).toString('hex');
if (!process.env.AGP_ADMIN_TOKEN) console.log(`[AGP] admin token: ${ADMIN_TOKEN}`);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function providedAdminToken(req: express.Request): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  const alt = req.headers['x-admin-token'];
  return typeof alt === 'string' ? alt : undefined;
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const provided = providedAdminToken(req);
  if (!provided || !safeEqual(provided, ADMIN_TOKEN)) {
    res.status(403).json({ error: 'admin token required (Authorization: Bearer <AGP_ADMIN_TOKEN>)' });
    return;
  }
  next();
}

// Шаг 4 (Этап 2). Rate limit per agentId: фиксированное окно 60 c, лимит берётся из
// политики biz-001 (limit: 100), fallback — DEFAULT_RATE_LIMIT.
// TODO: Redis Cluster (условие №3 из семи) — MVP-замена in-memory.
const rateMap = new Map<string, { count: number; windowStart: number }>();
function rateLimitOk(agentId: string, limit: number): boolean {
  const now = Date.now();
  const entry = rateMap.get(agentId);
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    rateMap.set(agentId, { count: 1, windowStart: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

function rateLimitFor(policies: PolicyRule[]): number {
  const biz = policies.find(p => p.id === 'biz-001' && p.status === 'ACTIVE');
  return typeof biz?.limit === 'number' ? biz.limit : DEFAULT_RATE_LIMIT;
}

function loadPolicies(): PolicyRule[] {
  if (!existsSync(POLICIES_FILE)) return [];
  return JSON.parse(readFileSync(POLICIES_FILE, 'utf8')) as PolicyRule[];
}
function savePolicies(p: PolicyRule[]) { writeFileSync(POLICIES_FILE, JSON.stringify(p, null, 2)); }

function withEventIdUsed(d: GovernanceDecision, used?: string): GovernanceDecision & { eventId_used?: string } {
  return used ? { ...d, eventId_used: used } : d;
}

// ---- Интеграционный слой (Этап 3) ----

type CheckOutcome =
  | { ok: false; error: string; issues: string[] }
  | { ok: true; decision: GovernanceDecision; eventIdUsed?: string };

// Единый конвейер одного интента: валидация -> uuid-v7 -> kill switch ->
// rate limit -> политики -> аудит. Используется одиночным /check, пакетным
// /check/batch (Шаг 2 Этапа 3) и /agent/check-operation (Этап 4: extraPolicies —
// built-in правила операций, действуют только в рамках этого вызова).
function processIntent(raw: unknown, extraPolicies: PolicyRule[] = []): CheckOutcome {
  const parsed = InboundIntentSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'invalid intent', issues: parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  let intent = parsed.data as AgentIntent;
  if (!intent.ts) intent = { ...intent, ts: new Date().toISOString() };

  // Шаг 3 (Этап 2). Невалидный eventId -> серверный uuid-v7 (в ответе eventId_used);
  // валидный клиентский eventId сохраняется как есть.
  let eventIdUsed: string | undefined;
  if (!UUID_RE.test(intent.eventId)) {
    eventIdUsed = uuidv7();
    intent = { ...intent, eventId: eventIdUsed };
  }

  // Kill Switch: глобальный запрет (приоритетнее политик и rate limit)
  if (existsSync(KILL_FILE)) {
    const d: GovernanceDecision = { eventId: intent.eventId, decision: 'DENY', reason: 'KILL SWITCH ACTIVE', ts: new Date().toISOString() };
    audit.append(intent, d);
    return { ok: true, decision: d, eventIdUsed };
  }

  // Шаг 4 (Этап 2). Rate limit per agentId (1 интент = 1 единица бюджета)
  const policies = loadPolicies();
  if (!rateLimitOk(intent.agentId, rateLimitFor(policies))) {
    const d: GovernanceDecision = { eventId: intent.eventId, decision: 'DENY', reason: 'rate-limited', ts: new Date().toISOString() };
    audit.append(intent, d);
    return { ok: true, decision: d, eventIdUsed };
  }

  const decision = decide(intent, [...policies, ...extraPolicies]);
  audit.append(intent, decision);
  return { ok: true, decision, eventIdUsed };
}

function outcomeBody(out: CheckOutcome): GovernanceDecision & { eventId_used?: string } | { error: string; issues: string[] } {
  return out.ok ? withEventIdUsed(out.decision, out.eventIdUsed) : { error: out.error, issues: out.issues };
}

// ---- Этап 4: режим интеграции с Super_HandAI_z (локальный агент-исполнитель) ----

// Шаг 2. Строковая проверка принадлежности пути workspace (клиент — Windows/pwsh:
// сравнение без учёта регистра, разделители / и \ эквивалентны). Шлюз НЕ трогает
// файловую систему — работает только с переданными строками. Относительный
// targetPath резолвится от workspace; выход выше корня через '..' — fail-closed
// (вне workspace). Ограничения — см. README-AGP.md -> «Ограничения MVP».
function isInsideWorkspace(targetPath: string, workspace: string): boolean {
  const raw = targetPath.trim();
  const ws = workspace.trim();
  if (!raw || !ws) return true;                       // пусто — правило неприменимо
  const abs = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(raw); // C:\, C:/, UNC, /
  const segsOf = (p: string) => p.replace(/[\\/]+/g, '/').split('/').filter(s => s && s !== '.');
  const wSegs = segsOf(ws);
  const tSegs = segsOf(raw);
  const combined = abs ? tSegs : [...wSegs, ...tSegs]; // относительный путь — от workspace
  const resolved: string[] = [];
  for (const s of combined) {
    if (s === '..') {
      if (resolved.length === 0) return false;         // .. выше корня — fail-closed
      resolved.pop();
    } else resolved.push(s);
  }
  const tl = resolved.map(s => s.toLowerCase());
  const wl = wSegs.map(s => s.toLowerCase());
  if (tl.length < wl.length) return false;
  for (let i = 0; i < wl.length; i++) if (tl[i] !== wl[i]) return false;
  return true;
}

// Шаг 2. Таблица маппинга операций по умолчанию — built-in аналог deny-паттернов
// guard из ТЗ Super_HandAI_z. Приоритеты ниже sec-001 (100): явные политики
// администратора всегда главнее. Через /policies НЕ редактируются (см. README).
//   run  + Remove-Item … -Recurse  -> DENY   (ops-run-001, «DENY-кандидат»)
//   write вне workspace            -> REVIEW (ops-ws-001)
//   git  push-цели                 -> REVIEW (ops-git-001)
const OP_DENY_PRIORITY = 95;
const OP_REVIEW_PRIORITY = 85;

function operationDefaultRules(op: AgpOperation, preview: string, targetPath: string | undefined, workspace: string | undefined): PolicyRule[] {
  const rules: PolicyRule[] = [];
  if (op === 'run' && /remove-item/i.test(preview) && /-recurse\b/i.test(preview)) {
    rules.push({
      id: 'ops-run-001', type: 'security', priority: OP_DENY_PRIORITY, status: 'ACTIVE',
      match: { action: 'run' }, decision: 'DENY',
      reason: 'деструктивная команда: Remove-Item -Recurse (deny-паттерн guard Super_HandAI_z)',
    });
  }
  if (op === 'write' && targetPath && workspace && !isInsideWorkspace(targetPath, workspace)) {
    rules.push({
      id: 'ops-ws-001', type: 'security', priority: OP_REVIEW_PRIORITY, status: 'ACTIVE',
      match: { action: 'write' }, decision: 'REVIEW',
      reason: 'запись вне workspace — ручная проверка',
    });
  }
  if (op === 'git' && /\bgit\s+push\b/i.test(preview)) {
    rules.push({
      id: 'ops-git-001', type: 'security', priority: OP_REVIEW_PRIORITY, status: 'ACTIVE',
      match: { action: 'git' }, decision: 'REVIEW',
      reason: 'git push — цель требует ручной проверки',
    });
  }
  return rules;
}

const app = express();
app.use(express.json());

app.post('/check', (req, res) => {
  // TODO (mTLS): /check намеренно работает без admin-токена — агенты являются
  // клиентами, а не админами (осознанное MVP-упрощение). План: mTLS с клиентскими
  // сертификатами + allowlist CA на ingress, разделение admin/data контуров
  // (см. README-AGP.md -> «Ограничения MVP»).
  const out = processIntent(req.body);
  if (!out.ok) return res.status(400).json(outcomeBody(out));
  res.json(outcomeBody(out));
});

// Шаг 2. Пакетная проверка: массив из 1..50 интентов за один вызов — агент
// проверяет весь цикл ТЗ заранее. Ответ — массив решений в исходном порядке;
// каждый интент проходит тот же конвейер, включая расход rate-бюджета.
app.post('/check/batch', (req, res) => {
  const parsed = BatchSchema.safeParse(req.body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return res.status(400).json({ error: 'invalid batch', issues });
  }
  res.json(parsed.data.map(item => outcomeBody(processIntent(item))));
});

// Шаг 1. Компактный брифинг «что мне можно» одним запросом перед циклом работы.
// Read-only: не расходует rate limit и не пишется в аудит.
app.get('/agent/policy-brief', (req, r) => {
  const q = req.query.agentId;
  const agentId = typeof q === 'string' ? q : '';
  if (!agentId) return r.status(400).json({ error: 'agentId обязателен' });
  const policies = loadPolicies();
  const active = policies.filter(p => p.status === 'ACTIVE');
  // allowedActions: явные гранты ACTIVE ALLOW-политик + условно безопасные
  // действия, не запрещённые ни одной ACTIVE DENY-политикой (MVP-эвристика).
  const deniedActions = new Set(active.filter(p => p.decision === 'DENY' && p.match.action).map(p => p.match.action as string));
  const explicitAllowed = active.filter(p => p.decision === 'ALLOW' && p.match.action).map(p => p.match.action as string);
  const allowedActions = [...new Set([...explicitAllowed, ...DEFAULT_SAFE_ACTIONS.filter(a => !deniedActions.has(a))])];
  // deniedTargets: паттерны целей ACTIVE-политик с решением DENY/REVIEW —
  // «не тратим цикл: запрещено или нужен человек».
  const deniedTargets = [...new Set(active.filter(p => p.decision !== 'ALLOW' && p.match.targetPattern).map(p => p.match.targetPattern as string))];
  const limit = rateLimitFor(policies);
  const entry = rateMap.get(agentId);
  const freshWindow = !entry || Date.now() - entry.windowStart >= RATE_WINDOW_MS;
  const remaining = freshWindow ? limit : Math.max(0, limit - (entry?.count ?? 0));
  r.json({
    agentId,
    activePolicies: active.length,
    kill: existsSync(KILL_FILE),
    rateLimit: { limit, remaining },
    allowedActions,
    deniedTargets,
  });
});

// Шаг 3. Webhook RESULT: агент сообщает «действие выполнено» — попадает в
// audit.jsonl как запись kind=RESULT (WCP-таксономия). Агентский контур —
// без admin-токена (см. TODO mTLS в /check).
app.post('/agent/notify', (req, r) => {
  const parsed = NotifySchema.safeParse(req.body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return r.status(400).json({ error: 'invalid notify', issues });
  }
  const entry = audit.appendResult(parsed.data as AgentResult);
  r.json({ ok: true, recorded: 'RESULT', seq: entry.seq, ts: entry.ts });
});

// Шаг 1 (Этап 4). POST /agent/check-operation — обёртка над /check для клиента
// Super_HandAI_z (ТЗ-формат: RUN/RUN_BG/WRITE, EXPECT, mode auto|confirm,
// workspace-изоляция, guard с deny-паттернами; директива CHECK теперь исполняется
// шлюзом). Операция маппится на стандартный интент (action=operation,
// target=targetPath||preview) и проходит тот же конвейер (kill -> rate ->
// политики + built-in правила операций -> аудит). Ответ — стандартное решение,
// eventId генерирует сервер (клиент вернёт его в /agent/notify).
app.post('/agent/check-operation', (req, r) => {
  const parsed = CheckOperationSchema.safeParse(req.body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return r.status(400).json({ error: 'invalid check-operation', issues });
  }
  const { agentId, operation, targetPath, workspace } = parsed.data;
  // preview — первая строка команды/контента (договор: клиент шлёт первую строку,
  // сервер дополнительно обрезает до OP_PREVIEW_MAX и отбрасывает пустую строку)
  const preview = parsed.data.preview.split('\n')[0].trim().slice(0, OP_PREVIEW_MAX);
  if (!preview) {
    return r.status(400).json({ error: 'invalid check-operation', issues: ['preview: первая строка пуста'] });
  }
  const intent: AgentIntent = {
    eventId: uuidv7(),
    agentId,
    action: operation,               // маппинг: action = operation
    target: targetPath ?? preview,   // маппинг: target = targetPath || preview
    payload: { operation, preview }, // в аудит попадает сама команда (первая строка)
    context: workspace ? { workspace } : undefined,
    ts: new Date().toISOString(),
  };
  const out = processIntent(intent, operationDefaultRules(operation, preview, targetPath, workspace));
  if (!out.ok) return r.status(400).json(outcomeBody(out));
  r.json(outcomeBody(out));
});

// Шаг 2 (Этап 2). Админ-эндпоинты: POST /policies, /kill/on, /kill/off — под AGP_ADMIN_TOKEN
app.post('/policies', requireAdmin, (req, r) => {
  const parsed = PoliciesSchema.safeParse(req.body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return r.status(400).json({ error: 'invalid policies', issues });
  }
  savePolicies(parsed.data as PolicyRule[]);
  r.json({ ok: true, count: loadPolicies().length });
});

app.post('/kill/on', requireAdmin, (_q, r) => { writeFileSync(KILL_FILE, new Date().toISOString()); r.json({ kill: true }); });
app.post('/kill/off', requireAdmin, (_q, r) => {
  if (existsSync(KILL_FILE)) unlinkSync(KILL_FILE);
  r.json({ kill: false });
});

// Чтение политик и аудит — без токена (MVP-упрощение, см. Ограничения MVP)
app.get('/policies', (_q, r) => r.json(loadPolicies()));
app.get('/audit/verify', (_q, r) => r.json(audit.verify()));
app.get('/audit/tail', (req, r) => {
  const n = Math.min(Number(req.query.n) || 5, 100);
  if (!existsSync(AUDIT_FILE)) return r.json([]);
  const lines = readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean);
  r.json(lines.slice(-n).map(l => JSON.parse(l)));
});

app.listen(PORT, '127.0.0.1', () => console.log(`AGP-MVP на http://127.0.0.1:${PORT}`));
