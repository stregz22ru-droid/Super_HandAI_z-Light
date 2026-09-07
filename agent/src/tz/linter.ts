// tz/linter.ts — статические проверки безопасности и формата.
import { TzDoc, Directive } from './model.js';

export interface LintIssue {
  line: number;
  level: 'error' | 'warn';
  msg: string;
}

// cmd-синтаксис в pwsh
const CMD_PATTERNS: { re: RegExp; msg: string }[] = [
  { re: /^\s*mkdir\s+-p\b/m, msg: 'mkdir -p — cmd/POSIX-синтаксис, не годится для pwsh' },
  { re: /^\s*del\s+/m, msg: 'del — cmd-утилита, не работает в pwsh' },
  { re: /^\s*rd\s+/m, msg: 'rd — cmd-утилита, не работает в pwsh' },
  { re: /^\s*copy\s+/m, msg: 'copy — cmd-утилита, не работает в pwsh' },
];

// POSIX-маркеры в pwsh
const POSIX_IN_PWSH: { re: RegExp; msg: string }[] = [
  { re: /\bgrep\b/, msg: 'grep — POSIX-утилита, используйте shell: bash' },
  { re: /\bsed\b/, msg: 'sed — POSIX-утилита' },
  { re: /\bawk\b/, msg: 'awk — POSIX-утилита' },
  { re: /^\s*ls\s/m, msg: 'ls в pwsh — alias для Get-ChildItem, лучше явный Get-ChildItem' },
  { re: /^\s*export\s/m, msg: 'export — POSIX-синтаксис, не работает в pwsh' },
  { re: /\bwhich\s/, msg: 'which — POSIX-утилита, в pwsh используйте Get-Command' },
];

function isAbsoluteOrUp(path: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(path)) return true; // Windows absolute
  if (path.startsWith('/')) return true; // POSIX absolute
  if (path.startsWith('\\')) return true;
  // .. сегменты
  const segs = path.split(/[\\/]/);
  if (segs.some((s) => s === '..')) return true;
  return false;
}

// Главная функция линтера.
export function lint(doc: TzDoc): LintIssue[] {
  const issues: LintIssue[] = [];
  let lineEstimate = 1; // приблизительная нумерация для диагностик

  // Проверка режима ASK в mode auto
  if (doc.meta.mode === 'auto') {
    for (const s of doc.steps) {
      for (const d of s.directives) {
        if (d.kind === 'ASK') {
          issues.push({
            line: lineEstimate,
            level: 'warn',
            msg: `ASK в mode: auto — агент не остановится для ответа`,
          });
        }
      }
    }
  }

  for (const step of doc.steps) {
    for (const d of step.directives) {
      lintDirective(d, issues, lineEstimate);
      lineEstimate += 2; // грубая оценка шагов строк
    }
  }
  return issues;
}

function lintDirective(d: Directive, issues: LintIssue[], line: number): void {
  switch (d.kind) {
    case 'RUN': {
      if (d.expects.length === 0) {
        issues.push({ line, level: 'error', msg: 'RUN без EXPECT' });
      }
      const shell = d.shell ?? 'pwsh';
      if (shell === 'pwsh') {
        lintPwsh(d.script, issues, line);
      } else {
        // bash — cmd-синтаксис не критичен, но warn
        if (/^\s*(mkdir|del|rd|copy)\s/m.test(d.script)) {
          issues.push({
            line,
            level: 'warn',
            msg: 'cmd-утилита в shell: bash — лучше POSIX-эквиваленты',
          });
        }
      }
      // %VAR% — cmd-синтаксис (только в pwsh критично)
      if (d.shell === 'pwsh' || (!d.shell && /%[\w]+%/.test(d.script))) {
        if (/%[\w]+%/.test(d.script)) {
          issues.push({
            line,
            level: 'error',
            msg: '%VAR% — cmd-синтаксис, в pwsh используйте $env:VAR',
          });
        }
      }
      break;
    }
    case 'RUN_BG': {
      if (!d.waitMarker || d.waitMarker.trim() === '') {
        issues.push({ line, level: 'error', msg: 'RUN_BG без WAIT' });
      }
      const shell = d.shell ?? 'pwsh';
      if (shell === 'pwsh') {
        lintPwsh(d.script, issues, line);
      }
      break;
    }
    case 'WRITE': {
      if (isAbsoluteOrUp(d.path)) {
        issues.push({
          line,
          level: 'error',
          msg: `WRITE путь должен быть относительным внутри workdir: "${d.path}"`,
        });
      }
      break;
    }
    case 'ASK':
    case 'GIT':
    case 'NOTE':
      break;
  }
}

function lintPwsh(script: string, issues: LintIssue[], line: number): void {
  for (const p of CMD_PATTERNS) {
    if (p.re.test(script)) {
      issues.push({ line, level: 'error', msg: p.msg });
    }
  }
  for (const p of POSIX_IN_PWSH) {
    if (p.re.test(script)) {
      issues.push({ line, level: 'error', msg: p.msg });
    }
  }
  // ; -цепочка cmdlet без exit $LASTEXITCODE — warn, если детектится надёжно
  // (пропустим: слишком эвристично)
}
