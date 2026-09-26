// test/base2-memory.test.ts — ПАМЯТЬ: 4 слоя (ghostweave: append-only).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, chatIdOfConversationKey } from '../src/base2/memory/store.js';
import { resetSlotBus, getSlotBus } from '../src/base2/slotBus.js';
import { BusEvents, type TaskFinishedEvent, type TaskStartedEvent } from '../src/base2/types.js';

let dir: string;
let mem: MemoryStore;

describe('ПАМЯТЬ: слои 1–4', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shai-mem-'));
    resetSlotBus();
    mem = new MemoryStore(dir);
    mem.start();
  });
  afterEach(() => {
    mem.stop();
    resetSlotBus();
    rmSync(dir, { recursive: true, force: true });
  });

  const finEvent = (over: Partial<TaskFinishedEvent>): TaskFinishedEvent => ({
    taskId: 'task_1',
    conversationKey: 'conv:chat:web-123',
    origin: { type: 'autopilot', agentId: 'bot' },
    state: 'done',
    engineStatus: 'SUCCESS',
    reportMd: '# ОТЧЁТ: тест\nСТАТУС: SUCCESS — шагов выполнено 1/1. workdir: ws',
    workspace: join(dir, 'ws-proj'),
    ...over,
  });

  it('слой 1: после task.done в workspace появился CONTEXT.md (append)', async () => {
    const ws = join(dir, 'ws-proj');
    await getSlotBus().emit(BusEvents.taskFinished, finEvent({}));
    const ctx = join(ws, 'CONTEXT.md');
    expect(existsSync(ctx)).toBe(true);
    const first = readFileSync(ctx, 'utf8');
    expect(first).toContain('# Контекст проекта');
    expect(first).toContain('## Задача task_1');
    // вторая задача ДОБАВЛЯЕТ секцию (append-only, ничего не удаляется)
    await getSlotBus().emit(BusEvents.taskFinished, finEvent({ taskId: 'task_2' }));
    const second = readFileSync(ctx, 'utf8');
    expect(second).toContain('## Задача task_1');
    expect(second).toContain('## Задача task_2');
  });

  it('слой 2: projects.json — циклы, статусы, даты, резюме последнего отчёта', async () => {
    const ws = join(dir, 'ws-proj');
    await getSlotBus().emit(BusEvents.taskFinished, finEvent({}));
    await getSlotBus().emit(BusEvents.taskFinished, finEvent({ taskId: 'task_2', engineStatus: 'PARTIAL' }));
    const p = mem.readProject(ws);
    expect(p).not.toBeNull();
    expect(p!.cycles).toBe(2);
    expect(p!.statuses).toEqual({ SUCCESS: 1, PARTIAL: 1 });
    expect(p!.dates.first).toBeTruthy();
    expect(p!.dates.last).toBeTruthy();
    expect(p!.lastReportSummary).toContain('ОТЧЁТ');
  });

  it('слой 3: conversations/<chatId>.jsonl — append-only журнал чата-инициатора', async () => {
    await getSlotBus().emit(BusEvents.taskStarted, { taskId: 'task_1', conversationKey: 'conv:chat:web-123', origin: { type: 'autopilot', agentId: 'bot' } });
    await getSlotBus().emit(BusEvents.taskFinished, finEvent({}));
    const entries = mem.readConversation('web-123');
    expect(entries.length).toBe(2);
    expect(entries[0]).toMatchObject({ chatId: 'web-123', event: 'task.started', taskId: 'task_1' });
    expect(entries[1]).toMatchObject({ chatId: 'web-123', event: 'task.finished', engineStatus: 'SUCCESS' });
    expect(mem.fileOf('conversations', 'web-123')).toContain('conversations');
  });

  it('слой 3: эскалация попадает в журнал чата', async () => {
    await getSlotBus().emit(BusEvents.autopilotEscalation, { ts: new Date().toISOString(), chatId: 'web-777', agentId: 'bot', reason: 'same-fingerprint-3', file: 'x.md' });
    const entries = mem.readConversation('web-777');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: 'escalation', reason: 'same-fingerprint-3' });
  });

  it('слой 4: ответ помощника (autopilot-help) обновляет relationships обеих сторон', async () => {
    await getSlotBus().emit(
      BusEvents.taskFinished,
      finEvent({ origin: { type: 'autopilot-help', agentId: 'helper' }, conversationKey: 'conv:chat:web-123:help' }),
    );
    const helper = mem.readAgent('helper');
    expect(helper).not.toBeNull();
    expect(helper!.relationships['web-123']).toMatchObject({ 'встреч': 1, 'задач-совместно': 1 });
    expect(helper!.identity.name).toBe('helper');
    expect(helper!.lastSeen).toBeTruthy();
    const orig = mem.readAgent('web-123');
    expect(orig!.relationships['helper']).toBeTruthy();
  });

  it('human-задачи вне чата не создают разговорный журнал (без chat-ключа)', async () => {
    await getSlotBus().emit(BusEvents.taskFinished, finEvent({ conversationKey: 'conv:ui' }));
    expect(mem.stats().conversations).toHaveLength(0);
  });

  it('chatIdOfConversationKey: парсинг и хвост :help', () => {
    expect(chatIdOfConversationKey('conv:chat:web-123')).toBe('web-123');
    expect(chatIdOfConversationKey('conv:chat:web-123:help')).toBe('web-123:help');
    expect(chatIdOfConversationKey('conv:ui')).toBe('');
  });

  it('stats(): счётчики проектов/файлов', async () => {
    await getSlotBus().emit(BusEvents.taskFinished, finEvent({}));
    const s = mem.stats();
    expect(s.projects).toBe(1);
    expect(s.conversations).toContain('web-123.jsonl');
  });
});
