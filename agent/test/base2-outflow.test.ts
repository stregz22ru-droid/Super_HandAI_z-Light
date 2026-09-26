// test/base2-outflow.test.ts — B3 (П-3): redaction per-agent, квота, журналирование.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileFor, redact } from '../src/base2/autopilot/redaction.js';
import { Outflow } from '../src/base2/autopilot/outflow.js';
import type { TaskRecord } from '../src/core/taskHub.js';

let dir: string;

describe('B3: redaction', () => {
  it('вырезает токен агента (agent.token + per-agent секреты)', () => {
    const p = profileFor({ tokens: [], agents: { bot: { tokens: ['SECRETBOT12345'] } } }, 'bot', 'aabbccdd11223344', 12000);
    const r = redact('токен aabbccdd11223344 и SECRETBOT12345 внутри', p);
    expect(r.text).not.toContain('aabbccdd11223344');
    expect(r.text).not.toContain('SECRETBOT12345');
    expect(r.text).toContain('<TOKEN>');
    expect(r.hits.tokens).toBe(2);
  });

  it('короткие строки (<8 симв.) не считаются токенами (гигиена false-positive)', () => {
    const p = profileFor({}, 'bot', 'abc', 12000);
    const r = redact('abc abc abc', p);
    expect(r.text).toBe('abc abc abc');
  });

  it('вырезает абсолютные пути Windows и POSIX', () => {
    const p = profileFor({}, 'bot', 'aabbccdd11223344', 12000);
    const r = redact('файл C:\\Users\\admin\\secret.txt и /home/u/private/key.pem', p);
    expect(r.text).not.toContain('C:\\Users');
    expect(r.text).not.toContain('/home/u');
    expect((r.text.match(/<ПУТЬ>/g) ?? []).length).toBe(2);
    expect(r.hits.paths).toBe(2);
  });

  it('вырезает внутренние URL и адреса (ws://127.0.0.1:8787, localhost:8787)', () => {
    const p = profileFor({}, 'bot', 'aabbccdd11223344', 12000);
    const r = redact('канал ws://127.0.0.1:8787/ws и http://localhost:8787/ui, ещё 127.0.0.1:8790', p);
    expect(r.text).not.toContain('127.0.0.1:8787');
    expect(r.text).not.toContain('localhost:8787');
    expect(r.hits.urls).toBeGreaterThanOrEqual(3);
    expect(r.text).toContain('<ВНУТРЕННИЙ-URL>');
  });

  it('квота: текст сверх лимита обрезается с пометкой', () => {
    const p = profileFor({}, 'bot', 'aabbccdd11223344', 100);
    const r = redact('x'.repeat(500), p);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(300);
    expect(r.text).toContain('ОБРЕЗАНО');
  });
});

describe('B3: Outflow', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shai-outflow-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeOutflow(): Outflow {
    return new Outflow({
      root: dir,
      agentToken: 'aabbccdd11223344',
      redaction: { tokens: [], agents: { bot: { quotaChars: 200 } } },
      defaultQuota: 12000,
    });
  }

  it('turn-report содержит вердикт и проходит redaction', () => {
    const of = makeOutflow();
    const rec = {
      taskId: 'task_1',
      source: 'autopilot',
      state: 'done',
      createdAt: '',
      engineStatus: 'PARTIAL',
      reportMd: 'ОТЧЁТ: токен aabbccdd11223344 утёк бы; путь C:\\Users\\x\\y.txt тоже',
    } as TaskRecord;
    const msg = of.buildTurnReport({ record: rec, chatId: 'chat-1', agentId: 'bot', turn: 2, reportFile: 'task_1_x.md' });
    expect(msg.text).toContain('ВЕРДИКТ: PARTIAL');
    expect(msg.text).toContain('оборота 2');
    expect(msg.text).not.toContain('aabbccdd11223344');
    expect(msg.text).not.toContain('C:\\Users');
    expect(msg.redactionHits.tokens).toBe(1);
    expect(msg.redactionHits.paths).toBe(1);
  });

  it('обрезка сверх per-agent квоты журналируется (outflow.jsonl)', () => {
    const of = makeOutflow();
    const rec = {
      taskId: 'task_2',
      source: 'autopilot',
      state: 'done',
      createdAt: '',
      engineStatus: 'SUCCESS',
      reportMd: 'y'.repeat(1000),
    } as TaskRecord;
    const msg = of.buildTurnReport({ record: rec, chatId: 'chat-1', agentId: 'bot', turn: 1 });
    expect(msg.truncated).toBe(true);
    const jf = join(dir, 'data', 'logs', 'outflow.jsonl');
    expect(existsSync(jf)).toBe(true);
    const entry = JSON.parse(readFileSync(jf, 'utf8').trim().split('\n').pop()!);
    expect(entry).toMatchObject({ kind: 'turn-report', chatId: 'chat-1', agentId: 'bot', truncated: true });
  });

  it('безопасный агент НЕ режется по чужим секретам (карта per-agent)', () => {
    const of = new Outflow({
      root: dir,
      agentToken: 'aabbccdd11223344',
      redaction: { tokens: [], agents: { bot: { tokens: ['BOTSECRET99999'] } } },
      defaultQuota: 12000,
    });
    const msg = of.buildCustom({ kind: 'hint', chatId: 'c', agentId: 'human-agent', body: 'BOTSECRET99999 остаётся только для bot-фильтра? нет — глобальный агент-токен режется везде' });
    // per-agent секрет bot НЕ применяется к другому агенту
    expect(msg.text).toContain('BOTSECRET99999');
    expect(msg.text).not.toContain('aabbccdd11223344');
  });
});
