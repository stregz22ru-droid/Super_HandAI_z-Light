// test/parser.test.ts — ≥10 кейсов по парсеру.
import { describe, it, expect } from 'vitest';
import { parseTz } from '../src/tz/parser.js';

describe('parser', () => {
  it('1. валидный полный документ', () => {
    const tz = `
# ЗАДАЧ: Тестовая задача
# META
workdir: new:test-1
mode: confirm
on_fail: stop
cycle: 1

## ШАГ 1. Первый
RUN shell: pwsh
\`\`\`pwsh
echo hello
\`\`\`
EXPECT exit=0
EXPECT stdout contains:hello

## ШАГ 2. Второй
NOTE это заметка
`;
    const r = parseTz(tz);
    expect(r.ok).toBe(true);
    expect(r.doc?.title).toBe('Тестовая задача');
    expect(r.doc?.meta.workdir).toBe('new:test-1');
    expect(r.doc?.meta.mode).toBe('confirm');
    expect(r.doc?.steps.length).toBe(2);
    expect(r.doc?.steps[0].directives.length).toBe(1);
    expect(r.doc?.steps[0].directives[0].kind).toBe('RUN');
    const r0 = r.doc?.steps[0].directives[0];
    if (r0?.kind === 'RUN' || r0?.kind === 'RUN_BG') {
      expect(r0.script).toBe('echo hello');
    }
    expect((r.doc?.steps[0].directives[0] as any).expects).toEqual([
      'exit=0',
      'stdout contains:hello',
    ]);
  });

  it('2. без # ЗАДАЧ → ошибка', () => {
    const tz = `## ШАГ 1. без заголовка`;
    const r = parseTz(tz);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('3. неизвестная директива → ошибка с номером строки', () => {
    const tz = `# ЗАДАЧ: X
## ШАГ 1. X
BOOM something
`;
    const r = parseTz(tz);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.line === 3)).toBe(true);
  });

  it('4. обёртка 4 бэктика срезается', () => {
    const inner = `# ЗАДАЧ: Внутри
# META
mode: auto

## ШАГ 1. X
NOTE hi
`;
    const tz = '````tz\n' + inner + '\n````';
    const r = parseTz(tz);
    expect(r.ok).toBe(true);
    expect(r.doc?.title).toBe('Внутри');
  });

  it('5. WRITE с собственным fenced-блоком (контент)', () => {
    const tz = `# ЗАДАЧ: W
## ШАГ 1. X
WRITE src/main.ts
\`\`\`ts
const x = 1;
console.log(x);
\`\`\`
`;
    const r = parseTz(tz);
    expect(r.ok).toBe(true);
    const d = r.doc?.steps[0].directives[0];
    expect(d?.kind).toBe('WRITE');
    if (d?.kind === 'WRITE') {
      expect(d.path).toBe('src/main.ts');
      expect(d.content).toBe('const x = 1;\nconsole.log(x);');
    }
  });

  it('6. RUN_BG + WAIT', () => {
    const tz = `# ЗАДАЧ: BG
## ШАГ 1. X
RUN_BG shell: pwsh
\`\`\`pwsh
node server.js
\`\`\`
WAIT stdout: listening:3456
`;
    const r = parseTz(tz);
    expect(r.ok).toBe(true);
    const d = r.doc?.steps[0].directives[0];
    expect(d?.kind).toBe('RUN_BG');
    if (d?.kind === 'RUN_BG') {
      expect(d.shell).toBe('pwsh');
      expect(d.waitMarker).toBe('listening:3456');
      expect(d.script).toBe('node server.js');
    }
  });

  it('7. CRLF нормализуется', () => {
    const tz = '# ЗАДАЧ: CRLF\r\n# META\r\nmode: auto\r\n\r\n## ШАГ 1. X\r\nNOTE hi\r\n';
    const r = parseTz(tz);
    expect(r.ok).toBe(true);
    expect(r.doc?.title).toBe('CRLF');
  });

  it('8. tab-отступы у директив', () => {
    const tz = `# ЗАДАЧ: T
## ШАГ 1. X
\tNOTE tabbed note
`;
    const r = parseTz(tz);
    expect(r.ok).toBe(true);
    const d = r.doc?.steps[0].directives[0];
    expect(d?.kind).toBe('NOTE');
    if (d?.kind === 'NOTE') expect(d.text).toBe('tabbed note');
  });

  it('9. несколько EXPECT на один RUN', () => {
    const tz = `# ЗАДАЧ: E
## ШАГ 1. X
RUN shell: bash
\`\`\`bash
echo hello
\`\`\`
EXPECT exit=0
EXPECT stdout contains:hello
EXPECT stdout regex:hel
`;
    const r = parseTz(tz);
    expect(r.ok).toBe(true);
    const d = r.doc?.steps[0].directives[0];
    if (d?.kind === 'RUN') {
      expect(d.expects.length).toBe(3);
    }
  });

  it('10. кириллица в путях и контенте', () => {
    const tz = `# ЗАДАЧ: Кириллица
## ШАГ 1. Привет
WRITE заметки.txt
\`\`\`text
Привет, мир!
Тестирование.
\`\`\`
`;
    const r = parseTz(tz);
    expect(r.ok).toBe(true);
    const d = r.doc?.steps[0].directives[0];
    if (d?.kind === 'WRITE') {
      expect(d.path).toBe('заметки.txt');
      expect(d.content).toContain('Привет, мир!');
    }
  });

  it('11. обёртка 3 бэктика с меткой tz срезается', () => {
    const tz = '```tz\n# ЗАДАЧ: Внутри tz-fence\n## ШАГ 1. X\nNOTE hi\n```';
    const r = parseTz(tz);
    expect(r.ok).toBe(true);
    expect(r.doc?.title).toBe('Внутри tz-fence');
  });

  it('12. GIT commit с кавычками', () => {
    const tz = `# ЗАДАЧ: G
## ШАГ 1. X
GIT commit: "init: первый коммит"
`;
    const r = parseTz(tz);
    expect(r.ok).toBe(true);
    const d = r.doc?.steps[0].directives[0];
    if (d?.kind === 'GIT') {
      expect(d.msg).toBe('init: первый коммит');
    }
  });
});
