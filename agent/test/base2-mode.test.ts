// test/base2-mode.test.ts — B1 (П-2): modeStore (карта per-agent, персистентность,
// mode.changed, атрибуция) и modeGate (idle-gate, drain, confirm-блок).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModeStore } from '../src/base2/modeStore.js';
import { ModeGate } from '../src/base2/modeGate.js';
import { resetSlotBus, getSlotBus } from '../src/base2/slotBus.js';
import { BusEvents, type ModeChangedEvent } from '../src/base2/types.js';
import { TaskHub } from '../src/core/taskHub.js';
import { TaskService } from '../src/base2/taskService.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config.js';

let dir: string;

function cfgFile(): string {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'config.json');
  if (!existsSync(f)) writeFileSync(f, JSON.stringify({ port: 8787 }, null, 2), 'utf8');
  return f;
}

function journalFile(): string {
  return join(dir, 'mode-journal.jsonl');
}

const CFG: AgentConfig = {
  ...DEFAULT_CONFIG,
  workspaceRoot: join(tmpdir(), 'shai-test-ws'),
  stepTimeoutSec: 30,
};

const ECHO_TZ = `# ЗАДАЧ: долгая
# META
workdir: new:ws-mode-test
mode: auto

## ШАГ 1. Пауза
RUN
\`\`\`bash
sleep 1
\`\`\`
EXPECT exit=0
`;

describe('B1: ModeStore', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shai-mode-'));
    resetSlotBus();
  });
  afterEach(() => {
    resetSlotBus();
    rmSync(dir, { recursive: true, force: true });
  });

  it('дефолт — manual для любого агента (безопасный)', () => {
    const s = new ModeStore({ cfgFile: cfgFile(), journalFile: journalFile() });
    expect(s.getMode('alice')).toBe('manual');
    expect(s.getMode()).toBe('manual');
  });

  it('setMode пишет config.mode (отдельный ключ от features) атомарно и только свой ключ', () => {
    const f = cfgFile();
    const s = new ModeStore({ cfgFile: f, journalFile: journalFile() });
    const r = s.setMode('alice', 'autopilot', { by: 'test' });
    expect(r.ok).toBe(true);
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    expect(raw.mode.alice).toBe('autopilot');
    expect(raw.port).toBe(8787); // чужие ключи целы
    expect(s.getMode('alice')).toBe('autopilot');
    expect(s.getMode('bob')).toBe('manual'); // карта: другой агент не затронут
  });

  it('рестарт сохраняет режим (тумблер переживает рестарт)', () => {
    const f = cfgFile();
    const s1 = new ModeStore({ cfgFile: f, journalFile: journalFile() });
    s1.setMode('alice', 'autopilot', { by: 'test' });
    const s2 = new ModeStore({ cfgFile: f, journalFile: journalFile() });
    expect(s2.getMode('alice')).toBe('autopilot');
  });

  it('mode.changed эмитится с атрибуцией; журнал содержит by', async () => {
    const s = new ModeStore({ cfgFile: cfgFile(), journalFile: journalFile() });
    const events: ModeChangedEvent[] = [];
    getSlotBus().on<ModeChangedEvent>(BusEvents.modeChanged, (e) => events.push(e));
    s.setMode('alice', 'autopilot', { by: 'ui-toggle', reason: 'тест' });
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agentId: 'alice', from: 'manual', to: 'autopilot', by: 'ui-toggle' });
    const journal = readFileSync(journalFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(journal[0]).toMatchObject({ agentId: 'alice', from: 'manual', to: 'autopilot', by: 'ui-toggle', reason: 'тест' });
    // каждая запись несёт origin-атрибуцию (by) — критерий B1
    expect(journal[0].by).toBeTruthy();
  });

  it('ошибка записи config.mode → ok:false и откат в памяти', () => {
    const badDir = join(dir, 'config.json'); // каталог вместо файла — rename упадёт
    mkdirSync(badDir, { recursive: true });
    const s = new ModeStore({ cfgFile: badDir, journalFile: journalFile() });
    const r = s.setMode('alice', 'autopilot', { by: 'test' });
    expect(r.ok).toBe(false);
    expect(s.getMode('alice')).toBe('manual'); // откат
  });
});

describe('B1: ModeGate (с живым TaskService)', () => {
  let ts: TaskService;
  let hub: TaskHub;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shai-gate-'));
    resetSlotBus();
    hub = new TaskHub();
    ts = new TaskService({ cfg: CFG, hub, reportsDir: join(dir, 'reports'), logDir: join(dir, 'logs'), broadcast: () => {} });
  });
  afterEach(() => {
    ts.stopTask();
    resetSlotBus();
    rmSync(dir, { recursive: true, force: true });
  });

  it('manual→autopilot при активной задаче агента — ОТКАЗ (idle-gate)', async () => {
    const store = new ModeStore({ cfgFile: cfgFile(), journalFile: journalFile() });
    const gate = new ModeGate(store, ts);
    const started = ts.startTz(ECHO_TZ, { type: 'human', agentId: 'alice' }, { conversationId: 'c1' });
    expect(started.ok).toBe(true);
    // дождаться старта исполнения
    await new Promise((r) => setTimeout(r, 250));
    const r = gate.request('alice', 'autopilot', 'test');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('не idle');
    await new Promise((r) => setTimeout(r, 1800));
    expect(ts.isIdle('alice')).toBe(true);
    const r2 = gate.request('alice', 'autopilot', 'test');
    expect(r2.ok).toBe(true);
    gate.dispose();
  }, 15000);

  it('autopilot→manual при активной задаче — drain: применится после её завершения', async () => {
    const store = new ModeStore({ cfgFile: cfgFile(), journalFile: journalFile() });
    store.setMode('alice', 'autopilot', { by: 'test' });
    const gate = new ModeGate(store, ts);
    ts.startTz(ECHO_TZ, { type: 'autopilot', agentId: 'alice' }, { conversationId: 'chat:c1' });
    await new Promise((r) => setTimeout(r, 250));
    const r = gate.request('alice', 'manual', 'test');
    expect(r.ok).toBe(true);
    expect('pendingDrain' in r && r.pendingDrain).toBe(true);
    expect(store.getMode('alice')).toBe('autopilot'); // ещё не применён
    expect(gate.isPendingDrain('alice')).toBe(true);
    // после завершения задачи drain применяется сам
    await new Promise((r) => setTimeout(r, 2000));
    expect(store.getMode('alice')).toBe('manual');
    expect(gate.isPendingDrain('alice')).toBe(false);
    gate.dispose();
  }, 15000);

  it('переключение при открытой confirm-панели агента — БЛОКИРУЕТСЯ', async () => {
    const store = new ModeStore({ cfgFile: cfgFile(), journalFile: journalFile() });
    const gate = new ModeGate(store, ts);
    const confirmTz = ECHO_TZ.replace('mode: auto', 'mode: confirm');
    ts.startTz(confirmTz, { type: 'human', agentId: 'alice' }, { conversationId: 'c1' });
    await new Promise((r) => setTimeout(r, 300));
    expect(ts.pendingConfirmFor('alice')).toBe(true);
    const r = gate.request('alice', 'autopilot', 'test');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('confirm');
    // снятие панели — переключение проходит
    expect(ts.answerConfirm(undefined, false)).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    const r2 = gate.request('alice', 'autopilot', 'test');
    expect(r2.ok).toBe(true);
    gate.dispose();
  }, 15000);
});
