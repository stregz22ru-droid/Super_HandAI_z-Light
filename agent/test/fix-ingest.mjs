import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';

const f = process.argv[2];
const chatId = process.argv[3];
const agentId = process.argv[4] || 'operator';

let s = fs.readFileSync(f, 'utf8');
const idx = s.indexOf('# ЗАДАЧ');
if (idx < 0) { console.log('no-tz'); process.exit(1); }
const body = s.slice(idx);
console.log('label:tz длина: ' + body.length);

const AGENT_DIR = path.dirname(process.argv[1]);
const token = fs.readFileSync('C:/Super_HandAI_z/data/state/agent.token', 'utf8').trim();
const w = new WebSocket('ws://127.0.0.1:8787/ws');
let taskId = null;
w.on('open', () => {
  w.send(JSON.stringify({ type: 'auth', token }));
  w.send(JSON.stringify({ type: 'task.start', tzText: body }));
});
w.on('message', d => {
  const r = JSON.parse(d);
  if (r.type === 'task.accepted') {
    taskId = r.taskId;
    console.log('started:', taskId, 'steps:', r.steps.length);
  } else if (r.type === 'error') {
    console.log('refused:', r.msg);
    process.exit(1);
  }
});
w.on('error', e => console.log('WS-ERR:', e.message));
setTimeout(() => { if (!taskId) console.log('timeout'); process.exit(0); }, 10000);