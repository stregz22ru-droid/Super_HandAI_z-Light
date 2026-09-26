// test/base2-tzcontract.test.ts — B2: контракт распознавания ТЗ.
// Контейнер — 4 бэктика ````shai-tz: внутренние 3-бэктиковые фенсы ТЗ его не закрывают.
import { describe, it, expect } from 'vitest';
import {
  extractContract,
  normalizeTz,
  tzFingerprint,
  validateContractTz,
  COMPLETE_MARKER,
} from '../src/base2/autopilot/tzContract.js';

const VALID_TZ = `# ЗАДАЧ: тест
# META
workdir: new:ws-contract-test
mode: auto

## ШАГ 1. Проверка
RUN
\`\`\`bash
echo marker-ok
\`\`\`
EXPECT stdout contains: marker-ok
`;

const block = (t: string): string => '````shai-tz\n' + t + '\n````';

describe('B2: tzContract — распознавание ТЗ', () => {
  it('блок shai-tz (4 бэктика) извлекается ЦЕЛИКОМ вместе с внутренними фенсами', () => {
    const answer = 'Привет! Вот план:\n' + block(VALID_TZ) + '\nЧто-то ещё после блока.';
    const r = extractContract(answer);
    expect(r.blockFound).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.tzText).toContain('# ЗАДАЧ: тест');
    expect(r.tzText).toContain('```bash');
    expect(r.tzText).toContain('EXPECT stdout contains: marker-ok');
    expect(r.refusal).toBeUndefined();
  });

  it('вне блока — свободный текст: подстрока «задача завершена» НЕ является контрактом', () => {
    const answer = 'Задача завершена. Всё отлично!\nНикакого блока здесь нет.';
    const r = extractContract(answer);
    expect(r.blockFound).toBe(false);
    expect(r.complete).toBe(false);
    expect(r.tzText).toBeUndefined();
  });

  it('контрактное поле complete: true первой строкой блока — завершение без ТЗ', () => {
    const r = extractContract(block('complete: true'));
    expect(r.complete).toBe(true);
    expect(r.tzText).toBeUndefined();
    expect(r.refusal).toBeUndefined();
  });

  it('маркер вне блока — тоже контрактное завершение', () => {
    const r = extractContract('Всё сделано.\n' + COMPLETE_MARKER);
    expect(r.complete).toBe(true);
    expect(r.blockFound).toBe(false);
  });

  it('complete:true + текст ТЗ в одном блоке — отказ', () => {
    const r = extractContract(block('complete: true\n' + VALID_TZ));
    expect(r.refusal?.code).toBe('complete-without-tz-not-allowed');
  });

  it('два блока shai-tz — отказ multi-block', () => {
    const answer = block(VALID_TZ) + '\n' + block(VALID_TZ);
    const r = extractContract(answer);
    expect(r.refusal?.code).toBe('multi-block');
  });

  it('пустой блок — отказ', () => {
    const r = extractContract(block(''));
    expect(r.refusal?.code).toBe('empty-block');
  });

  it('complete:true и маркер одновременно — отказ complete-inside-and-outside', () => {
    const r = extractContract(block('complete: true') + '\n' + COMPLETE_MARKER);
    expect(r.refusal?.code).toBe('complete-inside-and-outside');
  });

  it('дедуп: одинаковый текст → одинаковый sha256, нормализация гасит CRLF и пробелы', () => {
    const a = tzFingerprint(VALID_TZ);
    const b = tzFingerprint(VALID_TZ.replace(/\n/g, '\r\n'));
    const c = tzFingerprint(VALID_TZ + '\n\n\n');
    const d = tzFingerprint(VALID_TZ.split('\n').map((l) => l + '  ').join('\n'));
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toBe(d);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalizeTz схлопывает пустые строки и хвостовые пробелы', () => {
    expect(normalizeTz('a  \n\n\n\nb')).toBe('a\n\nb');
  });

  it('validateContractTz пропускает валидное ТЗ штатного формата', () => {
    const r = validateContractTz(VALID_TZ);
    expect(r.ok).toBe(true);
  });

  it('validateContractTz отвергает ТЗ без шагов (штатный parser)', () => {
    const r = validateContractTz('# ЗАДАЧ: пусто\n# META\nworkdir: new:ws-empty-test\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('invalid-tz');
  });

  it('validateContractTz отвергает ТЗ без workdir', () => {
    const r = validateContractTz('# ЗАДАЧ: нет workdir\n# META\n\n## ШАГ 1. Проверка\nRUN\n```bash\necho x\n```\nEXPECT exit=0\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.message).toContain('workdir');
  });
});
