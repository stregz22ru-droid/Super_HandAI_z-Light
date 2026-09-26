// base2/check/cache.ts — B4: кэш решений CHECK.
// Ключ = sha256(команда + рабочая папка + режим); TTL 60 c (config.check.cacheTtlSec);
// ПОЛНАЯ инвалидация при смене режима (mode.changed) — решение, выданное в
// автопилоте, не переиспользуется в ручном режиме и наоборот.
import { createHash } from 'node:crypto';

export interface CacheEntry {
  verdict: 'ALLOW' | 'DENY' | 'CONFIRM' | 'MODIFY';
  source: 'agp' | 'fail-closed';
  latencyMs: number;
  reason?: string;
  cachedAt: number;
  until: number;
}

export class CheckCache {
  private map = new Map<string, CacheEntry>();

  constructor(private ttlMs: number = 60_000) {}

  static keyOf(script: string, workdir: string, mode: string): string {
    return createHash('sha256').update(script + '\u0000' + workdir + '\u0000' + mode, 'utf8').digest('hex');
  }

  get(key: string, now: number = Date.now()): CacheEntry | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (now >= e.until) {
      this.map.delete(key);
      return null;
    }
    return { ...e };
  }

  set(key: string, entry: Omit<CacheEntry, 'cachedAt' | 'until'>, now: number = Date.now()): CacheEntry {
    const full: CacheEntry = { ...entry, cachedAt: now, until: now + this.ttlMs };
    this.map.set(key, full);
    return { ...full };
  }

  /** Инвалидация ВСЕГО кэша (смена режима). */
  invalidateAll(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
