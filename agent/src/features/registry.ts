// features/registry.ts — Система фич: реестр, манифесты, слоты, диспетчеризация.
// НОВЫЙ ФАЙЛ (СИСТЕМА ФИЧ) — ядро не ломается: движок вызывает только
// featuresBeforeRun/featuresAfterRun/featuresOnFail, которые безопасно
// но-опятся, если реестр не активирован (setActiveRegistry не вызывался).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------- Типы ----------

export type SlotName = 'beforeRun' | 'afterRun' | 'onFail' | 'route';
export const SLOT_NAMES: SlotName[] = ['beforeRun', 'afterRun', 'onFail', 'route'];
const HOOK_SLOTS: SlotName[] = ['beforeRun', 'afterRun', 'onFail'];

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

/** Публичное логирование фич (console + синк терминала UI, если установлен). */
export function featureLog(level: string, msg: string): void {
  emitLog(level, msg);
}

/** Слот beforeRun: первая фича, вернувшая {skip:true}, решает. Ошибки фич не роняют движок. */
export async function featuresBeforeRun(i: number, directive: unknown): Promise<BeforeRunVerdict | undefined> {
  const reg = activeRegistry;
  if (!reg) return undefined;
  for (const f of reg.slotFns('beforeRun')) {
    try {
      const v = (await f(i, directive)) as BeforeRunVerdict | undefined;
      if (v && typeof v === 'object' && v.skip === true) return v;
    } catch (e) {
      emitLog('error', `beforeRun: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return undefined;
}

/** Слот afterRun: уведомление после исполнения директивы. */
export async function featuresAfterRun(i: number, info: SlotRunInfo): Promise<void> {
  const reg = activeRegistry;
  if (!reg) return;
  for (const f of reg.slotFns('afterRun')) {
    try {
      await f(i, info);
    } catch (e) {
      emitLog('error', `afterRun: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Слот onFail: уведомление при отказе/запрете директивы. */
export async function featuresOnFail(i: number, failReason: string, info?: Partial<SlotRunInfo>): Promise<void> {
  const reg = activeRegistry;
  if (!reg) return;
  for (const f of reg.slotFns('onFail')) {
    try {
      await f(i, failReason, info);
    } catch (e) {
      emitLog('error', `onFail: ${e instanceof Error ? e.message : String(e)}`);
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
      const h = this.handlerMap.get(name)?.[slot];
      if (typeof h === 'function') out.push(h);
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
