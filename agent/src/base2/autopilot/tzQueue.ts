// base2/autopilot/tzQueue.ts — B2: очередь ТЗ моста — ОДИН слот на разговор, TTL.
// Политика: держим СТАРЫЙ (keep-oldest): новое ТЗ при занятом слоте = отказ
// с журналом; просроченное (TTL) слот освобождает — свежее кладётся.
import { tzFingerprint } from './tzContract.js';

export interface QueueItem {
  tzText: string;
  hash: string;
  chatId: string;
  agentId: string;
  enqueuedAt: number;
}

export type OfferResult =
  | { ok: true }
  | { ok: false; reason: 'occupied' | 'duplicate' | 'same-pending' };

export class TzQueue {
  private slot = new Map<string, QueueItem>();

  constructor(private ttlMs: number = 600_000) {}

  /** Положить ТЗ в слот разговора. */
  offer(conversationKey: string, item: Omit<QueueItem, 'hash' | 'enqueuedAt'>, now: number = Date.now()): OfferResult {
    this.expire(conversationKey, now);
    const hash = tzFingerprint(item.tzText);
    const existing = this.slot.get(conversationKey);
    if (existing) {
      if (existing.hash === hash) return { ok: false, reason: 'same-pending' };
      return { ok: false, reason: 'occupied' };
    }
    this.slot.set(conversationKey, { ...item, hash, enqueuedAt: now });
    return { ok: true };
  }

  /** Забрать ТЗ из слота (для запуска оборота). */
  take(conversationKey: string, now: number = Date.now()): QueueItem | null {
    this.expire(conversationKey, now);
    const item = this.slot.get(conversationKey) ?? null;
    if (item) this.slot.delete(conversationKey);
    return item;
  }

  peek(conversationKey: string, now: number = Date.now()): QueueItem | null {
    this.expire(conversationKey, now);
    return this.slot.get(conversationKey) ?? null;
  }

  private expire(conversationKey: string, now: number): void {
    const item = this.slot.get(conversationKey);
    if (item && now - item.enqueuedAt > this.ttlMs) {
      this.slot.delete(conversationKey);
    }
  }

  /** Есть ли в слоте ХОТЬ какое-то ТЗ (для дедупа «то же, что ждёт запуска»). */
  hasPending(conversationKey: string): boolean {
    return this.slot.has(conversationKey);
  }

  size(): number {
    return this.slot.size;
  }

  /** Снапшот непустых слотов (для насоса pumpIdle). */
  snapshot(): { key: string; item: QueueItem }[] {
    return [...this.slot.entries()].map(([key, item]) => ({ key, item }));
  }
}
