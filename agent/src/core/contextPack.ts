// core/contextPack.ts — ЕДИНЫЙ билдер контекст-пака (Base Этап 1, ДОЗАКАЗ п.2).
// Принцип «выводы из Ponytail»: ОДИН билдер на всех потребителей. Сборку
// markdown вызывает и HTTP-фича (features/context-pack.feature.js → свой
// route-слот), и MCP-инструмент context_pack (mcp.ts → прямой вызов, БЕЗ
// HTTP-пути). HTTP-версии и MCP-версии сборки НЕ существует — дубли логики
// запрещены (таблица рисков, п.3).
//
// Билдер сам владеет всеми чтениями (config/journal/git/versions) — поэтому
// оба потребителя получают одинаковый артефакт, а путь вызова не влияет на
// содержимое. Канонические источники:
//   config  → configPath() + loadConfig() (config.ts, тот же soft-merge, что у агента)
//   journal → journalTail() (core/journal.js — канонический журнал)
//   git     → `git status --porcelain -b` в workspaceRoot из конфига
//   versions→ agent/package.json + process
// Единственная опция — featuresVersions: карты «фича → версия» агент отдаёт из
// живого реестра (MCP-процесс реестра не видит и честно оставляет поле пустым).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { journalTail, type JournalEntry } from './journal.js';
import { loadConfig, configPath, type AgentConfig } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/core/contextPack.js → agent/ ; src/core/contextPack.ts → agent/ (tsx)
const agentRoot = resolve(__dirname, '..', '..');

export interface ContextPackOptions {
  /** Сколько последних записей журнала включать (по умолчанию 20). */
  journalLimit?: number;
  /** Версии загруженных фич {имя: версия} — знает только реестр агента (HTTP-потребитель). */
  featuresVersions?: Record<string, string>;
}

/** git status workspace — тот же примитив, что у фичевого ctx (porcelain -b, 5 c, мягкая деградация). */
export function gitStatusOf(cwd: string): Promise<string> {
  return new Promise<string>((resolveP) => {
    execFile('git', ['status', '--porcelain', '-b'], { cwd, timeout: 5000 }, (err, stdout) => {
      resolveP(err ? 'git недоступен: ' + err.message.split('\n')[0] : stdout.trim() || '(рабочее дерево чисто)');
    });
  });
}

/** Прочитать конфиг агента без побочных эффектов пути записи (файл уже создан main.ts). */
function readAgentConfig(): AgentConfig {
  // loadConfig при ОТСУТСТВИИ файла создаёт дефолтный — тот же эффект, что у
  // main.ts при первом старте; для живой установки файл всегда есть.
  return loadConfig(configPath());
}

/**
 * Собрать контекст-пак (markdown). Синхронных потребителей нет — функция
 * асинхронна из-за git. Порядок секций — замороженный формат HTTP-фичи.
 */
export async function buildContextPack(opts: ContextPackOptions = {}): Promise<string> {
  const limit = Math.max(1, opts.journalLimit ?? 20);
  const cfg = readAgentConfig();
  const workspaceRoot = resolve(cfg.workspaceRoot);
  const [git] = await Promise.all([gitStatusOf(workspaceRoot)]);
  const journal: JournalEntry[] = journalTail(limit);

  let coreVersion = '0.0.0';
  try {
    const pkg = JSON.parse(readFileSync(resolve(agentRoot, 'package.json'), 'utf8')) as { version?: string };
    coreVersion = pkg.version ?? coreVersion;
  } catch { /* package.json недоступен — отдаём 0.0.0, не падаем */ }

  const versions = {
    core: coreVersion,
    node: process.version,
    platform: process.platform,
    features: opts.featuresVersions ?? {},
  };

  return [
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
    JSON.stringify(cfg, null, 2),
    '```',
    '',
    '## git status',
    '',
    '```',
    git,
    '```',
    '',
    `## journal (последние ${journal.length})`,
    '',
    '```json',
    JSON.stringify(journal, null, 2),
    '```',
    '',
    '',
  ].join('\n');
}
