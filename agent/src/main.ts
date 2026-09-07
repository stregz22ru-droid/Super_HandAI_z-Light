// main.ts — точка входа агента.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { loadConfig, configPath } from './config.js';
import { startServer } from './server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/main.js  → root = ../.. (C:\Super_HandAI_z)
// src/main.ts  → root = ../.. (через tsx)
const isDist = __dirname.replace(/\\/g, '/').endsWith('/dist');
const root = isDist ? resolve(__dirname, '..', '..') : resolve(__dirname, '..', '..');

const cfgPath = configPath();
console.log(`[agent] config path: ${cfgPath}`);
const cfg = loadConfig(cfgPath);
console.log(`[agent] workspaceRoot: ${cfg.workspaceRoot}`);
console.log(`[agent] port: ${cfg.port}`);

// Создаём корневые каталоги если их нет
mkdirSync(cfg.workspaceRoot, { recursive: true });
const dataDir = resolve(root, 'data');
mkdirSync(resolve(dataDir, 'logs'), { recursive: true });
mkdirSync(resolve(dataDir, 'reports'), { recursive: true });
mkdirSync(resolve(dataDir, 'state'), { recursive: true });

const publicDir = resolve(__dirname, '..', 'public');
if (!existsSync(publicDir)) {
  console.warn(`[agent] public dir не найден: ${publicDir}`);
} else {
  console.log(`[agent] public dir: ${publicDir}`);
}

// Канал скилл-паков для юзерскрипта: Temp/pack (раздаётся агентом как /pack/*)
const packDir = resolve(root, 'GLM-Agent Bridge U1', 'Temp', 'pack');
if (!existsSync(packDir)) {
  console.warn(`[agent] pack dir не найден: ${packDir} — /pack будет отдавать 404`);
} else {
  console.log(`[agent] pack dir: ${packDir}`);
}

const reportsDir = resolve(dataDir, 'reports');
const logDir = resolve(dataDir, 'logs');

const tokenFile = resolve(dataDir, 'state', 'agent.token');
const { token, port, close } = startServer({ cfg, publicDir, reportsDir, logDir, packDir, tokenFile });

console.log(`UI: http://127.0.0.1:${port}/?t=${token}`);
// Токен в файл — для WS-клиентов диагностики и будущих автоматизаций
writeFileSync(resolve(dataDir, 'state', 'last-token.txt'), token);

console.log('Нажмите Ctrl+C для остановки.');

// Graceful shutdown
const shutdown = async () => {
  console.log('\n[agent] shutting down...');
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// keep alive
setInterval(() => {}, 1000);

export { token, port, close };