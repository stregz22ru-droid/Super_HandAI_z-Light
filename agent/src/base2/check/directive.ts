// base2/check/directive.ts — B4: логика CHECK-директивы в preRun-слоте.
// Единственная врезка в ядро (beforeRun-слот stepEngine, одобрена Мастером):
//   • при выключенной фиче check слот не зарегистрирован → но-оп неотличим
//     от базового;
//   • Guard-DENY финален и CHECK-ом не перегрывается: если guard-паттерн
//     совпадает, CHECK не вызывается вовсе (guard сам запретит ниже по потоку);
//   • fail-closed для деструктивного класса (CHECK недоступен + деструктивная
//     команда = DENY);
//   • MODIFY трактуется как DENY с предложением (авто-подмена вне первой версии);
//   • CONFIRM в v1 = DENY с пояснением (переподтверждение через META mode=confirm);
//   • все решения — в журнал data/logs/check-decisions.jsonl + терминал;
//     DENY попадает и в отчёт шага (stepNotes через deny-ветку stepEngine);
//   • кэш: hash(команда, рабочая папка, режим), TTL 60 c, инвалидация при
//     смене режима;
//   • origin.agentId передаётся в AGP — статистика решений per-agent (П-1/П-3).
import { resolve as resolvePath } from 'node:path';
import { appendJsonl } from '../atomic.js';
import { getSlotBus } from '../slotBus.js';
import { BusEvents, type ModeChangedEvent } from '../types.js';
import { getCurrentTask } from '../currentTask.js';
import { checkOperation } from './client.js';
import { CheckCache } from './cache.js';
import type { CheckDecisionEntry, CheckVerdict } from './types.js';
import type { AgentConfig } from '../../config.js';
import { checkScript } from '../../core/guard.js';

// Деструктивный класс ВНЕ guard-паттернов: команды, которые при недоступном
// CHECK обязаны получить DENY (fail-closed).
const DESTRUCTIVE_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\brm\s+(?:[^&|;\n]*\s)?-r\b/i, why: 'rm -r (рекурсивное удаление)' },
  { re: /Remove-Item[^|&;\n]*-Recurse/i, why: 'Remove-Item -Recurse' },
  { re: /\bdel\s+\/[sq]/i, why: 'del /S /Q' },
  { re: /\b(?:rd|rmdir)\s+\/s/i, why: 'rd /S' },
  { re: />\s*\/dev\/[a-z]/i, why: 'запись в /dev' },
  { re: /\bgit\s+push\s+[^|&;\n]*(--force|-f)\b/i, why: 'git push --force' },
  { re: /\bgit\s+reset\s+--hard\b/i, why: 'git reset --hard' },
  { re: /\bdrop\s+table\b/i, why: 'DROP TABLE' },
  { re: /\btruncate\s+table\b/i, why: 'TRUNCATE TABLE' },
];

export function isDestructive(script: string): { destructive: boolean; why?: string } {
  for (const p of DESTRUCTIVE_PATTERNS) {
    if (p.re.test(script)) return { destructive: true, why: p.why };
  }
  return { destructive: false };
}

export interface BeforeRunCheckDeps {
  cfg: AgentConfig;
  root: string;
  log?: (level: string, msg: string) => void;
}

export interface BeforeRunCheckHandle {
  beforeRun: (i: number, directive: unknown) => Promise<{ deny: boolean; skip?: never; reason?: string } | undefined>;
  cache: CheckCache;
  dispose: () => void;
}

export function createBeforeRunCheck(deps: BeforeRunCheckDeps): BeforeRunCheckHandle {
  const cfg = deps.cfg;
  const cache = new CheckCache((cfg.check?.cacheTtlSec ?? 60) * 1000);
  const decisionsFile = resolvePath(deps.root, 'data', 'logs', 'check-decisions.jsonl');

  // Инвалидация кэша при смене ЛЮБОГО режима (решения привязаны к режиму).
  const bus = getSlotBus();
  const offMode = bus.on<ModeChangedEvent>(BusEvents.modeChanged, () => {
    cache.invalidateAll();
    deps.log?.('info', '[CHECK] кэш решений инвалидирован (mode.changed)');
  });

  const journal = (entry: CheckDecisionEntry): void => {
    appendJsonl(decisionsFile, entry);
  };

  const beforeRun = async (i: number, directive: unknown): Promise<{ deny: boolean; reason?: string } | undefined> => {
    const d = directive as { kind?: string; script?: string } | null;
    if (!d || (d.kind !== 'RUN' && d.kind !== 'RUN_BG')) return undefined; // WRITE/GIT — вне CHECK v1
    const script = String(d.script ?? '');
    if (!script.trim()) return undefined;

    const cur = getCurrentTask();
    const taskId = cur?.taskId ?? '(вне задачи)';
    const agentId = cur?.origin?.agentId ?? 'unknown';
    const mode = cur?.mode ?? 'manual';
    const workdir = cfg.workspaceRoot;

    // Guard старше CHECK: совпадение deny-паттерна — CHECK не вызывается.
    const g = checkScript(script, cfg.workspaceRoot);
    if (g.denied) {
      journal({
        ts: new Date().toISOString(), taskId, agentId, step: i, kind: d.kind,
        cmdHash: CheckCache.keyOf(script, workdir, mode), cmd: script.split('\n')[0].slice(0, 200),
        verdict: 'DENY', source: 'guard-final', latencyMs: 0, reason: 'guard-DENY финален: ' + (g.reason ?? ''),
        mode,
      });
      return undefined; // guard сам запретит ниже по потоку — не дублируем вердикт
    }

    const key = CheckCache.keyOf(script, workdir, mode);
    const cached = cache.get(key);
    let verdict: CheckVerdict;
    let source: 'cache' | 'agp' | 'fail-closed';
    let latencyMs: number;
    let reason: string | undefined;

    if (cached) {
      verdict = cached.verdict;
      source = 'cache';
      latencyMs = cached.latencyMs;
      reason = cached.reason;
    } else {
      const destructive = isDestructive(script);
      try {
        const r = await checkOperation({
          url: cfg.check?.url ?? 'http://127.0.0.1:8790/agent/check-operation',
          timeoutMs: cfg.check?.timeoutMs ?? 1500,
          agentId,
          operation: 'run',
          script,
          workspace: workdir,
          mode,
          step: i,
          taskId,
        });
        verdict = r.verdict;
        source = 'agp';
        latencyMs = r.latencyMs;
        reason = r.reason;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (destructive.destructive) {
          // fail-closed для деструктивного класса
          verdict = 'DENY';
          source = 'fail-closed';
          latencyMs = 0;
          reason = `CHECK недоступен (${msg.slice(0, 120)}) — fail-closed: деструктивная команда (${destructive.why})`;
        } else {
          // недеструктивная команда при недоступном CHECK — пропуск (ALLOW)
          journal({
            ts: new Date().toISOString(), taskId, agentId, step: i, kind: d.kind,
            cmdHash: key, cmd: script.split('\n')[0].slice(0, 200),
            verdict: 'ALLOW', source: 'fail-closed', latencyMs: 0,
            reason: `CHECK недоступен (${msg.slice(0, 120)}) — команда не деструктивна, исполнение разрешено`,
            mode,
          });
          deps.log?.('info', `[CHECK] шаг ${i}: ALLOW (fail-closed, ${msg.slice(0, 60)}…)`);
          return undefined;
        }
      }
      cache.set(key, { verdict, source, latencyMs, ...(reason ? { reason } : {}) });
    }

    journal({
      ts: new Date().toISOString(), taskId, agentId, step: i, kind: d.kind,
      cmdHash: key, cmd: script.split('\n')[0].slice(0, 200),
      verdict, source, latencyMs, ...(reason ? { reason } : {}), mode,
    });

    if (verdict === 'ALLOW') {
      deps.log?.('info', `[CHECK] шаг ${i}: ALLOW (${source}, ${latencyMs}мс)`);
      return undefined; // не мешаем исполнению
    }
    if (verdict === 'DENY') {
      deps.log?.('error', `[CHECK] шаг ${i}: DENY (${source}, ${latencyMs}мс) — ${reason ?? ''}`);
      return { deny: true, reason: 'CHECK DENY' + (reason ? ': ' + reason : '') };
    }
    if (verdict === 'CONFIRM') {
      // v1: CONFIRM = DENY с пояснением — подтверждение делается через META
      // mode=confirm (штатная confirm-панель) или белый список AGP.
      deps.log?.('warn', `[CHECK] шаг ${i}: CONFIRM (${source}, ${latencyMs}мс) — требуется оператор`);
      return {
        deny: true,
        reason: 'CHECK CONFIRM: требуется подтверждение оператора — запусти задачу с META mode=confirm или добавь команду в белый список AGP' + (reason ? ' (' + reason + ')' : ''),
      };
    }
    // MODIFY: DENY с предложением (авто-подмена вне первой версии).
    deps.log?.('warn', `[CHECK] шаг ${i}: MODIFY (${source}, ${latencyMs}мс) — авто-подмена вне первой версии`);
    return { deny: true, reason: 'CHECK MODIFY (предложение): ' + (reason ?? 'команда требует модификации — см. комментарий шлюза') };
  };

  return {
    beforeRun,
    cache,
    dispose: () => {
      offMode();
      cache.invalidateAll();
    },
  };
}
