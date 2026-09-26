// test/base2-tzqueue.test.ts — B2: очередь один слот с TTL.
import { describe, it, expect } from 'vitest';
import { TzQueue } from '../src/base2/autopilot/tzQueue.js';

describe('B2: TzQueue — один слот с TTL', () => {
  it('первое ТЗ кладётся, второе при занятом слоте — отказ occupied (keep-oldest)', () => {
    const q = new TzQueue(600_000);
    expect(q.offer('k', { tzText: 'A', chatId: 'c1', agentId: 'op' }, 1000).ok).toBe(true);
    const second = q.offer('k', { tzText: 'B', chatId: 'c1', agentId: 'op' }, 1100);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('occupied');
    // слот хранит СТАРОЕ
    expect(q.take('k', 1200)?.tzText).toBe('A');
  });

  it('то же ТЗ в слоте — отказ same-pending', () => {
    const q = new TzQueue(600_000);
    q.offer('k', { tzText: 'A', chatId: 'c1', agentId: 'op' }, 1000);
    const again = q.offer('k', { tzText: 'A', chatId: 'c1', agentId: 'op' }, 1100);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('same-pending');
  });

  it('TTL истёк — слот свободен, свежее кладётся', () => {
    const q = new TzQueue(5000);
    expect(q.offer('k', { tzText: 'A', chatId: 'c1', agentId: 'op' }, 1000).ok).toBe(true);
    // до истечения — занято
    expect(q.offer('k', { tzText: 'B', chatId: 'c1', agentId: 'op' }, 4000).ok).toBe(false);
    // после истечения — свободно
    expect(q.offer('k', { tzText: 'B', chatId: 'c1', agentId: 'op' }, 7000).ok).toBe(true);
    expect(q.take('k', 7100)?.tzText).toBe('B');
  });

  it('take пустого/просроченного слота — null', () => {
    const q = new TzQueue(1000);
    q.offer('k', { tzText: 'A', chatId: 'c1', agentId: 'op' }, 1000);
    expect(q.take('k', 5000)).toBeNull();
    expect(q.take('other')).toBeNull();
  });

  it('разные разговоры — независимые слоты (П-1)', () => {
    const q = new TzQueue(600_000);
    expect(q.offer('k1', { tzText: 'A', chatId: 'c1', agentId: 'op' }, 1000).ok).toBe(true);
    expect(q.offer('k2', { tzText: 'B', chatId: 'c2', agentId: 'op' }, 1000).ok).toBe(true);
    expect(q.take('k1', 1100)?.tzText).toBe('A');
    expect(q.take('k2', 1100)?.tzText).toBe('B');
  });
});
