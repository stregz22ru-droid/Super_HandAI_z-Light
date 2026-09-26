#!/usr/bin/env node
// test/etap2-smoke.mjs — смоук Этапа 2 (B1/B2/B3 + Память) на канонической сборке.
// Запуск: node agent/test/etap2-smoke.mjs   (из корня репо; агент должен быть запущен)
// Все проверки — программные, через WS (токен data/state/agent.token).
// Смоук работает на ЖИВОЙ сборке: журналы/state этапа пишутся в data/ агента
// (это и есть цель проверки); единственное исключение — config.mode['smoke-bot'],
// ключ удаляется после проверки (если его не было).
import WebSocket from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const PORT = process.env.SHAI_AGENT_PORT ?? '8787';
let token = (process.env.SHAI_AGENT_TOKEN ?? '').trim();
if (!token) {
  const tf = resolve(root, 'data', 'state', 'agent.token');
  if (existsSync(tf)) token = readFileSync(tf, 'utf8').trim();
}
if (!token) {
  console.error('ETAP2-SMOKE: FAIL — токен агента не найден');
  process.exit(1);
}

const results = [];
function marker(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`[${ok ? 'OK' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
let seq = 0;
const pending = new Map();
const outbox = [];
const events = [];

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.reqId !== undefined && pending.has(msg.reqId)) {
    const p = pending.get(msg.reqId);
    pending.delete(msg.reqId);
    clearTimeout(p.timer);
    p.resolve(msg);
    return;
  }
  if (msg.type === 'autopilot.outbox') outbox.push(msg);
  else if (msg.type === 'mode.changed') events.push(msg);
});

function call(type, payload = {}, timeoutMs = 15000) {
  return new Promise((resolveP, rejectP) => {
    const reqId = 'r' + ++seq;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      rejectP(new Error('таймаут ' + type));
    }, timeoutMs);
    pending.set(reqId, { resolve: resolveP, timer });
    ws.send(JSON.stringify({ type, reqId, ...payload }));
  });
}

const waitFor = async (fn, timeoutMs = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Уникальность прогона: дедуп хэшей персистентен между прогонами (data/autopilot-state.json),
// поэтому ТЗ смоука несёт run-id — повторный смоук не ловит свой же прошлый хэш.
const RUN_ID = Date.now().toString(36);
const SMOKE_BOT = 'smoke-bot-' + RUN_ID;
const OK_TZ = `# ЗАДАЧ: смоук этапа 2 (${RUN_ID})
# META
workdir: new:ws-etap2-smoke
mode: auto

## ШАГ 1. Маркер
RUN
\`\`\`bash
echo etap2-ok-marker-${RUN_ID}
\`\`\`
EXPECT stdout contains: etap2-ok-marker-${RUN_ID}
`;
const block = (t) => '````shai-tz\n' + t + '\n````';

async function main() {
  await new Promise((resolveP, rejectP) => {
    ws.once('open', resolveP);
    ws.once('error', rejectP);
  });
  ws.send(JSON.stringify({ type: 'auth', token }));
  await sleep(200);

  // ET2-1: WS-расширения живы (ping/pong — маркер применённого патча)
  const pong = await call('ping');
  marker('ET2-1 WS-расширения отвечают (ping→pong)', pong.type === 'pong');

  // ET2-2: status.get — непустой state из единого TaskHub (после запуска задачи)
  const start = await call('task.start', { tzText: OK_TZ, origin: { type: 'human', agentId: 'operator' }, conversationId: 'smoke' });
  marker('ET2-2 task.start (WS) → taskId', start.ok === true && typeof start.taskId === 'string', start.taskId ?? start.error);
  const taskId = start.taskId;
  let statusOk = true;
  let lastState = '';
  for (let i = 0; i < 40; i++) {
    const s = await call('status.get', { taskId });
    const card = s.task ?? {};
    if (typeof card.state !== 'string' || card.state === '') {
      statusOk = false;
      break;
    }
    lastState = card.state;
    if (['done', 'failed', 'stopped', 'denied'].includes(card.state)) break;
    await sleep(250);
  }
  marker('ET2-2 status.get: state непустой на каждом полле', statusOk, `финал: ${lastState}`);

  // ET2-3: mode.get/mode.set + mode.changed + персистентность в config.mode
  const cfgPath = resolve(root, 'data', 'state', 'config.json');
  const cfgBefore = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const hadMode = cfgBefore.mode?.[SMOKE_BOT];
  const set = await call('mode.set', { agentId: SMOKE_BOT, mode: 'autopilot' });
  const changed = await waitFor(() => events.some((e) => e.agentId === SMOKE_BOT && e.to === 'autopilot'), 3000);
  const cfgAfter = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const persisted = cfgAfter.mode?.[SMOKE_BOT] === 'autopilot';
  marker('ET2-3 mode.set → mode.changed + config.mode записан', set.ok === true && changed && persisted, `было: ${hadMode ?? '(нет)'}, ok=${set.ok}, changed=${changed}, persisted=${persisted}`);
  const g = await call('mode.get', { agentId: SMOKE_BOT });
  marker('ET2-3 mode.get читает из стора', g.ok === true && g.mode === 'autopilot', g.mode);
  // (возврат режима — В КОНЦЕ смоука: ET2-5 использует того же агента в autopilot)

  // ET2-4: в manual мост НЕ подаёт задачи (отказ журналируется)
  const man = await call('glm.ingest', { answerText: block(OK_TZ), chatId: 'smoke-manual', agentId: 'smoke-man' });
  marker('ET2-4 manual: мост не подаёт задачи', man.outcome === 'manual-skip', man.outcome + (man.reason ? ' — ' + man.reason : ''));

  // ET2-5: в autopilot ТЗ из ответа становится задачей; outbox приносит отчёт оборота
  // (SHAI_BASE2_ROOT на агенте не установлен — журналы идут в data/ агента; это ок для смоука)
  const auto = await call('glm.ingest', { answerText: block(OK_TZ), chatId: 'smoke-auto', agentId: SMOKE_BOT });
  const started = auto.outcome === 'started' || auto.outcome === 'queued';
  marker('ET2-5 autopilot: ТЗ → задача программно', started, auto.outcome + (auto.reason ? ' — ' + auto.reason : ''));
  const gotReport = await waitFor(() => outbox.some((m) => m.kind === 'turn-report' && m.chatId === 'smoke-auto'), 15000);
  marker('ET2-5 outbox: отчёт оборота получен', gotReport, outbox.find((m) => m.kind === 'turn-report') ? 'turn-report в канале' : 'нет');
  // стоп петли (контрактное завершение), чтобы не висела
  await call('glm.ingest', { answerText: '<!--SHAI:AUTOPILOT:COMPLETE-->', chatId: 'smoke-auto', agentId: SMOKE_BOT });
  const st = await call('autopilot.state', {});
  const loop = (st.loops ?? []).find((l) => l.chatId === 'smoke-auto');
  marker('ET2-5 контрактное завершение → стоп в успехе', loop?.stopReason === 'complete', `state=${loop?.state}, reason=${loop?.stopReason}`);
  marker('ET2-6 redaction в исходящем: нет agent.token/внутренних URL', (() => {
    const rep = outbox.find((m) => m.kind === 'turn-report' && m.chatId === 'smoke-auto');
    if (!rep) return false;
    const t = rep.text ?? '';
    return !t.includes(token) && !t.includes('ws://127.0.0.1') && !t.includes('http://127.0.0.1');
  })());

  // ET2-7: FSM-состояние восстановимо из state-файла (файл существует и читается)
  const stateFile = resolve(root, 'data', 'autopilot-state.json');
  marker('ET2-7 data/autopilot-state.json существует (K5)', existsSync(stateFile), stateFile);

  // финальная уборка: возврат режима через API + подчистка ключа config.mode
  await call('mode.set', { agentId: SMOKE_BOT, mode: 'manual' });
  await new Promise((r) => setTimeout(r, 200));
  const cfgEnd = JSON.parse(readFileSync(cfgPath, 'utf8'));
  if (hadMode === undefined && cfgEnd.mode) {
    delete cfgEnd.mode[SMOKE_BOT];
    const { writeFileSync } = await import('node:fs');
    writeFileSync(cfgPath, JSON.stringify(cfgEnd, null, 2), 'utf8');
  }

  ws.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nETAP2-SMOKE: ${passed === results.length ? 'PASS' : 'FAIL'} (${passed}/${results.length})`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('ETAP2-SMOKE: FAIL —', e.message);
  try { ws.close(); } catch { /* no-op */ }
  process.exit(1);
});
