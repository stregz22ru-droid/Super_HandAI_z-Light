#!/usr/bin/env node
// glm-ingest.mjs — подача ответа GLM в мост автопилота (B2) одним движением.
//
// Usage:
//   node glm-ingest.mjs <файл-с-ответом-GLM> [chatId] [agentId]
//
// Примеры:
//   node glm-ingest.mjs answer.md chat-1
//   node glm-ingest.mjs answer.md chat-1 operator
//
// Что делает: читает файл (ПОЛНЫЙ ответ GLM — контейнер ```shai-tz с 4
// бэктиками должен быть внутри), шлёт WS glm.ingest в агент, печатает вердикт:
//   started      — оборот запущен (ТЗ взято в работу)
//   queued       — агент занят, ТЗ ждёт в слоте (сам стартует при idle)
//   complete     — GLM объявил контрактное завершение (петля закрыта)
//   duplicate    — такая ТЗ уже была (дедуп sha256)
//   no-block     — контейнера shai-tz в ответе нет
//   refused      — отказ (причина в ответе и в data/logs/bridge-in.jsonl)
//   manual-skip  — режим агента manual: переключи режим в autopilot
//   bad-input / start-failed — смотри reason
//
// Токен берётся автоматически: data/state/agent.token (рядом или выше),
// либо переменная окружения SHAI_TOKEN. Порт: 8787 или SHAI_PORT.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));

function loadWs() {
  const require2 = createRequire(import.meta.url);
  const candidates = [
    join(here, 'agent', 'node_modules', 'ws'),
    join(here, '..', 'agent', 'node_modules', 'ws'),
    join(process.cwd(), 'agent', 'node_modules', 'ws'),
    join(process.cwd(), 'node_modules', 'ws'),
  ];
  for (const c of candidates) {
    try { return require2(c); } catch { /* пробуем следующее */ }
  }
  return require2('ws');
}
const WebSocket = loadWs();
const [answerFile, chatIdArg, agentIdArg] = process.argv.slice(2);

if (!answerFile) {
  console.error('usage: node glm-ingest.mjs <answerFile> [chatId] [agentId]');
  process.exit(2);
}
const answerText = readFileSync(answerFile, 'utf8');
const chatId = chatIdArg || 'chat-1';
const agentId = agentIdArg || 'operator';
const port = process.env.SHAI_PORT || '8787';

function findToken() {
  if (process.env.SHAI_TOKEN) return process.env.SHAI_TOKEN.trim();
  const candidates = [
    join(here, 'data', 'state', 'agent.token'),
    join(here, '..', 'data', 'state', 'agent.token'),
    join(process.cwd(), 'data', 'state', 'agent.token'),
    join(process.cwd(), '..', 'data', 'state', 'agent.token'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  }
  console.error('НЕТ ТОКЕНА: не найден data/state/agent.token (задай SHAI_TOKEN или запусти из папки агента)');
  process.exit(2);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const timer = setTimeout(() => { console.error('GLM-INGEST: TIMEOUT'); process.exit(3); }, 30_000);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth', token: findToken() }));
  ws.send(JSON.stringify({ type: 'glm.ingest', answerText, chatId, agentId, reqId: 'cli-' + Date.now() }));
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.type === 'ingest.result') {
    const mark = msg.ok ? '✓' : '✗';
    console.log(`${mark} GLM-INGEST: ${msg.outcome ?? '?'}${msg.taskId ? '  taskId=' + msg.taskId : ''}${msg.reason ? '  (' + msg.reason + ')' : ''}`);
    clearTimeout(timer);
    ws.close();
    process.exit(msg.ok ? 0 : 1);
  } else if (msg.type === 'error') {
    console.error('WS_ERROR: ' + (msg.msg ?? ''));
    clearTimeout(timer);
    process.exit(3);
  }
});

ws.on('error', (e) => { console.error('GLM-INGEST: ERROR ' + e.message); process.exit(3); });
ws.on('close', (code) => { clearTimeout(timer); if (code !== 1000) process.exit(4); });
