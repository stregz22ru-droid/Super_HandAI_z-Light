// project-memory.feature.js — BASE: память проекта (первый прототип ContextSeed).
//
// onTaskStart: если в workspace задачи лежит CONTEXT.md — прочитать и показать
//   оператору (терминал агента + лог-синк UI), следующая сессия задачи
//   начинается не с нуля.
// onTaskDone: авто-генерация CONTEXT.md в workspace задачи (финальный статус,
//   цикл, даты, git log --oneline, список файлов, сводка шагов) и обновление
//   межзадачной карты проектов data/memory/projects.json
//   (workdir → {title, lastStatus, lastCycle, lastDate, runs, summary}).
//
// Маршруты для моста/UI:
//   GET /features/project-memory/projects            — карта проектов (JSON)
//   GET /features/project-memory/context?workdir=N   — CONTEXT.md проекта (markdown)
export const manifest = {
  name: 'project-memory',
  title: 'Память проекта (ContextSeed)',
  description:
    'При старте задачи читает и показывает workspace/<task>/CONTEXT.md; при завершении генерирует CONTEXT.md (статус, циклы, git log, файлы, сводка шагов) и ведёт межзадачную карту проектов data/memory/projects.json. Маршруты: /features/project-memory/projects и /features/project-memory/context?workdir=...',
  version: '1.0.0',
  slot: ['onTaskStart', 'onTaskDone', 'route'],
  dependencies: [],
  minCore: '1.1.0',
};

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_CONTEXT_CHARS = 16000;
const MAX_FILES = 200;
const MAX_WALK_DEPTH = 3;

export function create(ctx) {
  function dataDir() {
    return ctx.dataDir ?? null;
  }

  function memoryFile() {
    const d = dataDir();
    return d ? join(d, 'memory', 'projects.json') : null;
  }

  function readProjects() {
    const f = memoryFile();
    if (!f || !existsSync(f)) return {};
    try {
      return JSON.parse(readFileSync(f, 'utf8'));
    } catch {
      return {};
    }
  }

  function writeProjects(map) {
    const f = memoryFile();
    if (!f) return;
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, JSON.stringify(map, null, 2), 'utf8');
  }

  function gitLog(workspace) {
    try {
      const r = spawnSync('git', ['-C', workspace, 'log', '--oneline', '-20'], {
        shell: false,
        timeout: 5000,
        encoding: 'utf8',
      });
      const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim();
      if (r.status === 0 && out) return out;
      if ((r.stderr ?? '').includes('does not have any commits yet')) return '(репозиторий ещё без коммитов)';
      return '(git-история недоступна: ' + out.split('\n')[0].slice(0, 120) + ')';
    } catch (e) {
      return '(git-история недоступна: ' + (e instanceof Error ? e.message : String(e)) + ')';
    }
  }

  function listFiles(workspace) {
    const out = [];
    const skip = new Set(['.git', 'node_modules']);
    const walk = (dir, depth) => {
      if (depth > MAX_WALK_DEPTH || out.length >= MAX_FILES) return;
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= MAX_FILES) break;
        if (skip.has(e.name)) continue;
        const full = join(dir, e.name);
        const rel = relative(workspace, full).replace(/\\/g, '/');
        if (e.isDirectory()) {
          out.push(rel + '/');
          walk(full, depth + 1);
        } else if (e.isFile()) {
          let size = '';
          try {
            size = ' (' + statSync(full).size + ' B)';
          } catch {
            /* размер не критичен */
          }
          out.push(rel + size);
        }
      }
    };
    walk(workspace, 0);
    return out;
  }

  function summarizeSteps(results) {
    if (!results || results.length === 0) return '(шагов не было)';
    const lines = [];
    for (const r of results) {
      const label = r.status === 'ok' ? 'OK' : r.status === 'fail' ? 'FAIL' : r.status === 'denied' ? 'DENIED' : 'SKIP';
      lines.push('- ШАГ ' + r.i + ' ' + label + ': ' + String(r.title ?? '').slice(0, 100) + (r.failReason ? ' — ' + String(r.failReason).split('\n')[0].slice(0, 140) : ''));
    }
    return lines.join('\n');
  }

  // --- маршруты ---
  ctx.registerRoute('GET', '/features/project-memory/projects', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, projects: readProjects() }));
  });

  ctx.registerRoute('GET', '/features/project-memory/context', (req, res) => {
    const url = new URL(req.url ?? '/features/project-memory/context', 'http://local');
    const wd = (url.searchParams.get('workdir') ?? '').trim();
    const root = ctx.config?.workspaceRoot;
    if (!wd || !root) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'нужны ?workdir= и config.workspaceRoot' }));
      return;
    }
    const p = join(root, wd, 'CONTEXT.md');
    if (!existsSync(p)) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'CONTEXT.md не найден для "' + wd + '"' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    res.end(readFileSync(p, 'utf8'));
  });

  return {
    onTaskStart(info) {
      const p = join(info.workspace, 'CONTEXT.md');
      if (!existsSync(p)) return;
      let md = '';
      try {
        md = readFileSync(p, 'utf8');
      } catch (e) {
        ctx.log('warn', '[MEMORY] CONTEXT.md не прочитан: ' + (e instanceof Error ? e.message : String(e)));
        return;
      }
      const lines = md.split('\n');
      const preview = lines.slice(0, 24).join('\n') + (lines.length > 24 ? '\n… (' + (lines.length - 24) + ' строк ещё)' : '');
      ctx.log('info', '[MEMORY] Найден CONTEXT.md («' + info.title + '», ' + lines.length + ' строк) — контекст предыдущих сессий:\n' + preview);
    },

    onTaskDone(info) {
      const ok = (info.results ?? []).filter((r) => r.status === 'ok').length;
      const fail = (info.results ?? []).filter((r) => r.status === 'fail').length;
      const skip = (info.results ?? []).filter((r) => r.status === 'skip').length;
      const denied = (info.results ?? []).filter((r) => r.status === 'denied').length;
      const wd = info.meta?.workdir || String(info.workspace ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'project';
      const now = new Date().toISOString();

      const md = [
        '# CONTEXT: ' + info.title,
        '',
        'Проект: ' + wd,
        'Workspace: ' + info.workspace,
        '',
        '## Последний прогон',
        '- Статус: ' + info.status,
        '- Цикл: ' + (info.meta?.cycle ?? '?'),
        '- Дата: ' + now,
        '- Задача: ' + info.taskId,
        '- Шаги: ok=' + ok + ' fail=' + fail + ' skip=' + skip + ' denied=' + denied,
        '',
        '## git log (последние 20)',
        '```',
        gitLog(info.workspace),
        '```',
        '',
        '## Файлы (до ' + MAX_FILES + ', глубина ' + MAX_WALK_DEPTH + ', без .git/node_modules)',
        '```',
        listFiles(info.workspace).join('\n') || '(пусто)',
        '```',
        '',
        '## Сводка шагов',
        summarizeSteps(info.results),
        '',
        '(сгенерировано фичей project-memory при task.done — не редактируйте вручную, будет перезаписан следующим прогоном)',
        '',
      ].join('\n');
      try {
        writeFileSync(join(info.workspace, 'CONTEXT.md'), md.slice(0, MAX_CONTEXT_CHARS), 'utf8');
        ctx.log('info', '[MEMORY] CONTEXT.md обновлён (' + wd + ', статус ' + info.status + ', цикл ' + (info.meta?.cycle ?? '?') + ')');
      } catch (e) {
        ctx.log('warn', '[MEMORY] CONTEXT.md не записан: ' + (e instanceof Error ? e.message : String(e)));
      }

      const map = readProjects();
      const firstFail = (info.results ?? []).find((r) => r.failReason)?.failReason;
      map[wd] = {
        title: info.title,
        lastStatus: info.status,
        lastCycle: info.meta?.cycle ?? null,
        lastDate: now,
        runs: (map[wd]?.runs ?? 0) + 1,
        summary:
          info.status === 'SUCCESS'
            ? 'все шаги OK (' + ok + '/' + (info.results?.length ?? 0) + ')'
            : firstFail
              ? String(firstFail).split('\n')[0].slice(0, 200)
              : info.status + ' (' + ok + '/' + (info.results?.length ?? 0) + ' шагов OK)',
        notes: (info.notes ?? []).slice(0, 5),
      };
      try {
        writeProjects(map);
        ctx.log('info', '[MEMORY] Карта проектов обновлена: ' + wd);
      } catch (e) {
        ctx.log('warn', '[MEMORY] projects.json не записан: ' + (e instanceof Error ? e.message : String(e)));
      }
    },
  };
}
