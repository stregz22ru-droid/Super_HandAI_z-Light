// test/linter.test.ts
import { describe, it, expect } from 'vitest';
import { lint } from '../src/tz/linter.js';
import { parseTz } from '../src/tz/parser.js';
import type { TzDoc } from '../src/tz/model.js';

function lintText(tz: string) {
  const r = parseTz(tz);
  expect(r.ok).toBe(true);
  return lint(r.doc!);
}

describe('linter', () => {
  it('RUN без EXPECT → error', () => {
    const tz = `# ЗАДАЧ: L
## ШАГ 1. X
RUN shell: bash
\`\`\`bash
echo hi
\`\`\`
`;
    const issues = lintText(tz);
    expect(issues.some((i) => i.level === 'error' && i.msg.includes('RUN без EXPECT'))).toBe(true);
  });

  it('mkdir -p в pwsh → error', () => {
    const tz = `# ЗАДАЧ: L
## ШАГ 1. X
RUN shell: pwsh
\`\`\`pwsh
mkdir -p dist
\`\`\`
EXPECT exit=0
`;
    const issues = lintText(tz);
    expect(issues.some((i) => i.level === 'error' && i.msg.includes('mkdir'))).toBe(true);
  });

  it('%APPDATA% → error', () => {
    const tz = `# ЗАДАЧ: L
## ШАГ 1. X
RUN shell: pwsh
\`\`\`pwsh
echo %APPDATA%
\`\`\`
EXPECT exit=0
`;
    const issues = lintText(tz);
    expect(issues.some((i) => i.level === 'error' && i.msg.includes('%'))).toBe(true);
  });

  it('grep в pwsh → error', () => {
    const tz = `# ЗАДАЧ: L
## ШАГ 1. X
RUN shell: pwsh
\`\`\`pwsh
echo hi | grep h
\`\`\`
EXPECT exit=0
`;
    const issues = lintText(tz);
    expect(issues.some((i) => i.level === 'error' && i.msg.includes('grep'))).toBe(true);
  });

  it('.. в WRITE → error', () => {
    const tz = `# ЗАДАЧ: L
## ШАГ 1. X
WRITE ../escape.txt
\`\`\`text
hi
\`\`\`
`;
    const issues = lintText(tz);
    expect(issues.some((i) => i.level === 'error' && i.msg.includes('относительным'))).toBe(true);
  });

  it('POSIX в bash → чисто', () => {
    const tz = `# ЗАДАЧ: L
## ШАГ 1. X
RUN shell: bash
\`\`\`bash
mkdir -p dist
echo hi | grep h
\`\`\`
EXPECT exit=0
`;
    const issues = lintText(tz);
    // Должно быть либо 0 ошибок, либо только warn о cmd-синтаксисе.
    expect(issues.filter((i) => i.level === 'error').length).toBe(0);
  });

  it('pwsh валидный с exit $LASTEXITCODE → чисто', () => {
    const tz = `# ЗАДАЧ: L
## ШАГ 1. X
RUN shell: pwsh
\`\`\`pwsh
npm init -y; exit $LASTEXITCODE
\`\`\`
EXPECT exit=0
`;
    const issues = lintText(tz);
    expect(issues.filter((i) => i.level === 'error').length).toBe(0);
  });
});
