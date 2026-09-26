// test/features.test.ts — СИСТЕМА ФИЧ: registry, слоты, toggle, upload-валидация.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FeatureRegistry,
  validateManifest,
  cmpSemver,
  setActiveRegistry,
  getSessionState,
  type FeatureContext,
} from '../src/features/registry.js';
import { validateUploadedFeature, handleFeaturesApi } from '../src/features/http.js';
import { executeDoc } from '../src/core/stepEngine.js';
import type { AgentConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { parseTz } from '../src/tz/parser.js';
import * as ptyManager from '../src/core/ptyManager.js';
import { _setJournalPathForTest } from '../src/core/journal.js';

// ---------- FakePty (паттерн test/stepEngine.test.ts) ----------
class FakeProc {
  dataCbs: ((data: string) => void)[] = [];
  exitCbs: ((e: { exitCode?: number; signal?: number }) => void)[] = [];
  killed = false;
  onData(cb: (data: string) => void) { this.dataCbs.push(cb); }
  onExit(cb: (e: { exitCode?: number; signal?: number }) => void) { this.exitCbs.push(cb); }
  kill() { this.killed = true; }
  emit(data: string) { for (const cb of this.dataCbs) cb(data); }
  exit(code: number) { for (const cb of this.exitCbs) cb({ exitCode: code }); }
}
function makeFakePty(outputs: { match: string; data: string; exit: number }[]) {
  return {
    spawn: vi.fn((file: string, args: string[], opts: any) => {
      const proc = new FakeProc();
      const script = args[args.length - 1] ?? '';
      const match = outputs.find((o) => script.includes(o.match));
      setTimeout(() => {
        if (proc.killed) return;
        if (match?.data) proc.emit(match.data);
        proc.exit(match?.exit ?? 0);
      }, 1);
      return proc as unknown as FakeProc;
    }),
  } as unknown as typeof import('@lydell/node-pty');
}

// ---------- Хелперы ----------

const VALID_MANIFEST = {
  name: 'myfeat',
  title: 'Тестовая фича',
  description: 'Описание',
  version: '1.0.0',
  slot: ['afterRun' as const],
  dependencies: [],
  minCore: '0.0.1',
};

function featureSource(name: string, extra = ''): string {
  return `export const manifest = ${JSON.stringify({
    ...VALID_MANIFEST,
    name,
    slot: ['beforeRun'],
  })};
export function create(ctx) {
  ${extra}
  return { beforeRun(i, d) { return undefined; } };
}
`;
}

let tmp: string;
let featuresDir: string;
const originalPty = (ptyManager as any).ptyImpl;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'feat-'));
  featuresDir = join(tmp, 'features');
  mkdirSync(featuresDir, { recursive: true });
  _setJournalPathForTest(join(tmp, 'journal.jsonl'));
});

afterEach(() => {
  setActiveRegistry(null);
  ptyManager.injectPtyImpl(originalPty);
  rmSync(tmp, { recursive: true, force: true });
  _setJournalPathForTest(null);
});

function makeCtx(features: Record<string, boolean>): FeatureContext {
  const cfg = { features };
  return {
    coreVersion: '1.0.0',
    config: cfg,
    // ЭТАП 1 (2.1): живая ссылка на session-состояние (объект мутируется на месте)
    session: getSessionState(),
    log: () => {},
    registerRoute: () => {},
    gitStatus: async () => '(тест)',
    journalTail: async () => [],
    versions: () => ({ core: '1.0.0' }),
  };
}

async function scanAndLoad(dir: string, features: Record<string, boolean>) {
  const registry = new FeatureRegistry(dir, '1.0.0');
  const scan = await registry.scanFeatures();
  const report = registry.loadEnabled(features, makeCtx(features));
  return { registry, scan, report };
}

// ---------- 1. Registry ----------

describe('registry: валидный/битый манифест, зависимости', () => {
  it('валидная фича сканируется и загружается', async () => {
    writeFileSync(join(featuresDir, 'alpha.feature.js'), featureSource('alpha'), 'utf8');
    const { registry, scan, report } = await scanAndLoad(featuresDir, { alpha: true });
    expect(scan.scanned).toBe(1);
    expect(scan.errors).toEqual([]);
    expect(report.loaded).toEqual(['alpha']);
    const rows = registry.list();
    expect(rows[0].enabled).toBe(true);
    expect(rows[0].loaded).toBe(true);
    expect(rows[0].manifest?.title).toBe('Тестовая фича');
    expect(registry.slotFns('beforeRun').length).toBe(1);
  });

  it('битый манифест — в список ошибок, не падение', async () => {
    writeFileSync(
      join(featuresDir, 'broken.feature.js'),
      'export const manifest = { title: "нет name/version/slot" };\nexport function create(){ return {}; }\n',
      'utf8',
    );
    writeFileSync(
      join(featuresDir, 'badimport.feature.js'),
      'this is ((( not javascript',
      'utf8',
    );
    const { registry, scan } = await scanAndLoad(featuresDir, { broken: true, badimport: true });
    expect(scan.scanned).toBe(2);
    // каждый из двух файлов дал ошибки (6 полей манифеста + import)
    expect(scan.errors.length).toBeGreaterThanOrEqual(2);
    expect(scan.errors.some((e) => e.startsWith('badimport.feature.js: import:'))).toBe(true);
    expect(scan.errors.some((e) => e.startsWith('broken.feature.js:'))).toBe(true);
    const rows = registry.list();
    expect(rows.every((r) => !r.loaded)).toBe(true);
    expect(rows.find((r) => r.name === 'broken')!.errors.length).toBeGreaterThan(0);
    expect(rows.find((r) => r.name === 'badimport')!.errors[0]).toContain('import:');
    // slotFns пуст — движок продолжает работать
    expect(registry.slotFns('beforeRun').length).toBe(0);
  });

  it('зависимость выключена → фича не включается; включена → обе загружаются', async () => {
    writeFileSync(join(featuresDir, 'base.feature.js'), featureSource('base'), 'utf8');
    writeFileSync(
      join(featuresDir, 'child.feature.js'),
      featureSource('child').replace('"dependencies":[]', '"dependencies":["base"]').replace(/"dependencies":\s*\[\]/, '"dependencies":["base"]'),
      'utf8',
    );
    // dependOff: base выключена
    const off = await scanAndLoad(featuresDir, { base: false, child: true });
    expect(off.report.loaded).toEqual([]);
    expect(off.report.skipped.find((s) => s.name === 'child')?.reason).toContain('выключена');
    // обе включены: порядок base → child
    const on = await scanAndLoad(featuresDir, { base: true, child: true });
    expect(on.report.loaded).toEqual(['base', 'child']);
  });

  it('minCore выше версии ядра → фича не загружается', async () => {
    writeFileSync(
      join(featuresDir, 'future.feature.js'),
      featureSource('future').replace('"minCore":"0.0.1"', '"minCore":"99.0.0"'),
      'utf8',
    );
    const { report } = await scanAndLoad(featuresDir, { future: true });
    expect(report.loaded).toEqual([]);
    expect(report.skipped[0].reason).toContain('minCore');
  });

  it('validateManifest/ncmpSemver: базовые проверки', () => {
    expect(validateManifest(VALID_MANIFEST).errors).toEqual([]);
    expect(validateManifest({ ...VALID_MANIFEST, version: '1.0' }).errors.length).toBe(1);
    expect(validateManifest(null).errors.length).toBeGreaterThan(0);
    expect(cmpSemver('1.0.0', '1.0.0')).toBe(0);
    expect(cmpSemver('1.2.3', '1.10.0')).toBe(-1);
    expect(cmpSemver('2.0.0', '1.9.9')).toBe(1);
  });
});

// ---------- 2. Слоты в движке ----------

const SKIPPER = `export const manifest = ${JSON.stringify({
  name: 'skipper',
  title: 'Skipper',
  description: 'Тестовый skip',
  version: '1.0.0',
  slot: ['beforeRun'],
  dependencies: [],
  minCore: '0.0.1',
})};
export function create(ctx) {
  return {
    beforeRun(i, d) {
      if (d.kind === 'RUN' && ctx.config.features['skipper-active'] === true) {
        ctx.log('warn', '[SKIPPER] ' + d.script.split('\\n')[0]);
        return { skip: true, reason: 'skipper: подавлено тестом' };
      }
      return undefined;
    },
  };
}
`;

const TZ_RUN = `# ЗАДАЧ: Slots
# META
workdir: new:slots-ws
mode: auto
on_fail: stop
cycle: 1

## ШАГ 1. echo
RUN shell: bash
\`\`\`bash
echo slots-e2e
\`\`\`
EXPECT exit=0
EXPECT stdout contains:slots-e2e
`;

async function runDoc(tz: string, features: Record<string, boolean>, featuresDirPath: string) {
  const registry = new FeatureRegistry(featuresDirPath, '1.0.0');
  await registry.scanFeatures();
  registry.loadEnabled(features, makeCtx(features));
  setActiveRegistry(registry);
  const workspaceRoot = join(tmp, 'ws');
  mkdirSync(workspaceRoot, { recursive: true });
  ptyManager.injectPtyImpl(makeFakePty([{ match: 'echo slots-e2e', data: 'slots-e2e\n', exit: 0 }]));
  const cfg: AgentConfig = {
    port: 8787,
    workspaceRoot,
    shells: {
      pwsh: { cmd: '/nonexistent/pwsh', args: [] },
      bash: { cmd: '/nonexistent/bash', args: [] },
      pwshFallback: { cmd: 'powershell.exe', args: [] },
      linuxBash: { cmd: '/bin/bash', args: ['-c'] },
    },
    stepTimeoutSec: 5,
    maxOutputBytes: 1048576,
    deny: [],
    features,
  };
  const parsed = parseTz(tz);
  expect(parsed.ok).toBe(true);
  const result = await executeDoc(parsed.doc!, cfg, 't' + Date.now(), {
    onStepStatus: () => {},
    onPtyData: () => {},
    onNote: () => {},
  }, { stopped: false }, join(tmp, 'logs'));
  return result;
}

describe('слоты: beforeRun skip → шаг пропущен', () => {
  it('skipper активен → статус skip, команда не исполнена', async () => {
    writeFileSync(join(featuresDir, 'skipper.feature.js'), SKIPPER, 'utf8');
    const result = await runDoc(TZ_RUN, { skipper: true, 'skipper-active': true }, featuresDir);
    expect(result.status).toBe('SUCCESS');
    expect(result.results[0].status).toBe('skip');
    expect(result.results[0].notes?.some((n) => n.includes('SKIP(фича)') && n.includes('skipper'))).toBe(true);
  });

  it('skipper не активен → шаг исполняется как обычно', async () => {
    writeFileSync(join(featuresDir, 'skipper.feature.js'), SKIPPER, 'utf8');
    const result = await runDoc(TZ_RUN, { skipper: true, 'skipper-active': false }, featuresDir);
    expect(result.status).toBe('SUCCESS');
    expect(result.results[0].status).toBe('ok');
    expect(result.results[0].outputTail).toContain('slots-e2e');
  });

  it('без активного реестра слоты — но-оп (обратная совместимость)', async () => {
    const result = await runDoc(TZ_RUN, {}, featuresDir);
    expect(result.results[0].status).toBe('ok');
  });
});

// ---------- 3. Toggle сохраняется между рестартами ----------

describe('toggle: сохранение в config.json между рестартами', () => {
  it('loadConfig перечитывает features-секцию', () => {
    const cfgPath = join(tmp, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ features: { alpha: true, 'dry-run-active': false } }), 'utf8');
    const cfg1 = loadConfig(cfgPath);
    expect(cfg1.features?.alpha).toBe(true);
    // «toggle»: пишем изменённую секцию, как POST /features/toggle
    cfg1.features!['dry-run-active'] = true;
    writeFileSync(cfgPath, JSON.stringify(cfg1, null, 2), 'utf8');
    // «рестарт»: новый loadConfig
    const cfg2 = loadConfig(cfgPath);
    expect(cfg2.features?.['dry-run-active']).toBe(true);
    expect(cfg2.features?.alpha).toBe(true);
    // дефолты не теряются при мягком merge
    expect(Object.keys(cfg2.features!).length).toBeGreaterThanOrEqual(2);
  });
});

// ---------- 4. Upload: валидация файла ----------

describe('upload: валидация .feature.js', () => {
  it('валидный файл проходит (импорт из tmp, манифест ок)', async () => {
    const v = await validateUploadedFeature(Buffer.from(featureSource('good')), 'good.feature.js', join(tmp, 'state'));
    expect(v.ok).toBe(true);
    expect(v.manifest?.name).toBe('good');
  });

  it('битый JS → 400-поведение (ошибки, не падение)', async () => {
    const v = await validateUploadedFeature(Buffer.from('this is (( not js'), 'bad.feature.js', join(tmp, 'state'));
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain('не импортируется');
  });

  it('манифест не совпадает с именем файла → отказ', async () => {
    const v = await validateUploadedFeature(Buffer.from(featureSource('other')), 'mismatch.feature.js', join(tmp, 'state'));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('не совпадает');
  });

  it('кривое имя файла → отказ до импорта', async () => {
    const v = await validateUploadedFeature(Buffer.from(featureSource('x')), 'Bad_Name.txt', join(tmp, 'state'));
    expect(v.ok).toBe(false);
  });

  it('временный файл удаляется после валидации', async () => {
    await validateUploadedFeature(Buffer.from(featureSource('tmpchk')), 'tmpchk.feature.js', join(tmp, 'state'));
    const leftovers = existsSync(join(tmp, 'state'));
    // папка может остаться, но .upload-* файлов быть не должно
    if (leftovers) {
      const files = (await import('node:fs')).readdirSync(join(tmp, 'state'));
      expect(files.filter((f) => f.startsWith('.upload-')).length).toBe(0);
    }
  });
});

// ---------- 5. Подрежимы (submodes): манифест + GET /features + one-click toggle ----------

describe('манифест: submodes (валидация)', () => {
  it('валидные подрежимы проходят и попадают в манифест', () => {
    const v = validateManifest({
      ...VALID_MANIFEST,
      submodes: [{ name: 'myfeat-active', description: 'Подрежим теста' }],
    });
    expect(v.errors).toEqual([]);
    expect(v.manifest?.submodes).toEqual([{ name: 'myfeat-active', description: 'Подрежим теста' }]);
  });

  it('без submodes — поле отсутствует (обратная совместимость)', () => {
    const v = validateManifest(VALID_MANIFEST);
    expect(v.errors).toEqual([]);
    expect(v.manifest?.submodes).toBeUndefined();
  });

  it('кривое имя подрежима → ошибка', () => {
    const v = validateManifest({ ...VALID_MANIFEST, submodes: [{ name: 'Bad_Name!', description: 'x' }] });
    expect(v.errors.join(' ')).toContain('submodes[0].name');
  });

  it('дубликат имени подрежима → ошибка', () => {
    const v = validateManifest({
      ...VALID_MANIFEST,
      submodes: [
        { name: 'dup-active', description: 'a' },
        { name: 'dup-active', description: 'b' },
      ],
    });
    expect(v.errors.join(' ')).toContain('дубликат');
  });

  it('имя подрежима = имя фичи → ошибка; submodes не массив → ошибка; пустое description → ошибка', () => {
    const v1 = validateManifest({ ...VALID_MANIFEST, submodes: [{ name: 'myfeat', description: 'x' }] });
    expect(v1.errors.join(' ')).toContain('совпадает с именем самой фичи');
    const v2 = validateManifest({ ...VALID_MANIFEST, submodes: 'nope' });
    expect(v2.errors.join(' ')).toContain('должен быть массивом');
    const v3 = validateManifest({ ...VALID_MANIFEST, submodes: [{ name: 'ok-name', description: '  ' }] });
    expect(v3.errors.join(' ')).toContain('description');
  });
});

describe('GET /features: живой enabled + submodes (регрессия stale-состояния)', () => {
  function fakeRes(): { res: any; body: () => string; code: () => number } {
    const state = { code: 0, chunks: [] as string[] };
    const res: any = {
      writeHead: (c: number) => { state.code = c; },
      end: (b?: any) => { if (b != null) state.chunks.push(String(b)); },
    };
    return { res, body: () => state.chunks.join(''), code: () => state.code };
  }
  function fakeReq(body?: string): any {
    // readBody подписывается на data/end — эмулируем поток
    const req = new EventEmitter() as any;
    req.method = 'POST';
    process.nextTick(() => {
      if (body != null) req.emit('data', Buffer.from(body));
      req.emit('end');
    });
    return req;
  }

  it('toggle фичи сразу отражается в GET /features (без рестарта)', async () => {
    writeFileSync(join(featuresDir, 'live.feature.js'), featureSource('live'), 'utf8');
    const registry = new FeatureRegistry(featuresDir, '1.0.0');
    await registry.scanFeatures();
    const cfg: AgentConfig & { features: Record<string, boolean> } = { features: { live: true } } as any;
    registry.loadEnabled(cfg.features, makeCtx(cfg.features));
    const deps = { registry, cfg, cfgPath: join(tmp, 'config.json'), root: tmp };
    const urlGet = new URL('http://x/features');

    const r1 = fakeRes();
    await handleFeaturesApi({ method: 'GET' }, r1.res, urlGet, deps);
    const out1 = JSON.parse(r1.body());
    expect(out1.ok).toBe(true);
    expect(out1.features.find((f: any) => f.name === 'live').enabled).toBe(true);

    // one-click путь: POST /features/toggle {live: false} → GET показывает false БЕЗ рестарта
    const r2 = fakeRes();
    await handleFeaturesApi(fakeReq(JSON.stringify({ name: 'live', enabled: false })), r2.res, new URL('http://x/features/toggle'), deps);
    expect(r2.code()).toBe(200);
    expect(JSON.parse(r2.body()).ok).toBe(true);

    const r3 = fakeRes();
    await handleFeaturesApi({ method: 'GET' }, r3.res, urlGet, deps);
    const out3 = JSON.parse(r3.body());
    expect(out3.features.find((f: any) => f.name === 'live').enabled).toBe(false);
    // и записано на диск (персистентность между рестартами)
    expect(JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf8')).features.live).toBe(false);
  });

  it('подрежимы фичи отдаются в GET /features с живым состоянием', async () => {
    writeFileSync(
      join(featuresDir, 'subby.feature.js'),
      `export const manifest = ${JSON.stringify({
        ...VALID_MANIFEST,
        name: 'subby',
        submodes: [{ name: 'subby-active', description: 'тестовый подрежим' }],
      })};
export function create(ctx) { return { beforeRun() { return undefined; } }; }
`,
      'utf8',
    );
    const registry = new FeatureRegistry(featuresDir, '1.0.0');
    await registry.scanFeatures();
    const cfg = { features: { subby: true, 'subby-active': false } } as AgentConfig & { features: Record<string, boolean> };
    registry.loadEnabled(cfg.features, makeCtx(cfg.features));
    const deps = { registry, cfg, cfgPath: join(tmp, 'config.json'), root: tmp };

    const r1 = fakeRes();
    await handleFeaturesApi({ method: 'GET' }, r1.res, new URL('http://x/features'), deps);
    const out1 = JSON.parse(r1.body());
    expect(out1.submodes).toEqual([
      { name: 'subby-active', description: 'тестовый подрежим', feature: 'subby', featureEnabled: true, enabled: false },
    ]);

    // one-click toggle подрежима → состояние меняется сразу
    const r2 = fakeRes();
    await handleFeaturesApi(fakeReq(JSON.stringify({ name: 'subby-active', enabled: true })), r2.res, new URL('http://x/features/toggle'), deps);
    expect(r2.code()).toBe(200);
    const r3 = fakeRes();
    await handleFeaturesApi({ method: 'GET' }, r3.res, new URL('http://x/features'), deps);
    const out3 = JSON.parse(r3.body());
    expect(out3.submodes[0].enabled).toBe(true);
  });
});
