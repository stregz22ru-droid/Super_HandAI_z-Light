// core/stepEngine.ts — последовательное исполнение шагов ТЗ.
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TzDoc, Directive, parseExpect, type ExpectPredicate } from '../tz/model.js';
import { resolveShell, type AgentConfig } from '../config.js';
import { checkScript } from './guard.js';
import {
  run,
  runBg,
  waitFor,
  trackBg,
  killAll,
  type BgHandle,
} from './ptyManager.js';
import { journalAppend } from './journal.js';
// СИСТЕМА ФИЧ: слоты (beforeRun/afterRun/onFail) — без активного реестра это но-оп
import { featuresBeforeRun, featuresAfterRun, featuresOnFail, featuresSessionStart, endSession, getSessionState, pushSessionContext, getSlotBudgetMs } from '../features/registry.js';

export type StepStatus = 'ok' | 'fail' | 'skip' | 'denied';

export interface StepResult {
  i: number;
  title: string;
  status: StepStatus;
  exitCode?: number;
  durationMs: number;
  cmd?: string;
  outputTail?: string;
  expects?: string[];
  matchedExpect?: boolean;
  failReason?: string;
  notes?: string[];
}

export interface EngineCallbacks {
  onStepStatus?: (
    i: number,
    state: 'run' | 'ok' | 'fail' | 'skip' | 'denied' | 'confirm',
    extra?: { exit?: number; ms?: number; msg?: string },
  ) => void;
  onPtyData?: (task: string, data: string) => void;
  onNote?: (text: string) => void;
  // Долг N8: запрос подтверждения шага у оператора. true = исполнить, false = отменить шаг.
  onNeedConfirm?: (i: number, kind: 'RUN' | 'RUN_BG', preview: string) => Promise<boolean>;
}

export interface EngineResult {
  status: 'SUCCESS' | 'PARTIAL' | 'STOPPED' | 'DENIED';
  results: StepResult[];
  notes: string[];
  workspace: string;
}

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;:<=?>]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

function cleanTail(normText: string, maxLines: number = 30): string {
  const all = normText
    .split('\n')
    .map((l) => l.replace(/\r/g, '').trimEnd())
    .filter((l) => l.trim().length > 0);
  const out: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const l = all[i];
    if (l.length === 1) {
      const prev = out.length > 0 ? out[out.length - 1] : '';
      const next = i + 1 < all.length ? all[i + 1] : '';
      const prevFirst = prev.length > 1 ? prev.trimStart()[0] : '';
      const nextFirst = next.length > 1 ? next.trimStart()[0] : '';
      if ((prevFirst !== '' && prevFirst === l[0]) || (nextFirst !== '' && nextFirst === l[0])) continue;
    }
    if (out.length > 0 && out[out.length - 1] === l) continue;
    out.push(l);
  }
  if (out.length < all.length) {
    out.unshift('[обрезано: показано ' + out.length + ' из ' + all.length + ' непустых строк]');
  }
  return out.slice(-maxLines).join('\n');
}

export function resolveWorkspace(
  cfg: AgentConfig,
  doc: TzDoc,
): { workspace: string; note?: string } {
  const meta = doc.meta;
  const root = cfg.workspaceRoot;
  if (!meta.workdir) {
    return { workspace: root };
  }
  const m = /^new:(.+)$/.exec(meta.workdir);
  if (m) {
    const name = m[1].trim();
    let target = join(root, name);
    let i = 2;
    while (existsSync(target)) {
      target = join(root, name + '-' + i);
      i++;
    }
    mkdirSync(target, { recursive: true });
    return { workspace: target };
  }
  const target = join(root, meta.workdir.trim());
  if (!existsSync(target)) mkdirSync(target, { recursive: true });
  return { workspace: target };
}

function hasGit(): boolean {
  const r = spawnSync('git', ['--version'], { shell: false });
  return r.status === 0;
}

function writeStepFile(workspace: string, relPath: string, content: string): string {
  const target = resolve(workspace, relPath);
  const normWs = workspace.replace(/\\/g, '/').toLowerCase();
  const normTarget = target.replace(/\\/g, '/').toLowerCase();
  if (!normTarget.startsWith(normWs)) {
    throw new Error('WRITE пытается выйти за пределы workdir: ' + relPath);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
}

function checkExpect(
  pred: ExpectPredicate,
  exitCode: number | null,
  output: string,
  workspace: string,
): boolean {
  switch (pred.type) {
    case 'exit':
      return exitCode === pred.code;
    case 'stdoutContains':
      return output.includes(pred.needle.trim());
    case 'stdoutRegex':
      try {
        const re = new RegExp(pred.pattern.trim(), pred.flags ?? '');
        return re.test(output);
      } catch {
        return false;
      }
    case 'fileExists': {
      const p = resolve(workspace, pred.path);
      return existsSync(p);
    }
  }
}

async function execRun(
  cfg: AgentConfig,
  workspace: string,
  d: Extract<Directive, { kind: 'RUN' }>,
  taskId: string,
  logPath: string,
  cb: EngineCallbacks,
): Promise<{
  status: StepStatus;
  exitCode?: number;
  durationMs: number;
  cmd: string;
  outputTail: string;
  matchedExpect: boolean;
  failReason?: string;
}> {
  const { cmd, args } = resolveShell(cfg, d.shell, []);
  const script = d.script;
  const fullArgs = [...args, script];
  const startedAt = Date.now();
  let outFull = '';

  const result = await run(
    { cmd, args: fullArgs, cwd: workspace, timeoutMs: cfg.stepTimeoutSec * 1000 },
    {
      onData: (data) => {
        outFull += data;
        try { appendFileSync(logPath, data, 'utf8'); } catch { }
        cb.onPtyData?.(taskId, data);
      },
    },
  );

  const durationMs = Date.now() - startedAt;
  const outNorm = stripAnsi(outFull);
  let matched = true;
  for (const e of d.expects) {
    const p = parseExpect(e);
    if (!p) { matched = false; continue; }
    const r = checkExpect(p, result.exitCode, outNorm, workspace);
    if (!r) matched = false;
  }
  if (d.expects.length === 0) matched = false;

  const tail = cleanTail(outNorm);
  const status: StepStatus = matched ? 'ok' : 'fail';

  return {
    status,
    exitCode: result.exitCode ?? undefined,
    durationMs,
    cmd: script.split('\n')[0],
    outputTail: tail,
    matchedExpect: matched,
    failReason: matched
      ? undefined
      : result.killedByTimeout
        ? 'таймаут ' + cfg.stepTimeoutSec + 's'
        : 'EXPECT не совпал (exit=' + result.exitCode + '); expects: ' + d.expects.join('; '),
  };
}

async function execRunBg(
  cfg: AgentConfig,
  workspace: string,
  d: Extract<Directive, { kind: 'RUN_BG' }>,
  taskId: string,
  logPath: string,
  cb: EngineCallbacks,
): Promise<{
  status: StepStatus;
  durationMs: number;
  cmd: string;
  outputTail: string;
  matchedExpect: boolean;
  failReason?: string;
}> {
  const { cmd, args } = resolveShell(cfg, d.shell, []);
  const script = d.script;
  const fullArgs = [...args, script];
  const startedAt = Date.now();

  const handle: BgHandle = await runBg(
    { cmd, args: fullArgs, cwd: workspace },
    d.waitMarker,
    (data) => {
      try { appendFileSync(logPath, data, 'utf8'); } catch { }
      cb.onPtyData?.(taskId, data);
    },
  );
  trackBg(handle);

  const found = await waitFor(handle, cfg.stepTimeoutSec * 1000);
  const durationMs = Date.now() - startedAt;

  return {
    status: found ? 'ok' : 'fail',
    durationMs,
    cmd: script.split('\n')[0],
    outputTail: cleanTail(stripAnsi(handle.output)),
    matchedExpect: found,
    failReason: found ? undefined : 'маркер "' + d.waitMarker + '" не найден за ' + cfg.stepTimeoutSec + 's',
  };
}

export async function executeDoc(
  doc: TzDoc,
  cfg: AgentConfig,
  taskId: string,
  cb: EngineCallbacks,
  stopSignal: { stopped: boolean },
  logDir: string,
): Promise<EngineResult> {
  const { workspace, note: wsNote } = resolveWorkspace(cfg, doc);
  const notes: string[] = [];
  if (wsNote) notes.push(wsNote);

  const metaMirror = 'META-движка: on_fail=' + JSON.stringify(doc.meta.on_fail) +
    ', mode=' + JSON.stringify(doc.meta.mode) +
    ', workdir=' + JSON.stringify(doc.meta.workdir) +
    ', cycle=' + JSON.stringify(doc.meta.cycle);
  notes.push(metaMirror);
  cb.onNote?.(metaMirror);

  const confirmMode = doc.meta.mode === 'confirm';

  const results: StepResult[] = [];
  const gitOk = hasGit();
  if (!gitOk) notes.push('git отсутствует в PATH — GIT commit будут пропущены');

  let gitInitialized = false;
  function ensureGitInit() {
    if (!gitOk || gitInitialized) return;
    const r = spawnSync('git', ['-C', workspace, 'init'], { shell: false });
    if (r.status === 0) gitInitialized = true;
    else notes.push('git init failed: ' + (r.stderr ?? '').toString().slice(0, 200));
  }

  let stopped = false;
  let denied = false;
  let partialDueToFail = false;

  // Base-этап 2: активация сессии задачи
  try {
    featuresSessionStart({ taskId, workspace, stepCount: doc.steps.length });
  } catch { /* never-block */ }
  for (let si = 0; si < doc.steps.length; si++) {
    const step = doc.steps[si];
    const i = si + 1;

    if (stopped || denied || partialDueToFail) {
      results.push({ i, title: step.title, status: 'skip', durationMs: 0 });
      cb.onStepStatus?.(i, 'skip');
      continue;
    }

    cb.onStepStatus?.(i, 'run');
    const stepNotes: string[] = [];
    let stepFailed = false;
    let stepDenied = false;
    let stepSkippedByOperator = false;
    // СИСТЕМА ФИЧ: счётчики для статуса шага «все директивы пропущены фичей»
    let executableDirectives = 0;
    let skippedByFeature = 0;
    let stepDurationMs = 0;
    let stepExitCode: number | undefined;
    let stepCmd: string | undefined;
    let stepOutputTail: string | undefined;
    let stepExpects: string[] | undefined;
    let stepMatched: boolean | undefined;
    let stepFailReason: string | undefined;

    for (const d of step.directives) {
      if (stopSignal.stopped) { stopped = true; break; }

      // === СИСТЕМА ФИЧ: слот beforeRun (фича может skip-нуть или DENY-нуть директиву) ===
      // BASE ЭТАП 2 (B4): deny-ветка — единственная врезка в ядро (одобрена
      // Мастером). Без включённой фичи check вердиктов нет → но-оп, поведение
      // побайтово совпадает с базовым. Guard-DENY остаётся финальным: deny
      // отсюда не может разрешить то, что guard запретит ниже.
      if (d.kind === 'RUN' || d.kind === 'RUN_BG' || d.kind === 'WRITE' || d.kind === 'GIT') {
        executableDirectives++;
        const verdict = await featuresBeforeRun(i, d);
        if (verdict && verdict.deny) {
          const denyReason = verdict.reason ?? 'denied (CHECK)';
          stepDenied = true;
          stepNotes.push('DENIED(CHECK): ' + denyReason);
          cb.onPtyData?.(taskId, '\x1b[31m[DENIED] ' + d.kind + ' (CHECK): ' + denyReason + '\x1b[0m\r\n');
          journalAppend({
            ts: new Date().toISOString(),
            taskId,
            step: i,
            action: d.kind,
            durationMs: 0,
            note: 'denied(CHECK): ' + denyReason,
          });
          void featuresOnFail(i, 'DENIED(CHECK): ' + denyReason, { taskId, i, kind: d.kind, status: 'denied' });
          cb.onStepStatus?.(i, 'denied', { msg: denyReason });
          break;
        }
        if (verdict && verdict.skip) {
          skippedByFeature++;
          const skipReason = verdict.reason ?? 'skip (фича)';
          stepNotes.push('SKIP(фича): ' + skipReason);
          cb.onPtyData?.(taskId, '\x1b[35m[SKIP] ' + d.kind + ': ' + skipReason + '\x1b[0m\r\n');
          journalAppend({
            ts: new Date().toISOString(),
            taskId,
            step: i,
            action: d.kind,
            durationMs: 0,
            note: 'skip: ' + skipReason,
          });
          continue;
        }
      }
      // ================================================================

      if (d.kind === 'WRITE') {
        const guardRes = checkScript('', cfg.workspaceRoot, d.path);
        if (guardRes.denied) {
          stepDenied = true;
          stepNotes.push('DENIED: ' + guardRes.reason);
          // СИСТЕМА ФИЧ: слот onFail
          void featuresOnFail(i, 'DENIED: ' + guardRes.reason, { taskId, i, kind: 'WRITE', status: 'denied' });
          cb.onStepStatus?.(i, 'denied', { msg: guardRes.reason });
          break;
        }
        try {
          writeStepFile(workspace, d.path, d.content);
          const lines = d.content.split('\n').length;
          cb.onPtyData?.(taskId, '\x1b[36m✎ write ' + d.path + ' (' + lines + ' строк)\x1b[0m\r\n');
          stepNotes.push('write ' + d.path);
          stepExitCode = 0;
          // СИСТЕМА ФИЧ: слот afterRun
          void featuresAfterRun(i, { taskId, i, kind: 'WRITE', status: 'ok', cmd: 'WRITE ' + d.path });
          if (d.expects.length > 0) {
            stepCmd = 'WRITE ' + d.path;
            stepExpects = d.expects;
            let allOk = true;
            for (const e of d.expects) {
              const p = parseExpect(e);
              if (!p) { allOk = false; continue; }
              const r = checkExpect(p, 0, '', workspace);
              if (!r) { allOk = false; stepFailReason = 'WRITE EXPECT не прошёл: ' + e; }
            }
            stepMatched = allOk;
            if (!allOk) { stepFailed = true; cb.onStepStatus?.(i, 'fail', { msg: stepFailReason }); break; }
          }
        } catch (e) {
          stepFailed = true;
          stepFailReason = 'WRITE failed: ' + (e instanceof Error ? e.message : String(e));
          // СИСТЕМА ФИЧ: слот onFail
          void featuresOnFail(i, stepFailReason, { taskId, i, kind: 'WRITE', status: 'fail' });
        }
        continue;
      }
      if (d.kind === 'NOTE') {
        stepNotes.push('NOTE: ' + d.text);
        cb.onNote?.(d.text);
        continue;
      }
      if (d.kind === 'ASK') {
        stepNotes.push('ASK: ' + d.text);
        cb.onNote?.('[ASK] ' + d.text);
        continue;
      }
      if (d.kind === 'GIT') {
        if (!gitOk) { stepNotes.push('GIT пропущен (git отсутствует): ' + d.msg); continue; }
        ensureGitInit();
        const r1 = spawnSync('git', ['-C', workspace, 'add', '-A'], { shell: false });
        const r2 = spawnSync('git', ['-C', workspace, 'commit', '-m', d.msg], {
          shell: false,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'SuperHandAIz',
            GIT_AUTHOR_EMAIL: 'agent@local',
            GIT_COMMITTER_NAME: 'SuperHandAIz',
            GIT_COMMITTER_EMAIL: 'agent@local',
          } as Record<string, string>,
        });
        stepExitCode = r2.status === 0 ? 0 : (r2.status ?? 1);
        if (r2.status !== 0) {
          const gitOut = ((r2.stdout ?? '').toString() + (r2.stderr ?? '').toString()).toLowerCase();
          if (gitOut.includes('nothing to commit') || gitOut.includes('no changes added')) {
            stepNotes.push('GIT commit: нечего коммитить (без изменений с прошлого чекпоинта) — "' + d.msg + '"');
          } else {
            const errText = ((r2.stderr ?? '').toString() || (r2.stdout ?? '').toString()).slice(0, 200);
            stepNotes.push('GIT commit failed (status=' + r2.status + '): ' + (errText || '(вывод пуст)'));
          }
        } else {
          stepNotes.push('GIT commit: ' + d.msg);
        }
        // СИСТЕМА ФИЧ: слот afterRun
        void featuresAfterRun(i, {
          taskId,
          i,
          kind: 'GIT',
          status: r2.status === 0 ? 'ok' : 'fail',
          cmd: 'GIT commit: ' + d.msg,
          exitCode: stepExitCode,
        });
        continue;
      }

      const guardRes = checkScript(d.script, cfg.workspaceRoot);
      if (guardRes.denied) {
        stepDenied = true;
        stepNotes.push('DENIED: ' + guardRes.reason);
        // СИСТЕМА ФИЧ: слот onFail
        void featuresOnFail(i, 'DENIED: ' + guardRes.reason, { taskId, i, kind: d.kind, status: 'denied' });
        cb.onStepStatus?.(i, 'denied', { msg: guardRes.reason });
        break;
      }

      // === ДОЛГ N8: confirm-режим ===
      if (confirmMode && cb.onNeedConfirm) {
        cb.onStepStatus?.(i, 'confirm');
        const kind = d.kind === 'RUN_BG' ? 'RUN_BG' : 'RUN';
        const preview = (d.script.split('\n')[0] || '').slice(0, 120);
        const answer = await cb.onNeedConfirm(i, kind as 'RUN' | 'RUN_BG', preview);
        if (!answer) {
          stepSkippedByOperator = true;
          stepNotes.push('шаг отменён оператором в confirm-режиме');
          break;
        }
      }
      // ===============================

      const logPath = resolve(logDir, taskId + '_step' + i + '.log');
      if (d.kind === 'RUN_BG') {
        const res = await execRunBg(cfg, workspace, d, taskId, logPath, cb);
        stepDurationMs += res.durationMs;
        stepCmd = res.cmd;
        stepOutputTail = res.outputTail;
        stepMatched = res.matchedExpect;
        stepExpects = ['WAIT stdout: ' + d.waitMarker];
        if (res.failReason) stepFailReason = res.failReason;
        // СИСТЕМА ФИЧ: слоты afterRun (+onFail при отказе)
        void featuresAfterRun(i, {
          taskId,
          i,
          kind: 'RUN_BG',
          status: res.status === 'fail' ? 'fail' : 'ok',
          cmd: res.cmd,
          durationMs: res.durationMs,
        });
        if (res.status === 'fail') {
          stepFailed = true;
          void featuresOnFail(i, res.failReason ?? 'RUN_BG fail', { taskId, i, kind: 'RUN_BG', status: 'fail', cmd: res.cmd });
          cb.onStepStatus?.(i, 'fail', { ms: res.durationMs, msg: res.failReason });
          break;
        }
      } else if (d.kind === 'RUN') {
        const res = await execRun(cfg, workspace, d, taskId, logPath, cb);
        stepDurationMs += res.durationMs;
        stepExitCode = res.exitCode;
        stepCmd = res.cmd;
        stepOutputTail = res.outputTail;
        stepMatched = res.matchedExpect;
        stepExpects = d.expects;
        if (res.failReason) stepFailReason = res.failReason;
        // СИСТЕМА ФИЧ: слот afterRun
        void featuresAfterRun(i, {
          taskId,
          i,
          kind: 'RUN',
          status: res.status === 'fail' ? 'fail' : 'ok',
          cmd: res.cmd,
          exitCode: res.exitCode,
          durationMs: res.durationMs,
        });
        if (res.status === 'fail') {
          stepFailed = true;
          void featuresOnFail(i, res.failReason ?? 'RUN fail', { taskId, i, kind: 'RUN', status: 'fail', cmd: res.cmd });
          cb.onStepStatus?.(i, 'fail', { exit: res.exitCode, ms: res.durationMs, msg: res.failReason });
          break;
        }
      }

      journalAppend({
        ts: new Date().toISOString(),
        taskId,
        step: i,
        action: d.kind,
        exit: stepExitCode,
        durationMs: stepDurationMs,
      });
    }

    // СИСТЕМА ФИЧ: шаг, в котором ВСЕ исполняемые директивы пропущены фичей — 'skip'
    const allSkippedByFeature = executableDirectives > 0 && skippedByFeature === executableDirectives;
    const finalStatus: StepStatus = stepDenied
      ? 'denied'
      : stepSkippedByOperator
        ? 'skip'
        : stepFailed
          ? 'fail'
          : allSkippedByFeature
            ? 'skip'
            : 'ok';

    results.push({
      i,
      title: step.title,
      status: finalStatus,
      exitCode: stepExitCode,
      durationMs: stepDurationMs,
      cmd: stepCmd,
      outputTail: stepOutputTail,
      expects: stepExpects,
      matchedExpect: stepMatched,
      failReason: stepFailReason,
      notes: stepNotes,
    });

    if (finalStatus === 'ok') {
      cb.onStepStatus?.(i, 'ok', { exit: stepExitCode, ms: stepDurationMs });
    }

    if (stopSignal.stopped) { stopped = true; killAll(); break; }
    if (stepDenied) { denied = true; killAll(); break; }
    if (stepFailed) {
      if (doc.meta.on_fail === 'stop') {
        partialDueToFail = true;
      }
    }
  }

  killAll();

  let status: 'SUCCESS' | 'PARTIAL' | 'STOPPED' | 'DENIED';
  if (denied) status = 'DENIED';
  else if (stopSignal.stopped || stopped) status = 'STOPPED';
  else if (results.some((r) => r.status === 'fail')) status = 'PARTIAL';
  else status = 'SUCCESS';

  return { status, results, notes, workspace };
}