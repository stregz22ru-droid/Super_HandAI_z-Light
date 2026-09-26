// test/base2-loop.test.ts — B3: ledger (K4/K9) и stopPolicy.
import { describe, it, expect } from 'vitest';
import { Ledger, fingerprintOf } from '../src/base2/autopilot/ledger.js';
import { evaluateStopPolicy } from '../src/base2/autopilot/stopPolicy.js';
import type { TaskRecord } from '../src/core/taskHub.js';

function rec(partial: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: 'task_x',
    source: 'autopilot',
    state: 'done',
    createdAt: new Date().toISOString(),
    ...partial,
  } as TaskRecord;
}

describe('B3: fingerprintOf (K4)', () => {
  it('норм. четвёрка: [шаг, класс, exit, сообщение]; EXPECT-класс', () => {
    const fp = fingerprintOf(rec({
      steps: [{ i: 3, title: 's', status: 'fail', exitCode: 1, failReason: 'EXPECT не совпал (exit=1); expects: stdout contains: marker' }],
    }));
    expect(fp).toEqual({ step: 3, cls: 'EXPECT', exitCode: 1, message: expect.stringContaining('expect не совпал') });
  });

  it('GUARD-класс у denied-шага; TIMEOUT по слову «таймаут»; EXIT по умолчанию', () => {
    const g = fingerprintOf(rec({ steps: [{ i: 2, title: 's', status: 'denied', exitCode: undefined, failReason: undefined }] }));
    expect(g?.cls).toBe('GUARD');
    const t = fingerprintOf(rec({ steps: [{ i: 1, title: 's', status: 'fail', exitCode: null, failReason: 'таймаут 120s' }] }));
    expect(t?.cls).toBe('TIMEOUT');
    const e = fingerprintOf(rec({ steps: [{ i: 4, title: 's', status: 'fail', exitCode: 2, failReason: undefined }] }));
    expect(e?.cls).toBe('EXIT');
  });

  it('нормализация сообщения гасит абсолютные пути и регистр (стабильность отпечатка)', () => {
    const a = fingerprintOf(rec({ steps: [{ i: 1, title: 's', status: 'fail', exitCode: 1, failReason: 'EXPECT не совпал: C:\\Users\\admin\\x /home/u/y' }] }));
    const b = fingerprintOf(rec({ steps: [{ i: 1, title: 's', status: 'fail', exitCode: 1, failReason: 'expect не совпал: D:\\OTHER\\path /var/log/z' }] }));
    expect(a?.message).not.toContain('C:');
    expect(a?.message).not.toContain('/home/');
    // разные пути → одинаковое нормализованное сообщение
    expect(a?.message).toBe(b?.message);
  });

  it('успешная задача без шагов-отказов — отпечатка нет', () => {
    expect(fingerprintOf(rec({ steps: [{ i: 1, title: 's', status: 'ok' }] }))).toBeNull();
  });
});

describe('B3: Ledger + stopPolicy', () => {
  const FAIL_FP = { step: 1, cls: 'EXPECT' as const, exitCode: 1, message: 'expect не совпал' };

  function addTurn(l: Ledger, engineStatus: 'SUCCESS' | 'PARTIAL' | 'STOPPED' | 'DENIED', fp?: typeof FAIL_FP | null) {
    return l.addTurn({ taskId: 't' + l.length, ts: new Date().toISOString(), engineStatus, ...(fp ? { fingerprint: fp } : {}) });
  }

  it('K9: отпечатки разных инициаторов считаются РАЗНЫМИ Ledger-ами (изоляция)', () => {
    const l1 = new Ledger();
    const l2 = new Ledger();
    addTurn(l1, 'PARTIAL', FAIL_FP);
    addTurn(l1, 'PARTIAL', FAIL_FP);
    addTurn(l2, 'PARTIAL', { ...FAIL_FP, message: 'другая причина' });
    expect(l1.consecutiveSameFingerprints()).toBe(2);
    expect(l2.consecutiveSameFingerprints()).toBe(1);
  });

  it('3 одинаковых отпечатка подряд → stop same-fingerprint-3', () => {
    const l = new Ledger();
    addTurn(l, 'PARTIAL', FAIL_FP);
    addTurn(l, 'PARTIAL', FAIL_FP);
    let st = evaluateStopPolicy({ ledger: l, complete: false, maxTurnsNoSuccess: 5, fingerprintThreshold: 3 });
    expect(st.stop).toBe(false);
    addTurn(l, 'PARTIAL', FAIL_FP);
    st = evaluateStopPolicy({ ledger: l, complete: false, maxTurnsNoSuccess: 5, fingerprintThreshold: 3 });
    expect(st.stop).toBe(true);
    expect(st.reason).toBe('same-fingerprint-3');
  });

  it('успех между отказами СБРАСЫВАЕТ серию подряд', () => {
    const l = new Ledger();
    addTurn(l, 'PARTIAL', FAIL_FP);
    addTurn(l, 'PARTIAL', FAIL_FP);
    addTurn(l, 'SUCCESS'); // сброс серии
    addTurn(l, 'PARTIAL', FAIL_FP);
    const st = evaluateStopPolicy({ ledger: l, complete: false, maxTurnsNoSuccess: 5, fingerprintThreshold: 3 });
    expect(st.stop).toBe(false);
  });

  it('N оборотов без SUCCESS (рекомендация 5) → stop no-success-N', () => {
    const l = new Ledger();
    for (let i = 0; i < 4; i++) addTurn(l, 'PARTIAL', { ...FAIL_FP, message: 'varies ' + i, step: i + 1 });
    let st = evaluateStopPolicy({ ledger: l, complete: false, maxTurnsNoSuccess: 5, fingerprintThreshold: 3 });
    expect(st.stop).toBe(false);
    addTurn(l, 'STOPPED');
    st = evaluateStopPolicy({ ledger: l, complete: false, maxTurnsNoSuccess: 5, fingerprintThreshold: 3 });
    expect(st.stop).toBe(true);
    expect(st.reason).toBe('no-success-N');
  });

  it('успех сбрасывает счётчик N без SUCCESS', () => {
    const l = new Ledger();
    for (let i = 0; i < 4; i++) addTurn(l, 'PARTIAL', { ...FAIL_FP, message: 'v' + i, step: i + 1 });
    addTurn(l, 'SUCCESS');
    addTurn(l, 'PARTIAL', { ...FAIL_FP, message: 'v', step: 9 });
    const st = evaluateStopPolicy({ ledger: l, complete: false, maxTurnsNoSuccess: 5, fingerprintThreshold: 3 });
    expect(st.stop).toBe(false);
  });

  it('контрактное завершение — стоп В УСПЕХЕ (приоритет)', () => {
    const l = new Ledger();
    addTurn(l, 'SUCCESS');
    const st = evaluateStopPolicy({ ledger: l, complete: true, maxTurnsNoSuccess: 5, fingerprintThreshold: 3 });
    expect(st.stop).toBe(true);
    expect(st.reason).toBe('complete');
  });

  it('lastK возвращает K последних оборотов для сводки K7', () => {
    const l = new Ledger();
    for (let i = 0; i < 6; i++) addTurn(l, i === 5 ? 'SUCCESS' : 'PARTIAL', { ...FAIL_FP, message: 'm' + i, step: 1 });
    const k = l.lastK(3);
    expect(k).toHaveLength(3);
    expect(k.map((t) => t.n)).toEqual([4, 5, 6]);
  });
});
