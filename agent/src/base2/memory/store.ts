// base2/memory/store.ts — ПАМЯТЬ: проект → межчатовая → межагентская.
// Ghostweave-паттерн: append-only, доверенное дополнение — записи только
// ДОБАВЛЯЮТСЯ (инкремент/дозапись), ничего не удаляется и не переписывается.
//  Слой 1 (задача):        <workspace>/CONTEXT.md — после task.done.
//  Слой 2 (проект):        data/memory/projects.json — карта workdir →
//                          {циклы, статусы, даты, резюме последнего отчёта}.
//  Слой 3 (межчатовая):    data/memory/conversations/<chatId>.jsonl — append-only
//                          журнал чата-инициатора (z.ai-сессия, MCP-хост, WS-клиент).
//  Слой 4 (межагентская):  data/memory/agents/<agentId>.json — identity/
//                          relationships/lastSeen (заготовка Persona).
import { existsSync, readFileSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { resolve as resolvePath, dirname, basename } from 'node:path';
import { readJsonSafe, writeJsonAtomic, appendJsonl } from '../atomic.js';
import { BusEvents, type TaskFinishedEvent, type TaskStartedEvent } from '../types.js';
import { getSlotBus } from '../slotBus.js';

export interface ProjectEntry {
  workdir: string;
  cycles: number;
  statuses: Record<string, number>;
  dates: { first: string; last: string };
  lastReportSummary: string;
}

export interface AgentIdentity {
  identity: { name: string; role: string };
  relationships: Record<string, { 'встреч': number; 'задач-совместно': number; 'оценка': string | null }>;
  lastSeen: string;
}

export interface MemoryStats {
  projects: number;
  conversations: string[];
  agents: string[];
}

export class MemoryStore {
  private bus = getSlotBus();
  private projectsFile: string;
  private convDir: string;
  private agentsDir: string;
  private offs: (() => void)[] = [];

  constructor(private root: string) {
    this.projectsFile = resolvePath(root, 'data', 'memory', 'projects.json');
    this.convDir = resolvePath(root, 'data', 'memory', 'conversations');
    this.agentsDir = resolvePath(root, 'data', 'memory', 'agents');
  }

  start(): void {
    this.offs.push(this.bus.on<TaskStartedEvent>(BusEvents.taskStarted, (e) => this.onTaskStarted(e)));
    this.offs.push(this.bus.on<TaskFinishedEvent>(BusEvents.taskFinished, (e) => this.onTaskFinished(e)));
    this.offs.push(
      this.bus.on<{ ts: string; chatId: string; agentId: string; reason: string; file?: string }>(
        BusEvents.autopilotEscalation,
        (e) => this.onEscalation(e),
      ),
    );
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  // ---------- Слой 3: межчатовая память ----------

  private appendConversation(chatId: string, entry: Record<string, unknown>): void {
    if (!chatId) return;
    appendJsonl(resolvePath(this.convDir, sanitize(chatId) + '.jsonl'), entry);
  }

  private onTaskStarted(e: TaskStartedEvent): void {
    this.appendConversation(chatIdOfConversationKey(e.conversationKey), {
      ts: new Date().toISOString(),
      chatId: chatIdOfConversationKey(e.conversationKey),
      origin: e.origin,
      event: 'task.started',
      taskId: e.taskId,
    });
  }

  private onTaskFinished(e: TaskFinishedEvent): void {
    // Слой 1: CONTEXT.md в workspace задачи.
    this.writeTaskContext(e);
    // Слой 2: projects.json.
    this.updateProject(e);
    // Слой 3: журнал чата (только для задач с chat-контекстом: autopilot/mcp/human-чаты).
    const chatId = chatIdOfConversationKey(e.conversationKey);
    if (chatId) {
      this.appendConversation(chatId, {
        ts: new Date().toISOString(),
        chatId,
        origin: e.origin,
        event: 'task.finished',
        taskId: e.taskId,
        engineStatus: e.engineStatus,
        summary: (e.reportMd ?? '').split('\n').slice(0, 3).join(' ').slice(0, 200),
      });
    }
    // Слой 4: межагентские связи для help-потока (помощник ↔ проблемный агент).
    if (e.origin.type === 'autopilot-help') {
      const helper = e.origin.agentId;
      const orig = chatIdOfConversationKey(e.conversationKey.replace(/:help$/, '')) || 'unknown';
      this.touchAgent(helper, orig, 'помощь по эскалации');
      this.touchAgent(orig, helper, 'запросил помощь');
    }
  }

  private onEscalation(e: { ts: string; chatId: string; agentId: string; reason: string; file?: string }): void {
    this.appendConversation(e.chatId, {
      ts: e.ts,
      chatId: e.chatId,
      origin: { type: 'autopilot', agentId: e.agentId },
      event: 'escalation',
      reason: e.reason,
      file: e.file,
    });
    // связь агент-помощник фиксируется при доставке help-ответа (task.finished)
  }

  // ---------- Слой 1: CONTEXT.md (append-only) ----------

  private writeTaskContext(e: TaskFinishedEvent): void {
    if (!e.workspace) return;
    try {
      const file = resolvePath(e.workspace, 'CONTEXT.md');
      const lines: string[] = [];
      if (!existsSync(file)) {
        lines.push('# Контекст проекта (ghostweave: append-only)');
        lines.push('');
      }
      lines.push(`## Задача ${e.taskId} (${new Date().toISOString()})`);
      lines.push(`- origin: ${e.origin.type}/${e.origin.agentId}`);
      lines.push(`- статус: ${e.engineStatus ?? e.state}`);
      if (e.workspace) lines.push(`- workspace: ${basename(e.workspace)}`);
      const notes = (e.reportMd ?? '').split('\n').filter((l) => l.startsWith('- ') || l.startsWith('СТАТУС')).slice(0, 8);
      if (notes.length > 0) {
        lines.push('- ключевые строки отчёта:');
        for (const n of notes) lines.push('  ' + n.slice(0, 200));
      }
      lines.push('');
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, lines.join('\n') + '\n', 'utf8');
    } catch {
      // память не должна ронять исполнение
    }
  }

  // ---------- Слой 2: projects.json ----------

  private updateProject(e: TaskFinishedEvent): void {
    try {
      const workdir = e.workspace;
      if (!workdir) return;
      const data = readJsonSafe<Record<string, ProjectEntry>>(this.projectsFile, {});
      const prev = data[workdir];
      const now = new Date().toISOString();
      const entry: ProjectEntry = prev ?? {
        workdir,
        cycles: 0,
        statuses: {},
        dates: { first: now, last: now },
        lastReportSummary: '',
      };
      entry.cycles += 1;
      const st = e.engineStatus ?? e.state;
      entry.statuses[st] = (entry.statuses[st] ?? 0) + 1;
      entry.dates.last = now;
      entry.lastReportSummary = (e.reportMd ?? '').split('\n').slice(0, 2).join(' — ').slice(0, 300);
      data[workdir] = entry;
      writeJsonAtomic(this.projectsFile, data);
    } catch {
      // память не должна ронять исполнение
    }
  }

  // ---------- Слой 4: agents/<agentId>.json ----------

  touchAgent(agentId: string, otherAgentId: string, context: string): void {
    void context;
    try {
      const file = resolvePath(this.agentsDir, sanitize(agentId) + '.json');
      const data = readJsonSafe<AgentIdentity>(file, {
        identity: { name: agentId, role: '' },
        relationships: {},
        lastSeen: new Date().toISOString(),
      });
      const now = new Date().toISOString();
      data.lastSeen = now;
      if (data.identity && !data.identity.name) data.identity.name = agentId;
      const rel = data.relationships[otherAgentId] ?? { 'встреч': 0, 'задач-совместно': 0, 'оценка': null };
      rel['встреч'] += 1;
      rel['задач-совместно'] += 1;
      data.relationships[otherAgentId] = rel;
      writeJsonAtomic(file, data);
    } catch {
      // память не должна ронять исполнение
    }
  }

  /** Диагностика для маршрута /features/memory-layers. */
  stats(): MemoryStats {
    let conversations: string[] = [];
    let agents: string[] = [];
    try {
      if (existsSync(this.convDir)) conversations = readdirSync(this.convDir).filter((f) => f.endsWith('.jsonl'));
    } catch { /* no-op */ }
    try {
      if (existsSync(this.agentsDir)) agents = readdirSync(this.agentsDir).filter((f) => f.endsWith('.json'));
    } catch { /* no-op */ }
    const projects = readJsonSafe<Record<string, unknown>>(this.projectsFile, {});
    return { projects: Object.keys(projects).length, conversations, agents };
  }

  readProject(projectWorkdir: string): ProjectEntry | null {
    const data = readJsonSafe<Record<string, ProjectEntry>>(this.projectsFile, {});
    return data[projectWorkdir] ?? null;
  }

  readConversation(chatId: string): unknown[] {
    const file = resolvePath(this.convDir, sanitize(chatId) + '.jsonl');
    if (!existsSync(file)) return [];
    try {
      return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return { broken: true }; } });
    } catch {
      return [];
    }
  }

  readAgent(agentId: string): AgentIdentity | null {
    return readJsonSafe<AgentIdentity | null>(resolvePath(this.agentsDir, sanitize(agentId) + '.json'), null);
  }

  /** Путь к файлу (для тестов). */
  fileOf(layer: 'projects' | 'conversations' | 'agents', name?: string): string {
    if (layer === 'projects') return this.projectsFile;
    if (layer === 'conversations') return resolvePath(this.convDir, sanitize(name ?? '') + '.jsonl');
    return resolvePath(this.agentsDir, sanitize(name ?? '') + '.json');
  }
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'unknown';
}

/** chatId из conversationKey ('conv:chat:<id>' → '<id>', иначе ''). */
export function chatIdOfConversationKey(key: string): string {
  const m = /^conv:chat:(.+)$/.exec(key);
  return m ? m[1] : '';
}
