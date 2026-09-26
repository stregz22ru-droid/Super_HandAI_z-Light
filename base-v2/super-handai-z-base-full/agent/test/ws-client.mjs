// test/ws-client.mjs — WS-клиент e2e: запускает ТЗ и печатает поток терминала.
// Usage: node test/ws-client.mjs <port> <token> <tzFile>
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const [port, token, tzFile] = process.argv.slice(2);
if (!port || !token || !tzFile) {
  console.error('usage: node test/ws-client.mjs <port> <token> <tzFile>');
  process.exit(2);
}

const tz = readFileSync(tzFile, 'utf8');
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const timer = setTimeout(() => {
  console.error('WS_CLIENT: TIMEOUT');
  process.exit(3);
}, 60_000);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth', token }));
  ws.send(JSON.stringify({ type: 'task.start', tzText: tz }));
});

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.type === 'pty.data') {
    process.stdout.write(msg.data.replace(/\x1b\[[0-9;:<=?>]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ''));
  } else if (msg.type === 'task.done') {
    console.log(`\nTASK_DONE_STATUS: ${msg.status}`);
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  } else if (msg.type === 'error') {
    console.error(`WS_ERROR: ${msg.msg ?? ''}`);
  }
});

ws.on('error', (e) => {
  clearTimeout(timer);
  console.error('WS_CLIENT: ERROR ' + e.message);
  process.exit(3);
});
ws.on('close', (code) => {
  if (!code || code !== 1000) {
    // закрытие без task.done — считаем ошибкой, если ещё не завершены
    clearTimeout(timer);
    process.exit(4);
  }
});
