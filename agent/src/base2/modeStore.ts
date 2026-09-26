// base2/modeStore.ts — B1 (П-2): режим PER-AGENT «Ручной ⇄ Автопилот».
// modeStore хранит КАРТУ {[agentId]: mode}, а не одно значение. API:
// getMode(agentId) / setMode(agentId, mode) — ЕДИНСТВЕННЫЙ писатель ключа
// config.mode (отдельный ключ от features — поправка Мастера), атомарная
// запись (tmp+rename), событие mode.changed через шину слотов (П-4).
// Персистентность: тумблер переживает рестарт агента.
import { configPath } from '../config.js';
import { writeJsonAtomic, appendJsonl, readRawJsonObject } from './atomic.js';
import { getSlotBus } from './slotBus.js';
import { BusEvents, DEFAULT_AGENT_ID, DEFAULT_MODE, type AgentMode, type ModeChangedEvent } from './types.js';

export interface ModeChangeMeta {
  by?: string;      // кто переключил: 'ui' | 'drain' | 'boot' | ...
  reason?: string;
}

export interface ModeJournalEntry {
  ts: string;
  agentId: string;
  from: AgentMode;
  to: AgentMode;
  by: string;
  reason?: string;
}

export class ModeStore {
  private modes = new Map<string, AgentMode>();
  private bus = getSlotBus();
  private journalFile: string;
  private cfgFile: string;

  constructor(opts?: { cfgFile?: string; journalFile?: string }) {
    this.cfgFile = opts?.cfgFile ?? configPath();
    this.journalFile = opts?.journalFile ?? '';
    if (!this.journalFile) {
      // data/state/ рядом с конфигом (cfgFile = <root>/data/state/config.json)
      const stateDir = this.cfgFile.replace(/[\\/]config\.json$/i, '');
      this.journalFile = stateDir + '/mode-journal.jsonl';
    }
    this.load();
  }

  private load(): void {
    const raw = readRawJsonObject(this.cfgFile);
    const m = raw.mode;
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      for (const [agentId, value] of Object.entries(m as Record<string, unknown>)) {
        if (value === 'autopilot' || value === 'manual') this.modes.set(agentId, value);
      }
    }
  }

  /** Режим агента; дефолт — manual (безопасный). */
  getMode(agentId: string = DEFAULT_AGENT_ID): AgentMode {
    return this.modes.get(agentId || DEFAULT_AGENT_ID) ?? DEFAULT_MODE;
  }

  /**
   * Переключение режима — ЕДИНСТВЕННАЯ точка записи config.mode.
   * Атомарно (tmp+rename) только по СВОЕМУ ключу 'mode': другие ключи конфига
   * (features, port, ...) сохраняются как есть (read-modify-write).
   */
  setMode(agentId: string, mode: AgentMode, meta?: ModeChangeMeta): { ok: boolean; error?: string; from: AgentMode; to: AgentMode } {
    const id = agentId || DEFAULT_AGENT_ID;
    const from = this.getMode(id);
    if (from === mode) return { ok: true, from, to: mode };
    this.modes.set(id, mode);
    try {
      const raw = readRawJsonObject(this.cfgFile);
      const m = raw.mode && typeof raw.mode === 'object' && !Array.isArray(raw.mode)
        ? { ...(raw.mode as Record<string, unknown>) }
        : {};
      m[id] = mode;
      raw.mode = m;
      writeJsonAtomic(this.cfgFile, raw);
    } catch (e) {
      // откат в памяти при невозможности записи — персистентность обязательна
      this.modes.set(id, from);
      return { ok: false, error: 'config.mode не записан: ' + (e instanceof Error ? e.message : String(e)), from, to: mode };
    }
    const entry: ModeJournalEntry = {
      ts: new Date().toISOString(),
      agentId: id,
      from,
      to: mode,
      by: meta?.by ?? 'unknown',
      ...(meta?.reason ? { reason: meta.reason } : {}),
    };
    appendJsonl(this.journalFile, entry);
    void this.bus.emit<ModeChangedEvent>(BusEvents.modeChanged, {
      agentId: id,
      from,
      to: mode,
      by: entry.by,
      ts: entry.ts,
    });
    return { ok: true, from, to: mode };
  }

  /** Карта всех сохранённых режимов (без дефолтных). */
  listModes(): Record<string, AgentMode> {
    return Object.fromEntries(this.modes);
  }

  /** Путь журнала переключений (для диагностики/маршрута). */
  get journalPath(): string {
    return this.journalFile;
  }
}
