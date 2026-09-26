// main.ts — точка входа агента.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { loadConfig, configPath, type AgentConfig } from './config.js';
import { startServer } from './server.js';
// СИСТЕМА ФИЧ: реестр и контекст фич (новые файлы — ядро не меняется)
import { FeatureRegistry, setActiveRegistry, featureLog, type FeatureContext } from './features/registry.js';
import { journalTail } from './core/journal.js';

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

// === СИСТЕМА ФИЧ: сканирование и загрузка фич (новый блок — ядро не меняется) ===
const featuresDir = resolve(__dirname, '..', 'features');
const coreVersion = (JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
const registry = new FeatureRegistry(featuresDir, coreVersion);
const scanRes = await registry.scanFeatures();
console.log(`[features] scanned: ${scanRes.scanned}${scanRes.errors.length > 0 ? `, ошибок манифеста/импорта: ${scanRes.errors.length}` : ''}`);
for (const e of scanRes.errors) console.log(`[features] error: ${e}`);

const featureRoutes: { method: 'GET' | 'POST' | 'DELETE' | 'PUT'; path: string; handler: (req: any, res: any) => void }[] = [];
cfg.features = { ...(cfg.features ?? {}) };
const featureCtx: FeatureContext = {
  coreVersion,
  config: cfg as AgentConfig & { features: Record<string, boolean> },
  log: (level, msg) => featureLog(level, msg),
  registerRoute: (method, path, handler) => featureRoutes.push({ method, path, handler }),
  gitStatus: () =>
    new Promise<string>((resolveP) => {
      execFile('git', ['status', '--porcelain', '-b'], { cwd: cfg.workspaceRoot, timeout: 5000 }, (err, stdout) => {
        resolveP(err ? 'git недоступен: ' + err.message.split('\n')[0] : stdout.trim() || '(рабочее дерево чисто)');
      });
    }),
  journalTail: (n) => Promise.resolve(journalTail(n)),
  versions: () => ({
    core: coreVersion,
    node: process.version,
    platform: process.platform,
    features: Object.fromEntries(
      registry.loadedList().map((name) => [name, registry.list().find((r) => r.name === name)?.manifest?.version ?? '?']),
    ),
  }),
};
const loadReport = registry.loadEnabled(cfg.features, featureCtx);
console.log(`[features] loaded: ${loadReport.loaded.join(', ') || '—'}`);
for (const s of loadReport.skipped) console.log(`[features] skipped: ${s.name} — ${s.reason}`);
setActiveRegistry(registry);
// ==============================================================================

const tokenFile = resolve(dataDir, 'state', 'agent.token');
const { token, port, close } = startServer({
  cfg,
  publicDir,
  reportsDir,
  logDir,
  packDir,
  tokenFile,
  // СИСТЕМА ФИЧ: маршруты /features* под токен-гейтом в server.ts
  features: { registry, routes: featureRoutes, featuresDir, cfgPath: cfgPath, root },
});

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