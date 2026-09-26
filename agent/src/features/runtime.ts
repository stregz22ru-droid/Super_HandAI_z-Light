// features/runtime.ts — ОБЩИЙ boot реестра фич для обоих входов:
//   main.ts (HTTP-агент) и mcp.ts (stdio-MCP-сервер, Этап 1 / Модуль 1).
// Один порядок инициализации = одинаковые слоты в обоих процессах:
//   scanFeatures → loadEnabled(cfg.features) → setActiveRegistry.
// Вынесено из main.ts, чтобы MCP-процесс не дрейфовал с HTTP-процессом
// (урок Ponytail Research: их JS/Python билдеры уже дрейфуют).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import {
  FeatureRegistry,
  featureLog,
  setActiveRegistry,
  getSessionState,
  type FeatureContext,
  type LoadReport,
} from './registry.js';
import { journalTail } from '../core/journal.js';
import type { AgentConfig } from '../config.js';

export interface FeatureRoute {
  method: 'GET' | 'POST' | 'DELETE' | 'PUT';
  path: string;
  handler: (req: any, res: any) => void | Promise<void>;
}

export interface FeatureRuntime {
  registry: FeatureRegistry;
  loadReport: LoadReport;
  featureRoutes: FeatureRoute[];
  coreVersion: string;
  featuresDir: string;
}

export async function createFeatureRuntime(opts: {
  agentDir: string; // каталог agent/ (содержит features/ и package.json)
  workspaceRoot: string;
  cfg: AgentConfig;
  /** HTTP-вход передаёт настоящий регистратор маршрутов; MCP — нет (route-слоты там не нужны). */
  registerRoute?: FeatureContext['registerRoute'];
}): Promise<FeatureRuntime> {
  const featuresDir = resolve(opts.agentDir, 'features');
  const coreVersion = (
    JSON.parse(readFileSync(resolve(opts.agentDir, 'package.json'), 'utf8')) as { version?: string }
  ).version ?? '0.0.0';

  const registry = new FeatureRegistry(featuresDir, coreVersion);
  const scanRes = await registry.scanFeatures();
  console.log(`[features] scanned: ${scanRes.scanned}${scanRes.errors.length > 0 ? `, ошибок манифеста/импорта: ${scanRes.errors.length}` : ''}`);
  for (const e of scanRes.errors) console.log(`[features] error: ${e}`);

  const featureRoutes: FeatureRoute[] = [];
  opts.cfg.features = { ...(opts.cfg.features ?? {}) };

  const featureCtx: FeatureContext = {
    coreVersion,
    config: opts.cfg as AgentConfig & { features: Record<string, boolean> },
    // Живая ссылка на session-состояние (Этап 1, 2.1): объект мутируется на месте,
    // поэтому ссылка остаётся актуальной для всех сессий.
    session: getSessionState(),
    log: (level, msg) => featureLog(level, msg),
    registerRoute:
      opts.registerRoute ??
      ((method, path, handler) => {
        // MCP-вход: route-слоты никуда не подключаются (у MCP свой context_pack-tool).
        console.log(`[features] route не подключён (не-HTTP вход): ${method} ${path}`);
        void handler;
      }),
    gitStatus: () =>
      new Promise<string>((resolveP) => {
        execFile('git', ['status', '--porcelain', '-b'], { cwd: opts.workspaceRoot, timeout: 5000 }, (err, stdout) => {
          resolveP(err ? 'git недоступен: ' + err.message.split('\n')[0] : stdout.trim() || '(рабочее дерево чисто)');
        });
      }),
    journalTail: (n) => Promise.resolve(journalTail(n)),
    versions: () => ({
      core: coreVersion,
      node: process.version,
      platform: process.platform,
      features: Object.fromEntries(
        registry.loadedList().map((name) => [name, registry.list().find((r) => r.name === name)?.manifest?.version ?? '?']),
      ),
    }),
  };

  const loadReport = registry.loadEnabled(opts.cfg.features, featureCtx);
  console.log(`[features] loaded: ${loadReport.loaded.join(', ') || '—'}`);
  for (const s of loadReport.skipped) console.log(`[features] skipped: ${s.name} — ${s.reason}`);
  setActiveRegistry(registry);

  return { registry, loadReport, featureRoutes, coreVersion, featuresDir };
}
