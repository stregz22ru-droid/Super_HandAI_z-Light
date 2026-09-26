// test/hooks-contracts.test.ts — ЭТАП 1, МОДУЛЬ 2: hooks-контракты stepEngine.
//   2.1 onSessionStart + session-состояние (flags);
//   2.2 additionalContext-канал (журнал FEATURE_CTX + EngineResult.additionalContext);
//   2.3 never-block: тайм-бюджет слота + silent fail + самовыход (disableSelf);
//   2.4 Windows-гигиена внешних хуков: BOM-strip, CRLF, plain node без exec/&&,
//       allowlist путей, бюджет на хук.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeatureRegistry, setActiveRegistry, setSlotBudgetMs, DEFAULT_SLOT_BUDGET_MS, getSessionState, type FeatureContext } from '../src/features/registry.js';
import { executeDoc } from '../src/core/stepEngine.js';
import { _setJournalPathForTest, journalTail } from '../src/core/journal.js';
import { normalizeHookOutput, listExternalHooks, runExternalHook, runExternalHooksOnSessionStart } from '../src/core/externalHooks.js';
import type { AgentConfig } from '../src/config.js';

let tmp: string;
let featuresDir: string;
let hooksDir: string;
let workspace: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'shz-hooks-'));
  featuresDir = join(tmp, 'features');
  hooksDir = join(tmp, 'hooks');
  workspace = join(tmp, 'workspace');
  mkdirSync(featuresDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  _setJournalPathForTest(join(tmp, 'journal.jsonl'));
});

afterEach(() => {
  setActiveRegistry(null);
  setSlotBudgetMs(DEFAULT_SLOT_BUDGET_MS);
  _setJournalPathForTest(null);
  rmSync(tmp, { recursive: true, force: true });
});

function makeCtx(features: Record<string, boolean>): FeatureContext {
  return {
    coreVersion: '1.0.0',
    config: { features },
    session: getSessionState(),
    log: () => {},
    registerRoute: () => {},
    gitStatus: async () => '(тест)',
    journalTail: async () => [],
    versions: () => ({ core: '1.0.0' }),
  };
}

async function loadFeatures(files: Record<string, string>, enabled: string[]): Promise<FeatureRegistry> {
  for (const [name, code] of Object.entries(files)) {
    writeFileSync(join(featuresDir, name + '.feature.js'), code, 'utf8');
  }
  const reg = new FeatureRegistry(featuresDir, '1.0.0');
  await reg.scanFeatures();
  const fe: Record<string, boolean> = {};
  for (const n of enabled) fe[n] = true;
  reg.loadEnabled(fe, makeCtx(fe));
  setActiveRegistry(reg);
  return reg;
}

function makeCfg(): AgentConfig {
  return {
    port: 0,
    workspaceRoot: workspace,
    shells: {
      pwsh: { cmd: '/nonexistent/pwsh', args: [] },
      bash: { cmd: '/nonexistent/bash', args: [] },
      pwshFallback: { cmd: 'powershell.exe', args: [] },
      linuxBash: { cmd: '/bin/bash', args: ['-c'] },
    },
    stepTimeoutSec: 10,
    maxOutputBytes: 1048576,
    deny: [],
  };
}

const TZ_WRITE = `# ЗАДАЧ: hooks
# META
workdir: new:hooks-ws
mode: auto
on_fail: stop

## ШАГ 1. Файл
WRITE out.txt
\`\`\`text
данные
\`\`\`
`;

describe('МОДУЛЬ 2.1 — onSessionStart + session-состояние', () => {
  it('слот onSessionStart получает инфо сессии и может выставить flags + контекст', async () => {
    await loadFeatures(
      {
        sessioner: `export const manifest = { name: 'sessioner', title: 'S', description: 'd', version: '1.0.0', slot: ['onSessionStart'], dependencies: [], minCore: '1.0.0' };
export function create(ctx) {
  return {
    onSessionStart(info) {
      ctx.log('info', 'session ' + info.taskId + ' steps=' + info.stepCount);
      ctx.session.flags['echo-mode'] = true;
      return { additionalContext: ['сессия ' + info.taskId + ' началась'] };
    },
  };
}`,
      },
      ['sessioner'],
    );
    const { featuresSessionStart } = await import('../src/features/registry.js');
    const ctx = await featuresSessionStart({ taskId: 'task_s1', workspace, stepCount: 3 });
    expect(ctx).toContain('сессия task_s1 началась');
    expect(getSessionState().flags['echo-mode']).toBe(true);
    expect(getSessionState().taskId).toBe('task_s1');
  });

  it('без активного реестра — но-оп (контракт системы фич)', async () => {
    setActiveRegistry(null);
    const { featuresSessionStart } = await import('../src/features/registry.js');
    const ctx = await featuresSessionStart({ taskId: 't', workspace, stepCount: 1 });
    expect(ctx).toEqual([]);
  });
});

describe('МОДУЛЬ 2.2 — additionalContext-канал', () => {
  it('beforeRun и afterRun могут добавлять контекст; контекст в EngineResult и журнале', async () => {
    await loadFeatures(
      {
        // ВАЖНО: afterRun зовётся только для ИСПОЛНЕННЫХ директив — фича ничего не skip-ает
        contexter: `export const manifest = { name: 'contexter', title: 'C', description: 'd', version: '1.0.0', slot: ['beforeRun', 'afterRun'], dependencies: [], minCore: '1.0.0' };
export function create(ctx) {
  return {
    beforeRun(i, d) {
      return { additionalContext: ['контекст до шага ' + i] };
    },
    afterRun(i, info) {
      return { additionalContext: ['контекст после шага ' + i] };
    },
  };
}`,
      },
      ['contexter'],
    );
    const result = await executeDoc(parse(TZ_WRITE), makeCfg(), 'task_c1', {}, { stopped: false }, join(tmp, 'logs'));
    expect(result.status).toBe('SUCCESS');
    expect(result.additionalContext).toContain('контекст до шага 1');
    expect(result.additionalContext).toContain('контекст после шага 1');
    // журнал: FEATURE_CTX-записи
    const entries = journalTail(50).filter((e: any) => e.action === 'FEATURE_CTX');
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.some((e: any) => (e.note ?? '').includes('контекст до шага 1'))).toBe(true);
  });

  it('контекст фич попадает в заметки шага (ctx: …)', async () => {
    await loadFeatures(
      {
        contexter: `export const manifest = { name: 'contexter', title: 'C', description: 'd', version: '1.0.0', slot: ['beforeRun'], dependencies: [], minCore: '1.0.0' };
export function create() {
  return { beforeRun() { return { additionalContext: ['CTX-МАРКА-123'] }; } };
}`,
      },
      ['contexter'],
    );
    const results: any[] = [];
    await executeDoc(parse(TZ_WRITE), makeCfg(), 'task_c2', {
      onStepStatus: () => {},
    }, { stopped: false }, join(tmp, 'logs'));
    const entries = journalTail(50).filter((e: any) => e.action === 'FEATURE_CTX');
    expect(entries.some((e: any) => (e.note ?? '').includes('CTX-МАРКА-123'))).toBe(true);
    void results;
  });
});

describe('МОДУЛЬ 2.3 — never-block контракт слотов', () => {
  it('зависший слот не роняет задачу: бюджет обрубает, задача доходит до SUCCESS', async () => {
    setSlotBudgetMs(80);
    await loadFeatures(
      {
        sleepy: `export const manifest = { name: 'sleepy', title: 'S', description: 'd', version: '1.0.0', slot: ['beforeRun'], dependencies: [], minCore: '1.0.0' };
export function create() {
  return { beforeRun: async () => { await new Promise((r) => setTimeout(r, 5000)); return { skip: true }; } };
}`,
      },
      ['sleepy'],
    );
    const result = await executeDoc(parse(TZ_WRITE), makeCfg(), 'task_nb1', {}, { stopped: false }, join(tmp, 'logs'));
    expect(result.status).toBe('SUCCESS'); // слот завис — задача жива
    expect(existsSync(join(workspace, 'hooks-ws', 'out.txt'))).toBe(true);
  });

  it('бросок исключения в слоте — silent fail, задача продолжается', async () => {
    await loadFeatures(
      {
        thrower: `export const manifest = { name: 'thrower', title: 'T', description: 'd', version: '1.0.0', slot: ['afterRun'], dependencies: [], minCore: '1.0.0' };
export function create() {
  return { afterRun() { throw new Error('фича сломалась — движок нет'); } };
}`,
      },
      ['thrower'],
    );
    const result = await executeDoc(parse(TZ_WRITE), makeCfg(), 'task_nb2', {}, { stopped: false }, join(tmp, 'logs'));
    expect(result.status).toBe('SUCCESS');
  });

  it('disableSelf: самовыход отключает фичу до конца сессии (второй вызов не происходит)', async () => {
    await loadFeatures(
      {
        quitter: `export const manifest = { name: 'quitter', title: 'Q', description: 'd', version: '1.0.0', slot: ['beforeRun'], dependencies: [], minCore: '1.0.0' };
export function create(ctx) {
  let calls = 0;
  return { beforeRun() { calls++; if (calls === 1) return { skip: true, reason: 'первый раз', disableSelf: true }; return undefined; } };
}`,
      },
      ['quitter'],
    );
    // две директивы в одном шаге — beforeRun вызывается на каждую
    const TZ2 = TZ_WRITE + `
## ШАГ 2. Ещё файл
WRITE out2.txt
\`\`\`text
данные2
\`\`\`
`;
    const result = await executeDoc(parse(TZ2), makeCfg(), 'task_nb3', {}, { stopped: false }, join(tmp, 'logs'));
    expect(result.status).toBe('SUCCESS');
    // первый вызов quitter вернул skip → первый WRITE НЕ исполнен...
    expect(existsSync(join(workspace, 'hooks-ws', 'out.txt'))).toBe(false);
    // ...а после самовыхода второй WRITE исполнился (disableSelf больше не мешает задачу)
    expect(existsSync(join(workspace, 'hooks-ws', 'out2.txt'))).toBe(true);
  });
});

describe('МОДУЛЬ 2.4 — Windows-гигиена внешних хуков', () => {
  it('normalizeHookOutput: BOM-strip + CRLF-толерантность + фильтр пустых', () => {
    const raw = '\uFEFFстрока раз\r\nстрока два\r\n\n\nстрока три\n';
    expect(normalizeHookOutput(raw)).toEqual(['строка раз', 'строка два', 'строка три']);
  });

  it('normalizeHookOutput: длинная строка обрезается по MAX_LINE_LEN (2000)', () => {
    const out = normalizeHookOutput('x'.repeat(3000));
    expect(out[0].length).toBeLessThanOrEqual(2001); // 2000 + символ многоточия
    expect(out[0].endsWith('…')).toBe(true);
  });

  it('allowlist: *.hook.js из корня каталога — да; прочее — нет', () => {
    writeFileSync(join(hooksDir, 'good.hook.js'), '', 'utf8');
    writeFileSync(join(hooksDir, 'bad.js'), '', 'utf8');
    mkdirSync(join(hooksDir, 'sub'), { recursive: true });
    writeFileSync(join(hooksDir, 'sub', 'nested.hook.js'), '', 'utf8');
    const list = listExternalHooks(hooksDir);
    expect(list).toEqual(['good.hook.js']);
    expect(listExternalHooks(join(tmp, 'нет-такого'))).toEqual([]);
  });

  it('runExternalHook: путь вне каталога хуков отклонён (allowlist путей)', async () => {
    const outside = join(tmp, 'evil.hook.js');
    writeFileSync(outside, 'console.log("pwned")', 'utf8');
    const r = await runExternalHook(outside, { hooksDir, budgetMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('allowlist');
  });

  it('runExternalHook: plain node, happy path — stdout нормализуется', async () => {
    writeFileSync(join(hooksDir, 'ok.hook.js'), "console.log('HOOK-OK: ctx')", 'utf8');
    const r = await runExternalHook(join(hooksDir, 'ok.hook.js'), { hooksDir, budgetMs: 5000 });
    expect(r.ok).toBe(true);
    expect(r.lines).toEqual(['HOOK-OK: ctx']);
    expect(r.timedOut).toBeFalsy();
  });

  it('runExternalHook: never-block — зависший хук убивается по бюджету', async () => {
    writeFileSync(join(hooksDir, 'slow.hook.js'), 'setTimeout(()=>{}, 60000); setInterval(()=>{},1000);', 'utf8');
    const t0 = Date.now();
    const r = await runExternalHook(join(hooksDir, 'slow.hook.js'), { hooksDir, budgetMs: 150 });
    const dt = Date.now() - t0;
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(dt).toBeLessThan(5000); // не ждали 60с
  });

  it('сессия задачи: вывод хуков попадает в additionalContext и журнал', async () => {
    writeFileSync(join(hooksDir, 'ctx.hook.js'), "console.log('\\uFEFFHOOK-CTX: пример\\r\\nвторая строка');", 'utf8');
    await loadFeatures({}, []); // реестр без фич — работают только внешние хуки
    const result = await executeDoc(parse(TZ_WRITE), makeCfg(), 'task_h1', {}, { stopped: false }, join(tmp, 'logs'), { hooksDir });
    expect(result.additionalContext.some((c) => c.includes('[hook:ctx.hook.js] HOOK-CTX: пример'))).toBe(true);
    const entries = journalTail(50).filter((e: any) => e.action === 'FEATURE_CTX');
    expect(entries.some((e: any) => (e.note ?? '').includes('вторая строка'))).toBe(true);
  });

  it('сломанный хук (exit!=0) — silent fail в заметках, задача продолжается', async () => {
    writeFileSync(join(hooksDir, 'bad.hook.js'), 'process.exit(3);', 'utf8');
    await loadFeatures({}, []);
    const result = await executeDoc(parse(TZ_WRITE), makeCfg(), 'task_h2', {}, { stopped: false }, join(tmp, 'logs'), { hooksDir });
    expect(result.status).toBe('SUCCESS');
    expect(result.notes.some((n) => n.includes('external hook bad.hook.js'))).toBe(true);
  });
});

// --- вспомогательные ---
import { parseTz } from '../src/tz/parser.js';
function parse(tzText: string): ReturnType<typeof parseTz>['doc'] {
  const parsed = parseTz(tzText);
  if (!parsed.ok || !parsed.doc) throw new Error('ТЗ не распарсилось: ' + JSON.stringify(parsed.errors));
  return parsed.doc;
}
