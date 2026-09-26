// mcp-server.ts — сборка MCP-сервера (6 tools) над зависимостями ядра.
// Отделено от входа mcp.ts, чтобы интеграционные тесты могли поднять тот же
// сервер над InMemoryTransport без stdio (см. test/mcp-tools.int.test.ts).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';

import type { AgentConfig } from './config.js';
import type { FeatureRegistry } from './features/registry.js';
import { executeDoc, type EngineResult } from './core/stepEngine.js';
import { parseTz } from './tz/parser.js';
import { lint } from './tz/linter.js';
import { renderReport, saveReport } from './core/reporter.js';
import { TaskHub, type TaskRecord } from './core/taskHub.js';
import { purgeWorkspace } from './core/workspace.js';
import { journalTail } from './core/journal.js';

export interface McpDeps {
  coreVersion: string;
  cfg: AgentConfig;
  registry: FeatureRegistry;
  hub: TaskHub;
  hooksDir: string;
  reportsDir: string;
  logDir: string;
  cfgPath: string;
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const { cfg, registry, hub, hooksDir, reportsDir, logDir, cfgPath, coreVersion } = deps;

const server = new McpServer({ name: 'super-handai-z', version: coreVersion });

function textErr(msg: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text: msg }] };
}

const TASK_NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

const TaskRecordOut = z.object({
  taskId: z.string(),
  owner: z.string(),
  pid: z.number(),
  status: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  workspace: z.string().optional(),
  stepCount: z.number().optional(),
  steps: z.array(z.object({ i: z.number(), title: z.string(), status: z.string() })),
  notes: z.array(z.string()),
  additionalContext: z.array(z.string()),
  reportPath: z.string().optional(),
  error: z.string().optional(),
});

// --- 1. run_tz: асинхронный запуск ТЗ — taskId сразу, вызов НЕ держится открыт
server.registerTool(
  'run_tz',
  {
    title: 'Запустить ТЗ',
    description:
      'Запустить задачу (ТЗ в формате ТЗ-контракта) в локальном агенте Super_HandAI_z. ' +
      'АСИНХРОННО: сразу возвращает taskId, исполнение идёт в фоне. ' +
      'Статус — инструментом get_status(taskId). Проходит те же guard/AGP/confirm-проверки, что и HTTP. ' +
      'В режиме mode: confirm шаги требуют подтверждения оператора; в MCP-сессии оператора нет — ' +
      'не подтверждённый шаг получает SKIP (отмена оператора = SKIP).',
    inputSchema: {
      tzText: z
        .string()
        .min(1)
        .describe('Полный текст ТЗ (внешняя ограда ```tz ... ``` включается, парсер её снимает).'),
    },
    outputSchema: {
      taskId: z.string(),
      stepCount: z.number(),
      lintIssues: z.number(),
      status: z.literal('RUNNING'),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ tzText }) => {
    // 1) Тот же парсер/линтер, что у HTTP task.start
    const parsed = parseTz(tzText);
    if (!parsed.ok || !parsed.doc) {
      return textErr(
        'parse errors:\n' + parsed.errors.map((e) => `  line ${e.line}: ${e.message}`).join('\n'),
      );
    }
    const doc = parsed.doc;
    if (!doc.steps || doc.steps.length === 0) {
      return textErr('ОТКЛОНЕНО: в ТЗ нет ни одного шага (## ШАГ N). Пустая задача не запускается.');
    }
    if (!doc.meta.workdir || doc.meta.workdir.trim() === '') {
      return textErr('ОТКЛОНЕНО: в META не указан workdir. Каждая задача обязана иметь изолированную папку.');
    }
    // 2) Единый выделитель задач: HTTP и MCP не создают двойную активность
    const pre = hub.preflightCheck();
    if (!pre.ok) {
      const b = pre.blocker!;
      return textErr(
        `task already running: ${b.taskId} (${b.owner}${b.external ? ', другой процесс' : ''}). ` +
        'Запросите get_status или дождитесь завершения.',
      );
    }
    const issues = lint(doc);

    // 3) Старт: taskId сразу, исполнение в фоне (никогда не держим вызов открытым)
    const record: TaskRecord = {
      taskId: hub.nextTaskId(),
      owner: 'mcp',
      pid: process.pid,
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      stepCount: doc.steps.length,
      steps: doc.steps.map((s, i) => ({ i: i + 1, title: s.title, status: 'pending' as const })),
      notes: [],
      additionalContext: [],
    };
    hub.begin(record);
    const stopSignal = hub.stopSignal!;

    void (async () => {
      let result: EngineResult;
      try {
        result = await executeDoc(
          doc,
          cfg,
          record.taskId,
          {
            onStepStatus: (i, state) => {
              const st = record.steps.find((s) => s.i === i);
              if (st && state !== 'run' && state !== 'confirm') st.status = state;
              hub.flushCurrent();
            },
            // PTY-вывод движок сам пишет в data/logs/<taskId>_step<N>.log
            onNote: () => {},
            // Отмена оператора = SKIP (спека 1.3): оператора в MCP-процессе нет,
            // confirm-запрос разрешается «false» → шаг получает skip.
            onNeedConfirm: async () => false,
          },
          stopSignal,
          logDir,
          { hooksDir },
        );
      } catch (e) {
        result = {
          status: 'STOPPED',
          results: [],
          notes: ['engine error: ' + (e instanceof Error ? e.message : String(e))],
          workspace: cfg.workspaceRoot,
          additionalContext: [],
        };
      }
      const reportMd = renderReport(doc, result, record.taskId);
      record.reportPath = saveReport(reportMd, reportsDir, record.taskId);
      record.status = result.status;
      // детерминированные финальные статусы шагов (движок не эмитит 'skip'-колбэк
      // для шага, отменённого оператором) — берём из результата
      record.steps = result.results.map((r) => ({ i: r.i, title: r.title, status: r.status }));
      record.notes = [
        ...result.notes,
        ...result.results.flatMap((r) => (r.notes ?? []).map((n) => `шаг ${r.i}: ${n}`)),
      ];
      record.workspace = result.workspace;
      record.additionalContext = result.additionalContext;
      hub.finish(record);
    })();

    const structured = { taskId: record.taskId, stepCount: record.stepCount ?? 0, lintIssues: issues.length, status: 'RUNNING' as const };
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Задача принята: taskId=${structured.taskId}, шагов: ${structured.stepCount}, замечаний линтера: ${structured.lintIssues}.\n` +
            `Статус: get_status(taskId="${structured.taskId}"). Отчёт по завершении: data/reports/.`,
        },
      ],
      structuredContent: structured,
    };
  },
);

// --- 2. get_status: статус задачи (своей или чужого входа HTTP↔MCP)
server.registerTool(
  'get_status',
  {
    title: 'Статус задачи',
    description:
      'Статус задачи агента: RUNNING/SUCCESS/PARTIAL/STOPPED/DENIED/FAILED, шаги, заметки, ' +
      'additionalContext (канал фич), путь к отчёту. Без аргумента — текущая/последняя задача.',
    inputSchema: { taskId: z.string().optional().describe('taskId из run_tz; пусто — текущая/последняя') },
    outputSchema: { found: z.boolean(), task: TaskRecordOut.nullable() },
    annotations: { readOnlyHint: true },
  },
  async ({ taskId }) => {
    const rec = hub.loadRecord(taskId?.trim() || null);
    const structured = { found: rec != null, task: rec ?? null };
    return {
      content: [{ type: 'text' as const, text: rec ? JSON.stringify(rec, null, 2) : 'задача не найдена' }],
      structuredContent: structured,
    };
  },
);

// --- 3. features_list: зеркало GET /features
server.registerTool(
  'features_list',
  {
    title: 'Список фич',
    description:
      'Список фич системы фич Super_HandAI_z: манифест, enabled (config.features), loaded, bundled, ' +
      'ошибки + подрежимы (one-click toggle).',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const rows = registry.list().map((r) => ({
      name: r.name,
      title: r.manifest?.title ?? '(манифест недоступен)',
      description: r.manifest?.description ?? r.errors.join('; '),
      version: r.manifest?.version ?? '',
      slot: r.manifest?.slot ?? [],
      dependencies: r.manifest?.dependencies ?? [],
      minCore: r.manifest?.minCore ?? '',
      enabled: cfg.features?.[r.name] === true,
      loaded: r.loaded,
      bundled: r.bundled,
      errors: r.errors,
    }));
    const submodes = registry
      .list()
      .flatMap((r) =>
        (r.manifest?.submodes ?? []).map((sm) => ({
          name: sm.name,
          description: sm.description,
          feature: r.name,
          featureEnabled: cfg.features?.[r.name] === true,
          enabled: cfg.features?.[sm.name] === true,
        })),
      );
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ features: rows, submodes }, null, 2) }],
      structuredContent: { features: rows, submodes },
    };
  },
);

// --- 4. features_toggle: зеркало POST /features/toggle
server.registerTool(
  'features_toggle',
  {
    title: 'Вкл/выкл фичу',
    description:
      'Включить/выключить фичу или подрежим: пишет ключ в config.features (config.json). ' +
      'Фичи применяются после рестарта агента; подрежимы (напр. dry-run-active) действуют сразу.',
    inputSchema: {
      name: z.string().regex(TASK_NAME_RE, 'формат имени: [a-z0-9-]{2,32}'),
      enabled: z.boolean(),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ name, enabled }) => {
    if (!cfg.features) cfg.features = {};
    cfg.features[name] = enabled;
    try {
      const { writeFileSync } = await import('node:fs');
      mkdirSync(dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    } catch (e) {
      return textErr(`config.json не записан: ${e instanceof Error ? e.message : String(e)}`);
    }
    const structured = { ok: true as const, name, enabled };
    return {
      content: [
        {
          type: 'text' as const,
          text: `ok: ${name}=${enabled}. Фичи применяются после рестарта агента; подрежимы действуют сразу.`,
        },
      ],
      structuredContent: structured,
    };
  },
);

// --- 5. context_pack: зеркало GET /features/context-pack (те же секции)
server.registerTool(
  'context_pack',
  {
    title: 'Контекст-пак',
    description:
      'Единый markdown-артефакт контекста: git status workspace, config, последние 20 записей ' +
      'journal, versions ядра и фич. Удобно положить в чат как контекст для следующего промта.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const git = await new Promise<string>((res) => {
      execFile('git', ['status', '--porcelain', '-b'], { cwd: cfg.workspaceRoot, timeout: 5000 }, (e, stdout) => {
        res(e ? 'git недоступен: ' + e.message.split('\n')[0] : stdout.trim() || '(рабочее дерево чисто)');
      });
    });
    const versions = {
      core: coreVersion,
      node: process.version,
      platform: process.platform,
      features: Object.fromEntries(
        registry.loadedList().map((name) => [name, registry.list().find((r) => r.name === name)?.manifest?.version ?? '?']),
      ),
    };
    const md = [
      '# Context Pack — ' + new Date().toISOString(),
      '',
      '## versions',
      '',
      '```json',
      JSON.stringify(versions, null, 2),
      '```',
      '',
      '## config',
      '',
      '```json',
      JSON.stringify({ port: cfg.port, workspaceRoot: cfg.workspaceRoot, features: cfg.features ?? {}, stepTimeoutSec: cfg.stepTimeoutSec }, null, 2),
      '```',
      '',
      '## journal (последние 20)',
      '',
      '```json',
      JSON.stringify(journalTail(20), null, 2),
      '```',
      '',
      '## git status',
      '',
      '```',
      git,
      '```',
      '',
    ].join('\n');
    return { content: [{ type: 'text' as const, text: md }], structuredContent: { markdown: md } };
  },
);

// --- 6. purge_workspace: зеркало POST /workspace/purge (защита активной задачи)
server.registerTool(
  'purge_workspace',
  {
    title: 'Очистить workspace',
    description:
      'ПОЛНАЯ очистка workspace (все содержимое workspaceRoot). Отклоняется, если идёт задача ' +
      '(единый выделитель задач). Деструктивно.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async () => {
    const pre = hub.preflightCheck();
    if (!pre.ok) {
      return textErr(`идёт задача ${pre.blocker!.taskId} — очистка отклонена`);
    }
    try {
      const removed = await purgeWorkspace(cfg.workspaceRoot);
      return {
        content: [{ type: 'text' as const, text: `ok: удалено записей: ${removed}` }],
        structuredContent: { ok: true, removed },
      };
    } catch (e) {
      return textErr(e instanceof Error ? e.message : String(e));
    }
  },
);


  return server;
}
