// test/autopilot-loop.sim.test.ts — ИНТЕГРАЦИОННАЯ СИМУЛЯЦИЯ ПЕТЛИ (B2+B3)
// без реального GLM: живой сервер (startServer) + WS-клиент (AgentLink);
// «GLM» — скрипт-клиент, подающий ответы через WS glm.ingest.
// Критерии приёмки B2/B3 проверяются программно.
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.js';
import { loadConfig, DEFAULT_CONFIG, type AgentConfig } from '../src/config.js';
import { AgentLink } from '../src/base2/mcp/agentLink.js';
import { resetBase2ForTest } from '../src/base2/runtime.js';
import { resetSlotBus } from '../src/base2/slotBus.js';

let port = 18730;
let root: string;
let closeServer: (() => Promise<void>) | null = null;

interface OutboxMsg {
  type: string;
  kind?: string;
  chatId?: string;
  turn?: number;
  text?: string;
  toAgent?: string;
}

async function startAgent(opts?: { helper?: string; trusted?: string[] }): Promise<{ link: AgentLink; outbox: OutboxMsg[] }> {
  root = mkdtempSync(join(tmpdir(), 'shai-sim-'));
  process.env.SHAI_BASE2_ROOT = root;
  const dataDir = join(root, 'data');
  for (const d of ['state', 'logs', 'reports']) {
    mkdirSync(join(dataDir, d), { recursive: true });
  }
  const cfg: AgentConfig = {
    ...loadConfig(join(dataDir, 'state', 'config.json')),
    port,
    workspaceRoot: join(root, 'workspace'),
    autopilot: {
      ...DEFAULT_CONFIG.autopilot,
      maxTurnsNoSuccess: 5,
      helperAgentId: opts?.helper ?? '',
    },
    helpers: { trustedAgents: opts?.trusted ?? [] },
  };
  const srv = startServer({
    cfg,
    publicDir: join(root, 'public'), // отсутствует — не мешает
    reportsDir: join(dataDir, 'reports'),
    logDir: join(dataDir, 'logs'),
    tokenFile: join(dataDir, 'state', 'agent.token'),
  });
  closeServer = srv.close;
  await new Promise((r) => setTimeout(r, 150));

  const link = await AgentLink.connect({ port, token: srv.token });
  const outbox: OutboxMsg[] = [];
  link.onEvent('autopilot.outbox', (m) => outbox.push(m as OutboxMsg));
  return { link, outbox };
}

function tz(script: string, expectNeedle = 'done-ok'): string {
  return `# ЗАДАЧ: симуляция
# META
workdir: new:ws-sim
mode: auto

## ШАГ 1. Действие
RUN
\`\`\`bash
${script}
\`\`\`
EXPECT stdout contains: ${expectNeedle}
`;
}

const OK_TZ = tz('echo done-ok');
// медленный успех — чтобы застать агент ЗАНЯТЫМ в слот-сценарии
const SLOW_OK_TZ = tz('sleep 1 && echo done-ok');

// уникальный EXPECT на оборот → уникальный отпечаток (сценарий «N без SUCCESS»);
// «успех» в EXPECT недостижим (echo печатает fail-turn-N)
function failTz(n: number): string {
  return tz('echo fail-turn-' + n + ' && exit 3', 'never-appears-' + n);
}

// ОДИНАКОВЫЙ отказ (одинаковый EXPECT-диагност) при РАЗНЫХ текстах ТЗ —
// дедуп пропускает (тексты различны), отпечаток K4 совпадает (сценарий «3 подряд»)
function sameFailTz(n: number): string {
  return tz('echo fail-same && exit 3 # attempt-' + n);
}

async function waitFor(fn: () => boolean, timeoutMs = 8000, stepMs = 60): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

async function setMode(link: AgentLink, agentId: string, mode: 'manual' | 'autopilot'): Promise<void> {
  const r = await link.call('mode.set', { agentId, mode });
  expect(r.ok).toBe(true);
}

async function ingest(link: AgentLink, chatId: string, answer: string, agentId = 'bot'): Promise<Record<string, unknown>> {
  return link.call('glm.ingest', { answerText: answer, chatId, agentId }, 10000);
}

const block = (tzText: string): string => '````shai-tz\n' + tzText + '\n````';

// Конфиг репозитория НЕ должен пострадать от симуляции (ModeStore пишет config.mode
// в канонический config.json): снапшот до, восстановление после КАЖДОГО теста.
const REPO_CONFIG = join(__dirname, '..', '..', 'data', 'state', 'config.json');
const REPO_MODE_JOURNAL = join(__dirname, '..', '..', 'data', 'state', 'mode-journal.jsonl');
let repoConfigBackup: string | null = null;
let repoJournalBackup: string | null = null;

beforeAll(() => {
  if (existsSync(REPO_CONFIG)) repoConfigBackup = readFileSync(REPO_CONFIG, 'utf8');
  if (existsSync(REPO_MODE_JOURNAL)) repoJournalBackup = readFileSync(REPO_MODE_JOURNAL, 'utf8');
});

function restoreRepoFiles(): void {
  if (repoConfigBackup !== null) writeFileSync(REPO_CONFIG, repoConfigBackup, 'utf8');
  else if (existsSync(REPO_CONFIG)) rmSync(REPO_CONFIG, { force: true });
  if (repoJournalBackup !== null) writeFileSync(REPO_MODE_JOURNAL, repoJournalBackup, 'utf8');
  else if (existsSync(REPO_MODE_JOURNAL)) rmSync(REPO_MODE_JOURNAL, { force: true });
}

async function teardown(): Promise<void> {
  await closeServer?.();
  closeServer = null;
  resetBase2ForTest();
  resetSlotBus();
  delete process.env.SHAI_BASE2_ROOT;
  rmSync(root, { recursive: true, force: true });
  restoreRepoFiles();
}

describe('СИМУЛЯЦИЯ ПЕТЛИ (без реального GLM): ядро B2', () => {
  beforeEach(() => {
    resetBase2ForTest();
    resetSlotBus();
    port += 1;
  });
  afterEach(() => teardown());

  it('ТЗ из ответа GLM становится задачей программно; отчёт оборота приходит в outbox; петля ждёт ответ', async () => {
    const { link, outbox } = await startAgent();
    await setMode(link, 'bot1', 'autopilot');
    const r = await ingest(link, 'chat-sim-1', block(OK_TZ), 'bot1');
    expect(r.outcome).toBe('started');
    expect(typeof r.taskId).toBe('string');
    // отчёт оборота 1 в outbox (красный путь: task → reporter → outflow → outbox)
    expect(await waitFor(() => outbox.some((m) => m.kind === 'turn-report' && m.turn === 1))).toBe(true);
    const rep = outbox.find((m) => m.kind === 'turn-report' && m.turn === 1)!;
    expect(rep.chatId).toBe('chat-sim-1');
    expect(rep.text).toContain('ВЕРДИКТ: SUCCESS');
    // FSM: await-answer
    const st = await link.call('autopilot.state', {});
    const loops = st.loops as { chatId: string; state: string; turn: number }[];
    expect(loops.find((l) => l.chatId === 'chat-sim-1')).toMatchObject({ state: 'await-answer', turn: 1 });
    link.close();
  }, 20000);

  it('повтор той же ТЗ отбрасывается дедупом (sha256 нормализованного текста)', async () => {
    const { link } = await startAgent();
    await setMode(link, 'bot2', 'autopilot');
    const chatId = 'chat-dedup';
    expect((await ingest(link, chatId, block(OK_TZ), 'bot2')).outcome).toBe('started');
    // дождаться конца оборота 1
    await new Promise((r) => setTimeout(r, 1500));
    const r2 = await ingest(link, chatId, block(OK_TZ), 'bot2');
    expect(r2.outcome).toBe('duplicate');
    expect(r2.reason).toContain('дедуп');
    // нормализованный вариант той же ТЗ (хвостовые пробелы гасятся) — тоже дедуп
    const variant = OK_TZ.split('\n').map((l) => l + '  ').join('\n');
    const r3 = await ingest(link, chatId, block(variant), 'bot2');
    expect(r3.outcome).toBe('duplicate');
    link.close();
  }, 20000);

  it('ТЗ при занятом агенте — в слот очереди; после task.done петля запускает оборот 2 сама', async () => {
    const { link, outbox } = await startAgent();
    await setMode(link, 'bot3', 'autopilot');
    const chatId = 'chat-queue';
    expect((await ingest(link, chatId, block(SLOW_OK_TZ), 'bot3')).outcome).toBe('started');
    // агент занят (задача 1 в полёте ~1c): второе ТЗ уходит в слот
    const tz2 = tz('echo done-ok && echo second-turn');
    const r2 = await ingest(link, chatId, block(tz2), 'bot3');
    expect(r2.outcome).toBe('queued');
    // оборот 2 стартует ПОСЛЕ завершения первого (idle-gate → dispatch из слота)
    expect(await waitFor(() => outbox.some((m) => m.kind === 'turn-report' && m.turn === 2), 10000)).toBe(true);
    link.close();
  }, 25000);

  it('в manual мост задачи НЕ подаёт (отказ с журналом)', async () => {
    const { link, outbox } = await startAgent();
    const r = await ingest(link, 'chat-manual', block(OK_TZ), 'bot4'); // bot4 — manual (дефолт)
    expect(r.outcome).toBe('manual-skip');
    await new Promise((res) => setTimeout(res, 200));
    expect(outbox.some((m) => m.kind === 'turn-report')).toBe(false);
    // журнал отказов с причиной
    const jf = join(root, 'data', 'logs', 'bridge-in.jsonl');
    expect(existsSync(jf)).toBe(true);
    const last = JSON.parse(readFileSync(jf, 'utf8').trim().split('\n').pop()!);
    expect(last.outcome).toBe('manual-skip');
    expect(last.reason).toContain('manual');
    link.close();
  }, 20000);

  it('блок без ТЗ и невалидное ТЗ — отказ с журналом; подстрока «задача завершена» НЕ останавливает', async () => {
    const { link } = await startAgent();
    await setMode(link, 'bot5', 'autopilot');
    const chatId = 'chat-refusals';
    // блок есть, ТЗ невалидно (нет шагов)
    const r1 = await ingest(link, chatId, block('# ЗАДАЧ: пусто\n# META\nworkdir: new:ws-ref\n'), 'bot5');
    expect(r1.outcome).toBe('refused');
    // блока нет вообще; в тексте — «задача завершена» (свободный текст)
    const r2 = await ingest(link, chatId, 'Задача завершена, все довольны.', 'bot5');
    expect(r2.outcome).toBe('no-block');
    // петля НЕ остановлена «подстрокой» — её и не было; state чист
    const st = await link.call('autopilot.state', {});
    expect((st.loops as unknown[]).find((l) => (l as { chatId: string }).chatId === 'chat-refusals')).toBeUndefined();
    const jf = join(root, 'data', 'logs', 'bridge-in.jsonl');
    const outcomes = readFileSync(jf, 'utf8').trim().split('\n').map((l) => JSON.parse(l).outcome);
    expect(outcomes).toContain('refused');
    expect(outcomes).toContain('no-block');
    link.close();
  }, 20000);
});

describe('СИМУЛЯЦИЯ ПЕТЛИ: стоп-критерии и эскалация (B3)', () => {
  beforeEach(() => {
    resetBase2ForTest();
    resetSlotBus();
    port += 1;
  });
  afterEach(() => teardown());

  it('5 оборотов без SUCCESS → стоп no-success-N + эскалация (3 приёмника, помощник НЕ дёргается)', async () => {
    const { link, outbox } = await startAgent();
    await setMode(link, 'bot6', 'autopilot');
    const chatId = 'chat-n5';
    for (let n = 1; n <= 4; n++) {
      expect((await ingest(link, chatId, block(failTz(n)), 'bot6')).outcome).toBe('started');
      expect(await waitFor(() => outbox.some((m) => m.kind === 'turn-report' && m.turn === n), 10000)).toBe(true);
    }
    expect((await ingest(link, chatId, block(failTz(5)), 'bot6')).outcome).toBe('started');
    // 5-й оборот → стоп + эскалация
    expect(await waitFor(() => outbox.some((m) => m.kind === 'escalation'), 10000)).toBe(true);
    const esc = outbox.find((m) => m.kind === 'escalation')!;
    expect(esc.text).toContain('# ЭСКАЛАЦИЯ автопилота');
    expect(esc.text).toContain('no-success-N');
    expect(esc.text).not.toContain('ws://127.0.0.1'); // redaction: внутренние URL вырезаны
    // приёмник 3: файл
    const reports = readdirSync(join(root, 'data', 'reports'));
    expect(reports.some((f) => f.startsWith('escalation-') && f.endsWith('.md'))).toBe(true);
    // помощник НЕ вызван (порог помощника — только 3 одинаковых отпечатка)
    expect(outbox.some((m) => m.kind === 'help-request')).toBe(false);
    // FSM остановлена
    const st = await link.call('autopilot.state', {});
    expect((st.loops as { chatId: string; state: string; stopReason?: string }[]).find((l) => l.chatId === chatId))
      .toMatchObject({ state: 'stopped', stopReason: 'no-success-N' });
    link.close();
  }, 40000);

  it('3 одинаковых отпечатка подряд → стоп same-fingerprint-3 + эскалация-к-агенту (trusted)', async () => {
    const { link, outbox } = await startAgent({ helper: 'helper-bot', trusted: ['helper-bot'] });
    await setMode(link, 'bot7', 'autopilot');
    await setMode(link, 'helper-bot', 'autopilot');
    const chatId = 'chat-fp3';
    for (let n = 1; n <= 3; n++) {
      expect((await ingest(link, chatId, block(sameFailTz(n)), 'bot7')).outcome).toBe('started');
      expect(await waitFor(() => outbox.some((m) => m.kind === 'turn-report' && m.turn === n), 10000)).toBe(true);
    }
    expect(await waitFor(() => outbox.some((m) => m.kind === 'escalation'), 10000)).toBe(true);
    const esc = outbox.find((m) => m.kind === 'escalation')!;
    expect(esc.text).toContain('same-fingerprint-3');
    // приёмник 4: сводка уходит помощнику как ТЗ-запрос помощи
    expect(await waitFor(() => outbox.some((m) => m.kind === 'help-request'), 5000)).toBe(true);
    const help = outbox.find((m) => m.kind === 'help-request')!;
    expect(help.toAgent).toBe('helper-bot');
    expect(help.text).toContain('Что пробовали');
    link.close();
  }, 40000);

  it('помощник НЕ в trusted-списке (дефолт пусто) → только человек', async () => {
    const { link, outbox } = await startAgent({ helper: 'helper-bot', trusted: [] });
    await setMode(link, 'bot8', 'autopilot');
    const chatId = 'chat-untrusted';
    for (let n = 1; n <= 3; n++) {
      await ingest(link, chatId, block(sameFailTz(n)), 'bot8');
      expect(await waitFor(() => outbox.some((m) => m.kind === 'turn-report' && m.turn === n), 10000)).toBe(true);
    }
    expect(await waitFor(() => outbox.some((m) => m.kind === 'escalation'), 10000)).toBe(true);
    expect(outbox.some((m) => m.kind === 'help-request')).toBe(false);
    link.close();
  }, 40000);

  it('контрактное поле завершения → стоп В УСПЕХЕ (без эскалации)', async () => {
    const { link, outbox } = await startAgent();
    await setMode(link, 'bot9', 'autopilot');
    const chatId = 'chat-complete';
    expect((await ingest(link, chatId, block(OK_TZ), 'bot9')).outcome).toBe('started');
    expect(await waitFor(() => outbox.some((m) => m.kind === 'turn-report' && m.turn === 1), 10000)).toBe(true);
    // контрактное завершение маркером (не подстрока!)
    const r = await ingest(link, chatId, 'Всё готово.\n<!--SHAI:AUTOPILOT:COMPLETE-->', 'bot9');
    expect(r.outcome).toBe('complete');
    const st = await link.call('autopilot.state', {});
    expect((st.loops as { chatId: string; stopReason?: string }[]).find((l) => l.chatId === chatId)).toMatchObject({ stopReason: 'complete' });
    expect(outbox.some((m) => m.kind === 'escalation')).toBe(false);
    link.close();
  }, 20000);

  it('эскалация-к-агенту: ответ помощника (autopilot-help) доставляется в исходный чат подсказкой', async () => {
    const { link, outbox } = await startAgent({ helper: 'helper-bot', trusted: ['helper-bot'] });
    await setMode(link, 'helper-bot', 'autopilot');
    // помощник отвечает В СВОЙ чат блоком ТЗ (имитация: helper дал ТЗ помощи)
    const r = await ingest(link, 'chat-h1:help', block(OK_TZ), 'helper-bot');
    expect(r.outcome).toBe('started');
    expect(await waitFor(() => outbox.some((m) => m.kind === 'hint'), 10000)).toBe(true);
    const hint = outbox.find((m) => m.kind === 'hint')!;
    expect(hint.chatId).toBe('chat-h1'); // доставлено в ИСХОДНЫЙ чат
    expect(hint.text).toContain('Подсказка помощника (helper-bot)');
    link.close();
  }, 20000);
});
