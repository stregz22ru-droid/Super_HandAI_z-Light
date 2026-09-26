// features/registry.ts — Система фич: реестр, манифесты, слоты, диспетчеризация.
// НОВЫЙ ФАЙЛ (СИСТЕМА ФИЧ) — ядро не ломается: движок вызывает только
// featuresBeforeRun/featuresAfterRun/featuresOnFail (+ с Этапа 1 —
// featuresSessionStart), которые безопасно но-опятся, если реестр не
// активирован (setActiveRegistry не вызывался).
//
// ЭТАП 1 (МОДУЛЬ 2 — hooks-контракты stepEngine, по Ponytail-Research табл. 9):
//   2.1) слот onSessionStart — активация фич по умолчанию на сессию задачи;
//        session-состояние (beginSession/getSessionState/endSession).
//   2.2) additionalContext-канал: любой хук-слот может вернуть не только
//        skip/modify, но и additionalContext[] — аддитивный канал в журнал
//        и следующий промт (никогда не влияет на вердикт).
//   2.3) Never-block контракт: каждый вызов слота обёрнут в тайм-бюджет
//        (setSlotBudgetMs), ошибки гасятся (silent fail), слот может объявить
//        самовыход (disableSelf) — слот НИКОГДА не роняет цикл задачи.
//   2.4) Windows-гигиена внешних хуков — см. core/externalHooks.ts
//        (BOM-strip, CRLF, plain node, allowlist).
// Совместимость: старые фичи (без additionalContext/disableSelf) работают как раньше.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------- Типы ----------

export type SlotName = 'onSessionStart' | 'beforeRun' | 'afterRun' | 'onFail' | 'route';
export const SLOT_NAMES: SlotName[] = ['onSessionStart', 'beforeRun', 'afterRun', 'onFail', 'route'];
const HOOK_SLOTS: SlotName[] = ['onSessionStart', 'beforeRun', 'afterRun', 'onFail'];

/** Фичи, поставляемые с ядром (запрещено удалять через DELETE /features/:name). */
export const BUNDLED_FEATURES = ['reflect', 'dry-run', 'context-pack'];

/** Подрежим фичи: флаг в config.features, переключается toggle'ом без рестарта. */
export interface FeatureSubmode {
  name: string; // [a-z0-9-]{2,32} — ключ в config.features (напр. dry-run-active)
  description: string; // подсказка для OPERATOR-панели (title кнопки)
}

export interface FeatureManifest {
  name: string; // [a-z0-9-]{2,32}, совпадает с именем файла
  title: string;
  description: string;
  version: string; // x.y.z
  slot: SlotName[];
  dependencies: string[];
  minCore: string; // x.y.z — минимальная версия ядра
  submodes?: FeatureSubmode[]; // опционально: подрежимы для one-click toggle в UI
}

export interface FeatureContext {
  coreVersion: string;
  /** Живая ссылка на config.features — подрежимы (напр. dry-run-active) читаются на каждом шаге */
  config: { features: Record<string, boolean> };
  /** ЭТАП 1 (2.1): живая ссылка на session-состояние задачи (flags/context). */
  session: SessionState;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
  registerRoute(
    method: 'GET' | 'POST' | 'DELETE' | 'PUT',
    path: string,
    handler: (req: any, res: any) => void,
  ): void;
  gitStatus(): Promise<string>;
  journalTail(n: number): Promise<unknown[]>;
  versions(): Record<string, unknown>;
}

export interface FeatureRecord {
  name: string; // stem файла; при валидном манифесте = manifest.name
  file: string;
  manifest: FeatureManifest | null;
  enabled: boolean; // из config.features
  loaded: boolean; // фактически загружена (манифест/зависимости/minCore ок)
  bundled: boolean;
  errors: string[];
}

/** Событие для слотов afterRun/onFail — что произошло с директивой. */
export interface SlotRunInfo {
  taskId?: string;
  i: number;
  kind: 'RUN' | 'RUN_BG' | 'WRITE' | 'GIT';
  status: 'ok' | 'fail' | 'denied';
  cmd?: string;
  exitCode?: number;
  durationMs?: number;
  note?: string;
}

export interface BeforeRunVerdict {
  skip?: boolean;
  reason?: string;
  // ЭТАП 1 (2.2): аддитивный контекст — в журнал/следующий промт, не влияет на вердикт.
  additionalContext?: string[];
  // ЭТАП 1 (2.3): самовыход — обработчики фичи отключаются до конца сессии.
  disableSelf?: boolean;
    // Base-этап 2: deny-вердикт от CHECK-директивы
    deny?: { reason: string };
}

/** Вердикт слота onSessionStart (ЭТАП 1, 2.1). */
export interface SessionStartVerdict {
  /** Контекст сессии — в журнал и следующий промт. */
  additionalContext?: string[];
  /** Session-флаги по умолчанию (напр. { 'dry-run-active': true } на эту сессию). */
  flags?: Record<string, boolean>;
  disableSelf?: boolean;
    // Base-этап 2: deny-вердикт от CHECK-директивы
    deny?: { reason: string };
}

/**
 * Session-состояние задачи (ЭТАП 1, 2.1). Живая ссылка выдаётся фичам через
 * FeatureContext.session — фичи могут читать/писать flags и context на любом слоте.
 * НЕ персистится: живёт ровно одну сессию (одну задачу).
 */
export interface SessionState {
  taskId: string | null;
  workspace: string | null;
  stepCount: number;
  startedAt: string | null;
  /** Флаги сессии (поверх config.features, только на эту сессию). */
  flags: Record<string, boolean>;
  /** additionalContext-канал (2.2): собранный контекст сессии. */
  context: string[];
}

const CONTEXT_MAX_ENTRIES = 50;
const CONTEXT_MAX_LEN = 2000;

function emptySession(): SessionState {
  return { taskId: null, workspace: null, stepCount: 0, startedAt: null, flags: {}, context: [] };
}

let session: SessionState = emptySession();

/**
 * Начало сессии (вызывает stepEngine в начале каждой задачи).
 * Мутирует ТОТ ЖЕ объект session (не пересоздаёт) — живые ссылки ctx.session
 * у фич остаются валидными всю жизнь процесса.
 */
export function beginSession(taskId: string, workspace: string, stepCount: number): SessionState {
  disabledFeatures.clear();
  session.taskId = taskId;
  session.workspace = workspace;
  session.stepCount = stepCount;
  session.startedAt = new Date().toISOString();
  for (const k of Object.keys(session.flags)) delete session.flags[k];
  session.context.length = 0;
  return session;
}

export function endSession(): void {
  disabledFeatures.clear();
  session.taskId = null;
  session.workspace = null;
  session.stepCount = 0;
  session.startedAt = null;
  for (const k of Object.keys(session.flags)) delete session.flags[k];
  session.context.length = 0;
}

export function getSessionState(): SessionState {
  return session;
}

/** Добавление в additionalContext-канал с капами (защита от переполнения). */
export function pushSessionContext(text: string): void {
  if (typeof text !== 'string' || text.trim().length === 0) return;
  if (session.context.length >= CONTEXT_MAX_ENTRIES) return;
  const t = text.length > CONTEXT_MAX_LEN ? text.slice(0, CONTEXT_MAX_LEN) + '…' : text;
  session.context.push(t);
}

// --- ЭТАП 1 (2.3): Never-block — тайм-бюджет слотов ---------------------------

export const DEFAULT_SLOT_BUDGET_MS = 2000;
let slotBudgetMs = DEFAULT_SLOT_BUDGET_MS;
export function setSlotBudgetMs(ms: number): void {
  if (Number.isFinite(ms) && ms >= 0) slotBudgetMs = ms;
}
export function getSlotBudgetMs(): number {
  return slotBudgetMs;
}

/** Самовыход слота (disableSelf): имена фич, отключённых до конца сессии. */
const disabledFeatures = new Set<string>();

async function withSlotBudget<T>(slot: string, feature: string, fn: () => T | Promise<T>): Promise<{ value?: T; error?: string; timedOut?: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const race = await Promise.race([
      Promise.resolve()
        .then(fn)
        .then((value) => ({ value }))
        .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })),
      new Promise<{ error: string; timedOut: boolean }>((res) => {
        timer = setTimeout(() => res({ error: `бюджет ${slotBudgetMs}ms исчерпан`, timedOut: true }), slotBudgetMs);
      }),
    ]);
    return race as { value?: T; error?: string; timedOut?: boolean };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Извлечение additionalContext из вердикта любого слота (2.2, аддитивно). */
function collectContext(verdict: unknown): void {
  if (!verdict || typeof verdict !== 'object') return;
  const v = verdict as { additionalContext?: unknown };
  if (Array.isArray(v.additionalContext)) {
    for (const c of v.additionalContext) {
      if (typeof c === 'string') pushSessionContext(c);
    }
  }
}

/** disableSelf из вердикта — фича отключается до конца сессии (2.3). */
function applyDisableSelf(verdict: unknown, feature: string): void {
  if (!verdict || typeof verdict !== 'object') return;
  if ((verdict as { disableSelf?: unknown }).disableSelf === true) {
    disabledFeatures.add(feature);
    emitLog('warn', `слот: фича "${feature}" объявила самовыход (disableSelf) — отключена до конца сессии`);
  }
}

type SlotFn = (...args: any[]) => any;
type FeatureModule = { manifest: FeatureManifest; create: (ctx: FeatureContext) => Record<string, SlotFn> };

export interface LoadReport {
  loaded: string[];
  skipped: { name: string; reason: string }[];
  errors: string[];
}

// ---------- Валидация ----------

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const VER_RE = /^\d+\.\d+\.\d+$/;

function isStr(x: unknown): x is string {
  return typeof x === 'string';
}

export function validateManifest(raw: unknown): { manifest?: FeatureManifest; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: ['manifest: должен быть объектом с полями name/title/description/version/slot/dependencies/minCore'] };
  }
  const m = raw as Record<string, unknown>;
  if (!isStr(m.name) || !NAME_RE.test(m.name)) errors.push('manifest.name: обязателен, формат [a-z0-9-]{2,32}');
  if (!isStr(m.title) || m.title.trim().length === 0) errors.push('manifest.title: обязателен, непустая строка');
  if (!isStr(m.description) || m.description.trim().length === 0) errors.push('manifest.description: обязателен, непустая строка');
  if (!isStr(m.version) || !VER_RE.test(m.version)) errors.push('manifest.version: обязателен, формат x.y.z');
  if (!Array.isArray(m.slot) || m.slot.length === 0 || !m.slot.every((s) => SLOT_NAMES.includes(s as SlotName))) {
    errors.push(`manifest.slot: обязателен непустой массив из ${SLOT_NAMES.join(' | ')}`);
  }
  if (!Array.isArray(m.dependencies) || !m.dependencies.every((d) => isStr(d) && NAME_RE.test(d))) {
    errors.push('manifest.dependencies: обязателен массив имён фич (может быть пустым)');
  }
  if (!isStr(m.minCore) || !VER_RE.test(m.minCore)) errors.push('manifest.minCore: обязателен, формат x.y.z');
  // СИСТЕМА ФИЧ: необязательные подрежимы (one-click toggle в OPERATOR-панели).
  let submodes: FeatureSubmode[] | undefined;
  if (m.submodes !== undefined) {
    if (!Array.isArray(m.submodes)) {
      errors.push('manifest.submodes: если указан — должен быть массивом {name, description}');
    } else {
      const seen = new Set<string>();
      submodes = [];
      m.submodes.forEach((sm, idx) => {
        const o = sm as Record<string, unknown>;
        if (!o || typeof o !== 'object' || Array.isArray(o)) {
          errors.push(`manifest.submodes[${idx}]: должен быть объектом {name, description}`);
          return;
        }
        if (!isStr(o.name) || !NAME_RE.test(o.name)) {
          errors.push(`manifest.submodes[${idx}].name: формат [a-z0-9-]{2,32}`);
          return;
        }
        if (seen.has(o.name)) {
          errors.push(`manifest.submodes[${idx}].name: дубликат "${o.name}"`);
          return;
        }
        if (!isStr(o.description) || o.description.trim().length === 0) {
          errors.push(`manifest.submodes[${idx}].description: обязателен, непустая строка`);
          return;
        }
        if (o.name === m.name) {
          errors.push(`manifest.submodes[${idx}].name: совпадает с именем самой фичи "${m.name}"`);
          return;
        }
        seen.add(o.name);
        submodes!.push({ name: o.name, description: o.description });
      });
      if (submodes.length === 0) submodes = undefined;
    }
  }
  if (errors.length > 0) return { errors };
  return {
    manifest: {
      name: m.name as string,
      title: m.title as string,
      description: m.description as string,
      version: m.version as string,
      slot: m.slot as SlotName[],
      dependencies: m.dependencies as string[],
      minCore: m.minCore as string,
      ...(submodes ? { submodes } : {}),
    },
    errors: [],
  };
}

/** Сравнение semver-lite (x.y.z): -1/0/1 */
export function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

// ---------- Глобальный лог-синк (терминал UI) ----------

type LogSink = (level: string, msg: string) => void;
let logSink: LogSink | null = null;
export function setFeatureLogSink(fn: LogSink | null): void {
  logSink = fn;
}
function emitLog(level: string, msg: string): void {
  const line = `[фича:${level}] ${msg}`;
  if (logSink) {
    try {
      logSink(level, line);
    } catch {
      /* синк не должен ронять фичи */
    }
  }
  console.log(line);
}

// ---------- Активный реестр (для слотов движка) ----------

let activeRegistry: FeatureRegistry | null = null;
export function setActiveRegistry(r: FeatureRegistry | null): void {
  activeRegistry = r;
}
/** ЭТАП 1: чтение активного реестра (ограда активации в server.ts broadcast). */
export function getActiveRegistry(): FeatureRegistry | null {
  return activeRegistry;
}

/** Публичное логирование фич (console + синк терминала UI, если установлен). */
export function featureLog(level: string, msg: string): void {
  emitLog(level, msg);
}

/**
 * ЭТАП 1 (2.1): слот onSessionStart — старт сессии задачи.
 * Возвращает собранный additionalContext (журнал + следующий промт).
 * Флаги вердиктов накладываются на session.flags (активация по умолчанию на сессию).
 */
export async function featuresSessionStart(info: { taskId: string; workspace: string; stepCount: number }): Promise<string[]> {
  beginSession(info.taskId, info.workspace, info.stepCount);
  const reg = activeRegistry;
  if (!reg) return [];
  const fns = reg.slotFns('onSessionStart');
  for (let idx = 0; idx < fns.length; idx++) {
    const feature = reg.slotFeatureNames('onSessionStart')[idx] ?? `#${idx}`;
    const r = await withSlotBudget<SessionStartVerdict | void>('onSessionStart', feature, () => fns[idx](info));
    if (r.error) {
      emitLog('error', `onSessionStart (${feature}): ${r.error}`);
      continue; // never-block: ошибка/таймаут не роняют сессию
    }
    const v = r.value;
    if (v && typeof v === 'object') {
      collectContext(v);
      if (v.flags && typeof v.flags === 'object') {
        for (const [k, val] of Object.entries(v.flags)) {
          if (typeof val === 'boolean') session.flags[k] = val;
        }
      }
      applyDisableSelf(v, feature);
    }
  }
  return [...session.context];
}

/**
 * Слот beforeRun: первая фича, вернувшая {skip:true}, решает. Ошибки фич не роняют движок.
 * ЭТАП 1: каждый вызов под тайм-бюджетом (never-block), additionalContext собирается,
 * disableSelf отключает фичу до конца сессии.
 */
export async function featuresBeforeRun(i: number, directive: unknown): Promise<BeforeRunVerdict | undefined> {
  const reg = activeRegistry;
  if (!reg) return undefined;
  const fns = reg.slotFns('beforeRun');
  const names = reg.slotFeatureNames('beforeRun');
  for (let idx = 0; idx < fns.length; idx++) {
    const feature = names[idx] ?? `#${idx}`;
    const r = await withSlotBudget<BeforeRunVerdict | undefined>('beforeRun', feature, () => fns[idx](i, directive));
    if (r.error) {
      emitLog('error', `beforeRun (${feature}): ${r.error}`);
      continue;
    }
    const v = r.value;
    if (v && typeof v === 'object') {
      collectContext(v);
      applyDisableSelf(v, feature);
      if (v.skip === true) return v;
    }
  }
  return undefined;
}

/** Слот afterRun: уведомление после исполнения директивы (ЭТАП 1: бюджет + context + самовыход). */
export async function featuresAfterRun(i: number, info: SlotRunInfo): Promise<void> {
  const reg = activeRegistry;
  if (!reg) return;
  const fns = reg.slotFns('afterRun');
  const names = reg.slotFeatureNames('afterRun');
  for (let idx = 0; idx < fns.length; idx++) {
    const feature = names[idx] ?? `#${idx}`;
    const r = await withSlotBudget<void | { additionalContext?: string[]; disableSelf?: boolean }>('afterRun', feature, () => fns[idx](i, info));
    if (r.error) {
      emitLog('error', `afterRun (${feature}): ${r.error}`);
      continue;
    }
    if (r.value && typeof r.value === 'object') {
      collectContext(r.value);
      applyDisableSelf(r.value, feature);
    }
  }
}

/** Слот onFail: уведомление при отказе/запрете директивы (ЭТАП 1: бюджет + context + самовыход). */
export async function featuresOnFail(i: number, failReason: string, info?: Partial<SlotRunInfo>): Promise<void> {
  const reg = activeRegistry;
  if (!reg) return;
  const fns = reg.slotFns('onFail');
  const names = reg.slotFeatureNames('onFail');
  for (let idx = 0; idx < fns.length; idx++) {
    const feature = names[idx] ?? `#${idx}`;
    const r = await withSlotBudget<void | { additionalContext?: string[]; disableSelf?: boolean }>('onFail', feature, () => fns[idx](i, failReason, info));
    if (r.error) {
      emitLog('error', `onFail (${feature}): ${r.error}`);
      continue;
    }
    if (r.value && typeof r.value === 'object') {
      collectContext(r.value);
      applyDisableSelf(r.value, feature);
    }
  }
}

// ---------- Реестр ----------

interface RecWithModule extends FeatureRecord {
  __mod?: FeatureModule;
}

export class FeatureRegistry {
  private records: RecWithModule[] = [];
  private loadedNames: string[] = [];
  private handlerMap = new Map<string, Record<string, SlotFn>>(); // featureName -> slot fns

  constructor(
    private featuresDir: string,
    private coreVersion: string,
  ) {}

  /** Читает *.feature.js из папки фич. Ошибки манифеста/импорта — в список, не падение. */
  async scanFeatures(): Promise<{ scanned: number; errors: string[] }> {
    this.records = [];
    this.loadedNames = [];
    this.handlerMap.clear();
    const errors: string[] = [];
    if (!existsSync(this.featuresDir)) {
      return { scanned: 0, errors: [`папка фич не найдена: ${this.featuresDir}`] };
    }
    const files = readdirSync(this.featuresDir)
      .filter((f) => f.endsWith('.feature.js'))
      .sort();
    for (const file of files) {
      const full = join(this.featuresDir, file);
      const stem = file.slice(0, -'.feature.js'.length);
      const rec: RecWithModule = {
        name: stem,
        file: full,
        manifest: null,
        enabled: false,
        loaded: false,
        bundled: BUNDLED_FEATURES.includes(stem),
        errors: [],
      };
      let mod: FeatureModule;
      try {
        mod = (await import(pathToFileURL(full).href)) as FeatureModule;
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        rec.errors.push(`import: ${m}`);
        errors.push(`${file}: import: ${m}`);
        this.records.push(rec);
        continue;
      }
      rec.__mod = mod;
      const v = validateManifest(mod.manifest);
      if (v.errors.length > 0) {
        rec.errors.push(...v.errors);
        errors.push(...v.errors.map((x) => `${file}: ${x}`));
        this.records.push(rec);
        continue;
      }
      rec.manifest = v.manifest!;
      rec.name = v.manifest!.name;
      if (rec.name !== stem) {
        rec.errors.push(`manifest.name "${rec.name}" не совпадает с именем файла "${stem}.feature.js"`);
      }
      this.records.push(rec);
    }
    return { scanned: files.length, errors };
  }

  /**
   * Регистрирует только включённые в config.features фичи. Зависимости:
   * фича не включается, если зависимость выключена/не загрузилась/отсутствует.
   * minCore выше версии ядра — фича не включается.
   */
  loadEnabled(features: Record<string, boolean>, ctx: FeatureContext): LoadReport {
    const report: LoadReport = { loaded: [], skipped: [], errors: [] };
    for (const rec of this.records) {
      rec.enabled = rec.manifest != null && features[rec.manifest.name] === true;
    }
    // minCore-фильтр
    for (const rec of this.records) {
      if (rec.enabled && rec.manifest && cmpSemver(rec.manifest.minCore, this.coreVersion) > 0) {
        const reason = `minCore ${rec.manifest.minCore} > версии ядра ${this.coreVersion}`;
        rec.errors.push(reason);
        report.skipped.push({ name: rec.name, reason });
        rec.enabled = false;
      }
    }
    // Разрешение зависимостей — проходы до стабилизации (циклы не загрузятся)
    let progress = true;
    while (progress) {
      progress = false;
      for (const rec of this.records) {
        if (!rec.enabled || rec.loaded || rec.manifest == null || rec.errors.length > 0) continue;
        const blocked = this.dependencyBlocker(rec.manifest.dependencies);
        if (blocked === 'pending') continue; // зависимость загрузится в следующих проходах
        if (blocked !== null) {
          rec.errors.push(blocked);
          report.skipped.push({ name: rec.name, reason: blocked });
          continue;
        }
        this.createAndLoad(rec, ctx, report);
        progress = true;
      }
    }
    // Оставшиеся включённые, но не загруженные — циклические/неразрешимые зависимости
    for (const rec of this.records) {
      if (rec.enabled && !rec.loaded && rec.manifest != null && rec.errors.length === 0) {
        const reason = 'зависимости не разрешаются (цикл или отсутствующая фича)';
        rec.errors.push(reason);
        report.skipped.push({ name: rec.name, reason });
      }
    }
    return report;
  }

  private dependencyBlocker(deps: string[]): string | null {
    for (const dep of deps) {
      const depRec = this.records.find((r) => r.manifest?.name === dep);
      if (!depRec) return `зависимость "${dep}" не найдена среди фич`;
      if (depRec.loaded) continue;
      if (depRec.errors.length > 0) return `зависимость "${dep}" не загрузилась (${depRec.errors[0]})`;
      if (!depRec.enabled) return `зависимость "${dep}" выключена в config (features."${dep}")`;
      return 'pending'; // включена, но ещё не загружена — ждём
    }
    return null;
  }

  private createAndLoad(rec: RecWithModule, ctx: FeatureContext, report: LoadReport): void {
    const mod = rec.__mod;
    if (!mod || typeof mod.create !== 'function') {
      const reason = 'модуль не экспортирует create(ctx)';
      rec.errors.push(reason);
      report.skipped.push({ name: rec.name, reason });
      return;
    }
    try {
      const perFeatureCtx: FeatureContext = {
        ...ctx,
        log: (level, msg) => ctx.log(level, `[${rec.name}] ${msg}`),
      };
      const handlers = mod.create(perFeatureCtx) ?? {};
      // Возвращённые обработчики должны соответствовать manifest.slot (route — не хук)
      const declared = new Set(rec.manifest!.slot);
      const extra = Object.keys(handlers).filter((k) => !declared.has(k as SlotName));
      if (extra.length > 0) {
        const reason = `обработчики не заявлены в manifest.slot: ${extra.join(', ')}`;
        rec.errors.push(reason);
        report.skipped.push({ name: rec.name, reason });
        return;
      }
      for (const s of HOOK_SLOTS) {
        if (declared.has(s) && typeof handlers[s] !== 'function') {
          const reason = `slot "${s}" заявлен, но обработчик не возвращён`;
          rec.errors.push(reason);
          report.skipped.push({ name: rec.name, reason });
          return;
        }
      }
      rec.loaded = true;
      this.loadedNames.push(rec.name);
      this.handlerMap.set(rec.name, handlers);
      report.loaded.push(rec.name);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      rec.errors.push(`create: ${m}`);
      report.skipped.push({ name: rec.name, reason: `create: ${m}` });
    }
  }

  slotFns(slot: SlotName): SlotFn[] {
    const out: SlotFn[] = [];
    for (const name of this.loadedNames) {
      if (disabledFeatures.has(name)) continue; // ЭТАП 1 (2.3): самовыход действует до конца сессии
      const h = this.handlerMap.get(name)?.[slot];
      if (typeof h === 'function') out.push(h);
    }
    return out;
  }

  /** ЭТАП 1: имена фич в том же порядке, что slotFns(slot) — для диагностик бюджета. */
  slotFeatureNames(slot: SlotName): string[] {
    const out: string[] = [];
    for (const name of this.loadedNames) {
      if (disabledFeatures.has(name)) continue;
      const h = this.handlerMap.get(name)?.[slot];
      if (typeof h === 'function') out.push(name);
    }
    return out;
  }

  list(): FeatureRecord[] {
    return this.records.map((r) => ({ ...r, errors: [...r.errors] }));
  }

  loadedList(): string[] {
    return [...this.loadedNames];
  }

  get featuresDirectory(): string {
    return this.featuresDir;
  }
}
