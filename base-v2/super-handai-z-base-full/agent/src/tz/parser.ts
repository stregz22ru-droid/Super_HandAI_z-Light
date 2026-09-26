// tz/parser.ts — state-machine разбор формата ТЗ.
import { TzDoc, Step, Directive } from './model.js';

export interface ParseError {
  line: number;
  message: string;
}

export interface ParseResult {
  ok: boolean;
  doc?: TzDoc;
  errors: ParseError[];
}

const FENCE_OPEN_RE = /^```(\w*)\s*$/; // 3 backticks + optional lang
const FENCE_CLOSE_RE = /^```\s*$/;
const FENCE4_OPEN_RE = /^````\w*\s*$/; // 4 backticks (outer wrap)
const FENCE4_CLOSE_RE = /^````\s*$/;

// Срезать BOM, нормализовать CRLF.
function normalize(raw: string): string {
  let s = raw.replace(/^\uFEFF/, '');
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return s;
}

// Срезание внешней обёртки (4 бэктика с меткой tz) и/или внутренней (3 бэктика tz).
function stripWrappers(raw: string): string {
  const lines = raw.split('\n');
  let firstIdx = 0;
  while (firstIdx < lines.length && lines[firstIdx].trim() === '') firstIdx++;
  if (firstIdx >= lines.length) return raw;

  // Внешняя ограда — 4 бэктика с меткой tz (или любая 4-бэктиковая).
  if (FENCE4_OPEN_RE.test(lines[firstIdx])) {
    let closeIdx = -1;
    for (let i = lines.length - 1; i > firstIdx; i--) {
      if (FENCE4_CLOSE_RE.test(lines[i])) {
        closeIdx = i;
        break;
      }
    }
    if (closeIdx > firstIdx) {
      const inner = lines.slice(firstIdx + 1, closeIdx).join('\n');
      return stripWrappers(inner);
    }
  }
  // Внутренняя ограда — 3 бэктика с меткой tz.
  if (FENCE_OPEN_RE.test(lines[firstIdx]) && /^```tz\s*$/.test(lines[firstIdx])) {
    let closeIdx = -1;
    for (let i = lines.length - 1; i > firstIdx; i--) {
      if (FENCE_CLOSE_RE.test(lines[i])) {
        closeIdx = i;
        break;
      }
    }
    if (closeIdx > firstIdx) {
      return lines.slice(firstIdx + 1, closeIdx).join('\n');
    }
  }
  return raw;
}

// Распознать директиву на строке.
type DirectiveHeader =
  | { kind: 'RUN'; shell?: 'pwsh' | 'bash' }
  | { kind: 'RUN_BG'; shell?: 'pwsh' | 'bash' }
  | { kind: 'WRITE'; path: string }
  | { kind: 'ASK'; text: string }
  | { kind: 'GIT'; msg: string }
  | { kind: 'NOTE'; text: string }
  | { kind: 'EXPECT'; payload: string }
  | { kind: 'WAIT'; payload: string }
  | null;

function parseShellHint(rest: string): 'pwsh' | 'bash' | undefined {
  const m = /shell:\s*(pwsh|bash)/.exec(rest);
  return m ? (m[1] as 'pwsh' | 'bash') : undefined;
}

function parseDirectiveLine(line: string): DirectiveHeader {
  const s = line.replace(/^\t+/, '').replace(/^ +/, '');
  if (s.startsWith('RUN_BG')) {
    const rest = s.slice('RUN_BG'.length).trim();
    const shell = parseShellHint(rest);
    return { kind: 'RUN_BG', shell };
  }
  if (s.startsWith('RUN')) {
    const rest = s.slice('RUN'.length).trim();
    const shell = parseShellHint(rest);
    return { kind: 'RUN', shell };
  }
  if (s.startsWith('WRITE ')) {
    return { kind: 'WRITE', path: s.slice('WRITE '.length).trim() };
  }
  // ASK и NOTE: терпимы к двоеточию ("NOTE: текст" = "NOTE текст") — вольность LLM.
  if (s.startsWith('ASK:') || s.startsWith('ASK ')) {
    const rest = s.replace(/^ASK[:\s]+/, '').trim();
    if (rest.length > 0) return { kind: 'ASK', text: rest };
  }
  if (s.startsWith('NOTE:') || s.startsWith('NOTE ')) {
    const rest = s.replace(/^NOTE[:\s]+/, '').trim();
    if (rest.length > 0) return { kind: 'NOTE', text: rest };
  }
  if (s.startsWith('GIT commit:')) {
    const after = s.slice('GIT commit:'.length).trim();
    const m = /^"(.*)"$/.exec(after) || /^'(.*)'$/.exec(after);
    return { kind: 'GIT', msg: m ? m[1] : after };
  }
  if (s.startsWith('GIT:') || s.startsWith('GIT ')) {
    const rest = s.replace(/^GIT[:\s]+/, '').trim().replace(/^commit[:\s]+/i, '').trim();
    const m = /^"(.*)"$/.exec(rest) || /^'(.*)'$/.exec(rest);
    if (rest.length > 0) return { kind: 'GIT', msg: m ? m[1] : rest };
  }
  if (s.startsWith('EXPECT ')) {
    return { kind: 'EXPECT', payload: s.slice('EXPECT '.length) };
  }
  if (s.startsWith('WAIT ')) {
    return { kind: 'WAIT', payload: s.slice('WAIT '.length) };
  }
  return null;
}

// Считать fenced-блок начиная со строки startIdx.
function readFencedBlock(
  lines: string[],
  startIdx: number,
  errors: ParseError[],
): { content: string; nextIdx: number; lang?: string } | null {
  let i = startIdx;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) {
    errors.push({ line: startIdx + 1, message: 'ожидался fenced-блок (3 бэктика), но достигнут конец текста' });
    return null;
  }
  const openMatch = FENCE_OPEN_RE.exec(lines[i]);
  if (!openMatch) {
    errors.push({
      line: i + 1,
      message: 'ожидалось открытие fenced-блока (3 бэктика), получено: "' + lines[i].slice(0, 40) + '"',
    });
    return null;
  }
  const lang = openMatch[1] || undefined;
  const contentStart = i + 1;
  let j = contentStart;
  while (j < lines.length && !FENCE_CLOSE_RE.test(lines[j])) j++;
  if (j >= lines.length) {
    errors.push({ line: i + 1, message: 'fenced-блок не закрыт (нет 3 бэктиков)' });
    return null;
  }
  const content = lines.slice(contentStart, j).join('\n');
  return { content, nextIdx: j + 1, lang };
}

// Главная функция парсинга.
export function parseTz(input: string): ParseResult {
  const errors: ParseError[] = [];
  const normalized = normalize(input);
  const stripped = stripWrappers(normalized);
  const lines = stripped.split('\n');

  let title: string | null = null;
  let meta: Record<string, string> = {};
  const steps: Step[] = [];

  let i = 0;
  let cur: Step | null = null;

  // Поиск заголовка # ЗАДАЧ:
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      i++;
      continue;
    }
    if (trimmed.startsWith('# ЗАДАЧ:') || trimmed.startsWith('# ЗАДАЧ ')) {
      title = trimmed.replace(/^#\s*ЗАДАЧ[:\s]+/, '').trim();
      i++;
      break;
    }
    if (trimmed.startsWith('#')) {
      i++;
      continue;
    }
    errors.push({
      line: i + 1,
      message: 'ожидалось "# ЗАДАЧ: ...", получено: "' + line.slice(0, 50) + '"',
    });
    return { ok: false, errors };
  }
  if (title === null) {
    errors.push({ line: 0, message: 'отсутствует "# ЗАДАЧ:" — заголовок задачи не найден' });
    return { ok: false, errors };
  }

  // Парсинг META и шагов
  let inMeta = false;
  let curRunExpects: string[] = [];
  let curRunBgWait: string | null = null;
  let pendingRun: { kind: 'RUN' | 'RUN_BG'; shell?: 'pwsh' | 'bash'; script: string } | null = null;
  let pendingWrite: { path: string; content: string; expects: string[] } | null = null;

  function flushPendingIntoStep() {
    if (!cur) return;
    if (pendingRun) {
      if (pendingRun.kind === 'RUN') {
        const d: Directive = {
          kind: 'RUN',
          shell: pendingRun.shell,
          script: pendingRun.script,
          expects: curRunExpects.slice(),
          bg: false,
        };
        cur.directives.push(d);
      } else {
        const d: Directive = {
          kind: 'RUN_BG',
          shell: pendingRun.shell,
          script: pendingRun.script,
          expects: [],
          bg: true,
          waitMarker: curRunBgWait ?? '',
        };
        cur.directives.push(d);
      }
      pendingRun = null;
      curRunExpects = [];
      curRunBgWait = null;
    }
    if (pendingWrite) {
      const d: Directive = {
        kind: 'WRITE',
        path: pendingWrite.path,
        content: pendingWrite.content,
        expects: pendingWrite.expects.slice(),
      };
      cur.directives.push(d);
      pendingWrite = null;
    }
  }

  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') continue;

    if (trimmed === '# META' || trimmed.startsWith('# META')) {
      inMeta = true;
      continue;
    }
    if (inMeta) {
      if (trimmed.startsWith('## ')) {
        inMeta = false;
      } else if (trimmed.startsWith('#')) {
        inMeta = false;
        continue;
      } else {
        const m = /^([A-Za-z_][\w-]*)\s*:\s*(.+)$/.exec(trimmed);
        if (m) {
          meta[m[1]] = m[2].trim();
        } else {
          errors.push({ line: i + 1, message: 'неверная строка META: "' + trimmed + '"' });
        }
        continue;
      }
    }

    const stepMatch = /^##\s*ШАГ\s+(\d+)\.\s*(.*)$/.exec(trimmed);
    if (stepMatch) {
      flushPendingIntoStep();
      cur = { title: stepMatch[2].trim(), directives: [] };
      steps.push(cur);
      continue;
    }

    if (!cur) {
      if (trimmed.startsWith('#')) continue;
      errors.push({
        line: i + 1,
        message: 'директива вне шага: "' + trimmed.slice(0, 40) + '"',
      });
      continue;
    }

    const hdr = parseDirectiveLine(line);
    if (!hdr) {
      if (trimmed.startsWith('#')) continue;
      errors.push({
        line: i + 1,
        message: 'неизвестная директива/строка: "' + trimmed.slice(0, 60) + '"',
      });
      continue;
    }

    switch (hdr.kind) {
      case 'RUN':
      case 'RUN_BG': {
        flushPendingIntoStep();
        const block = readFencedBlock(lines, i + 1, errors);
        if (!block) {
          return { ok: false, errors };
        }
        pendingRun = {
          kind: hdr.kind,
          shell: hdr.shell,
          script: block.content,
        };
        pendingWrite = null;
        i = block.nextIdx - 1;
        break;
      }
      case 'EXPECT': {
        if (pendingRun && pendingRun.kind === 'RUN') {
          curRunExpects.push(hdr.payload);
        } else if (pendingWrite) {
          pendingWrite.expects.push(hdr.payload);
        } else {
          errors.push({
            line: i + 1,
            message: 'EXPECT без предшествующего RUN/WRITE: "' + hdr.payload + '"',
          });
        }
        break;
      }
      case 'WAIT': {
        if (pendingRun && pendingRun.kind === 'RUN_BG') {
          const m = /^stdout:\s*(.+)$/.exec(hdr.payload);
          if (m) curRunBgWait = m[1];
          else errors.push({ line: i + 1, message: 'неверный WAIT формат: "' + hdr.payload + '"' });
        } else {
          errors.push({
            line: i + 1,
            message: 'WAIT без предшествующего RUN_BG: "' + hdr.payload + '"',
          });
        }
        break;
      }
      case 'WRITE': {
        flushPendingIntoStep();
        const block = readFencedBlock(lines, i + 1, errors);
        if (!block) return { ok: false, errors };
        pendingWrite = {
          path: hdr.path,
          content: block.content,
          expects: [],
        };
        i = block.nextIdx - 1;
        break;
      }
      case 'ASK': {
        flushPendingIntoStep();
        cur.directives.push({ kind: 'ASK', text: hdr.text });
        break;
      }
      case 'GIT': {
        flushPendingIntoStep();
        cur.directives.push({ kind: 'GIT', msg: hdr.msg });
        break;
      }
      case 'NOTE': {
        flushPendingIntoStep();
        cur.directives.push({ kind: 'NOTE', text: hdr.text });
        break;
      }
      default:
        errors.push({ line: i + 1, message: 'необработанная директива: "' + trimmed + '"' });
    }
  }
  flushPendingIntoStep();

  if (errors.length > 0) return { ok: false, errors };

  const metaObj: {
    workdir?: string;
    mode?: 'auto' | 'confirm';
    on_fail?: 'stop' | 'continue';
    cycle?: number;
  } = {};
  if (meta.workdir) metaObj.workdir = meta.workdir;
  if (meta.mode) metaObj.mode = meta.mode as 'auto' | 'confirm';
  if (meta.on_fail) metaObj.on_fail = meta.on_fail as 'stop' | 'continue';
  if (meta.cycle) {
    const n = Number.parseInt(meta.cycle, 10);
    if (!Number.isNaN(n)) metaObj.cycle = n;
  }

  const doc: TzDoc = {
    title: title,
    meta: {
      workdir: metaObj.workdir,
      mode: metaObj.mode ?? 'confirm',
      on_fail: metaObj.on_fail ?? 'stop',
      cycle: metaObj.cycle ?? 1,
    },
    steps,
  };

  return { ok: true, doc, errors: [] };
}