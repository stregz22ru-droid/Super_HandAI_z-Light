// taskJson.ts — JSON-протокол задач (Base Этап 1).
// Структурированная задача без markdown-парсинга: мост/клиент присылает
// TaskJson-объект, конвертация в TzDoc идёт без экранирования и без оградок.

export interface TaskJsonMeta {
  workdir: string;            // 'new:<имя>' | '<имя>'
  mode?: 'auto' | 'confirm';
  on_fail?: 'stop' | 'continue';
  cycle?: number;
}

export interface TaskJsonDirectiveRun {
  kind: 'RUN';
  shell?: 'pwsh' | 'bash';
  script: string;
  expects: string[];
}

export interface TaskJsonDirectiveRunBg {
  kind: 'RUN_BG';
  shell?: 'pwsh' | 'bash';
  script: string;
  waitMarker: string;
}

export interface TaskJsonDirectiveWrite {
  kind: 'WRITE';
  path: string;
  content: string;
  expects?: string[];
}

export interface TaskJsonDirectiveAsk {
  kind: 'ASK';
  text: string;
}

export interface TaskJsonDirectiveGit {
  kind: 'GIT';
  msg: string;
}

export interface TaskJsonDirectiveNote {
  kind: 'NOTE';
  text: string;
}

export type TaskJsonDirective =
  | TaskJsonDirectiveRun
  | TaskJsonDirectiveRunBg
  | TaskJsonDirectiveWrite
  | TaskJsonDirectiveAsk
  | TaskJsonDirectiveGit
  | TaskJsonDirectiveNote;

export interface TaskJsonStep {
  title: string;
  directives: TaskJsonDirective[];
}

export interface TaskJson {
  title: string;
  meta: TaskJsonMeta;
  steps: TaskJsonStep[];
}
// Конвертация TaskJson → TzDoc-совместимый объект (без markdown-парсинга)
export function taskJsonToDoc(tj: import('./taskJson.js').TaskJson): import('./tz/model.js').TzDoc {
  const steps = tj.steps.map((s) => ({
    title: s.title,
    directives: s.directives.map((d) => {
      switch (d.kind) {
        case 'RUN':
          return { kind: 'RUN' as const, shell: d.shell, script: d.script, expects: d.expects, bg: false as const };
        case 'RUN_BG':
          return { kind: 'RUN_BG' as const, shell: d.shell, script: d.script, expects: [] as string[], bg: true as const, waitMarker: d.waitMarker };
        case 'WRITE':
          return { kind: 'WRITE' as const, path: d.path, content: d.content, expects: d.expects ?? [] };
        case 'ASK':
          return { kind: 'ASK' as const, text: d.text };
        case 'GIT':
          return { kind: 'GIT' as const, msg: d.msg };
        case 'NOTE':
          return { kind: 'NOTE' as const, text: d.text };
      }
    }),
  }));
  return {
    title: tj.title,
    meta: {
      workdir: tj.meta.workdir,
      mode: tj.meta.mode ?? 'confirm',
      on_fail: tj.meta.on_fail ?? 'stop',
      cycle: tj.meta.cycle ?? 1,
    },
    steps,
  };
}

// Валидация TaskJson (лёгкая, без zod)
export function validateTaskJson(obj: unknown): { ok: boolean; error?: string; doc?: import('./taskJson.js').TaskJson } {
  if (typeof obj !== 'object' || obj === null) return { ok: false, error: 'не объект' };
  const o = obj as Record<string, unknown>;
  if (typeof o.title !== 'string' || !o.title) return { ok: false, error: 'нет title' };
  if (typeof o.meta !== 'object' || o.meta === null) return { ok: false, error: 'нет meta' };
  const meta = o.meta as Record<string, unknown>;
  if (typeof meta.workdir !== 'string' || !meta.workdir) return { ok: false, error: 'meta.workdir отсутствует' };
  if (!Array.isArray(o.steps) || o.steps.length === 0) return { ok: false, error: 'steps пуст или отсутствует' };
  for (let i = 0; i < o.steps.length; i++) {
    const st = o.steps[i] as Record<string, unknown>;
    if (typeof st.title !== 'string') return { ok: false, error: 'steps[' + i + '].title не строка' };
    if (!Array.isArray(st.directives)) return { ok: false, error: 'steps[' + i + '].directives не массив' };
    for (let j = 0; j < st.directives.length; j++) {
      const d = st.directives[j] as Record<string, unknown>;
      if (typeof d.kind !== 'string') return { ok: false, error: 'steps[' + i + '].directives[' + j + '].kind не строка' };
      const kinds = ['RUN', 'RUN_BG', 'WRITE', 'ASK', 'GIT', 'NOTE'];
      if (!kinds.includes(String(d.kind))) return { ok: false, error: 'steps[' + i + '].directives[' + j + '].kind неизвестен: ' + d.kind };
    }
  }
  return { ok: true, doc: o as unknown as import('./taskJson.js').TaskJson };
}