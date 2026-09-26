// core/reporter.ts — генерация markdown-отчёта по §5.
import { EngineResult, StepResult } from './stepEngine.js';
import { TzDoc } from '../tz/model.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export function renderReport(
  doc: TzDoc,
  result: EngineResult,
  taskId: string,
): string {
  const lines: string[] = [];
  const completed = result.results.filter(
    (r) => r.status === 'ok' || r.status === 'fail' || r.status === 'denied',
  ).length;
  const total = result.results.length;

  lines.push(`# ОТЧЁТ: ${doc.title}`);
  lines.push(
    `СТАТУС: ${result.status} — шагов выполнено ${completed}/${total}. workdir: ${result.workspace}`,
  );
  lines.push('');

  for (const r of result.results) {
    const statusLabel =
      r.status === 'ok' ? 'OK' :
      r.status === 'fail' ? 'FAIL' :
      r.status === 'denied' ? 'DENIED' : 'SKIP';
    const sec = (r.durationMs / 1000).toFixed(2);
    const exitStr = r.exitCode !== undefined ? `exit=${r.exitCode}` : 'exit=-';
    lines.push(`## ШАГ ${r.i} ${statusLabel} (${exitStr}, ${sec}s)`);
    if (r.cmd) lines.push(`CMD: ${r.cmd}`);
    if (r.outputTail) {
      lines.push('STDOUT/STDERR (хвост ≤30 строк):');
      for (const l of r.outputTail.split('\n')) {
        lines.push(`  ${l}`);
      }
    }
    if (r.status === 'fail' && r.failReason) {
      lines.push('');
      lines.push('ДИАГНОСТИКА:');
      lines.push(`- Причина: ${r.failReason}`);
      if (r.expects && r.expects.length > 0) {
        lines.push(`- Ожидалось: ${r.expects.join('; ')}`);
      }
      lines.push(`- exit=${r.exitCode ?? '-'}`);
    }
    if (r.notes && r.notes.length > 0) {
      // Не дублируем в каждый шаг — выводим заметки шага здесь.
      for (const n of r.notes) {
        lines.push(`- ${n}`);
      }
    }
    lines.push('');
  }

  if (result.notes.length > 0) {
    lines.push('ЗАМЕТКИ:');
    for (const n of result.notes) lines.push(`- ${n}`);
    lines.push('');
  }

  // ВОПРОСЫ К ЧАТУ — собираем ASK из док'а
  const asks: string[] = [];
  for (const step of doc.steps) {
    for (const d of step.directives) {
      if (d.kind === 'ASK') asks.push(d.text);
    }
  }
  if (asks.length > 0) {
    lines.push('ВОПРОСЫ К ЧАТУ:');
    for (const a of asks) lines.push(`- ${a}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function saveReport(
  md: string,
  reportsDir: string,
  taskId: string,
): string {
  mkdirSync(reportsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = resolve(reportsDir, `${taskId}_${ts}.md`);
  writeFileSync(path, md, 'utf8');
  return path;
}
