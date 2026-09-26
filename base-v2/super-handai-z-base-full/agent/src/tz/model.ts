// tz/model.ts — Zod-схемы формата ТЗ.
import { z } from 'zod';

// Директивы шага
export const RunDirective = z.object({
  kind: z.literal('RUN'),
  shell: z.enum(['pwsh', 'bash']).optional(),
  script: z.string(),
  expects: z.array(z.string()).default([]),
  bg: z.literal(false).default(false),
  waitMarker: z.string().optional(),
});
export type RunDirective = z.infer<typeof RunDirective>;

export const RunBgDirective = z.object({
  kind: z.literal('RUN_BG'),
  shell: z.enum(['pwsh', 'bash']).optional(),
  script: z.string(),
  expects: z.array(z.string()).default([]),
  bg: z.literal(true).default(true),
  waitMarker: z.string(), // WAIT stdout: <маркер>
});
export type RunBgDirective = z.infer<typeof RunBgDirective>;

export const WriteDirective = z.object({
  kind: z.literal('WRITE'),
  path: z.string(),
  content: z.string(),
  expects: z.array(z.string()).default([]),
});
export type WriteDirective = z.infer<typeof WriteDirective>;

export const AskDirective = z.object({
  kind: z.literal('ASK'),
  text: z.string(),
});
export type AskDirective = z.infer<typeof AskDirective>;

export const GitCommitDirective = z.object({
  kind: z.literal('GIT'),
  msg: z.string(),
});
export type GitCommitDirective = z.infer<typeof GitCommitDirective>;

export const NoteDirective = z.object({
  kind: z.literal('NOTE'),
  text: z.string(),
});
export type NoteDirective = z.infer<typeof NoteDirective>;

export const Directive = z.discriminatedUnion('kind', [
  RunDirective,
  RunBgDirective,
  WriteDirective,
  AskDirective,
  GitCommitDirective,
  NoteDirective,
]);
export type Directive = z.infer<typeof Directive>;

export const Step = z.object({
  title: z.string(),
  directives: z.array(Directive).default([]),
});
export type Step = z.infer<typeof Step>;

export const Meta = z.object({
  workdir: z.string().optional(), // new:<имя> | <имя>
  mode: z.enum(['auto', 'confirm']).default('confirm'),
  on_fail: z.enum(['stop', 'continue']).default('stop'),
  cycle: z.number().int().positive().default(1),
});
export type Meta = z.infer<typeof Meta>;

export const TzDoc = z.object({
  title: z.string(),
  meta: Meta.default({}),
  steps: z.array(Step).default([]),
});
export type TzDoc = z.infer<typeof TzDoc>;

// EXPECT-парсер — превращает строку в предикат
export type ExpectPredicate =
  | { type: 'exit'; code: number }
  | { type: 'stdoutContains'; needle: string }
  | { type: 'stdoutRegex'; pattern: string; flags?: string }
  | { type: 'fileExists'; path: string };

export function parseExpect(line: string): ExpectPredicate | null {
  const s = line.trim();
  if (s.startsWith('exit=')) {
    const code = Number.parseInt(s.slice('exit='.length), 10);
    if (Number.isNaN(code)) return null;
    return { type: 'exit', code };
  }
  if (s.startsWith('stdout contains:')) {
    return { type: 'stdoutContains', needle: s.slice('stdout contains:'.length) };
  }
  if (s.startsWith('stdout regex:')) {
    const rest = s.slice('stdout regex:'.length);
    // Формат: /pattern/flags  или просто pattern
    const m = /^\/(.+)\/([gimsuy]*)$/.exec(rest);
    if (m) return { type: 'stdoutRegex', pattern: m[1], flags: m[2] };
    return { type: 'stdoutRegex', pattern: rest };
  }
  if (s.startsWith('file exists:')) {
    return { type: 'fileExists', path: s.slice('file exists:'.length).trim() };
  }
  return null;
}
