// config.ts — загрузка/создание конфигурации агента.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ShellSpec {
  cmd: string;
  args: string[];
}

export interface AgentConfig {
  port: number;
  workspaceRoot: string;
  shells: {
    pwsh: ShellSpec;
    bash: ShellSpec;
    pwshFallback: ShellSpec;
    linuxBash: ShellSpec;
  };
  stepTimeoutSec: number;
  maxOutputBytes: number;
  deny: string[];
}

export const DEFAULT_CONFIG: AgentConfig = {
  port: 8787,
  workspaceRoot: 'C:/Super_HandAI_z/workspace',
  shells: {
    pwsh: {
      cmd: 'C:/Super_HandAI_z/runtime/pwsh/pwsh.exe',
      args: ['-NoLogo', '-NoProfile', '-Command'],
    },
    bash: {
      cmd: 'C:/Super_HandAI_z/runtime/git/bin/bash.exe',
      args: ['-c'],
    },
    pwshFallback: { cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command'] },
    linuxBash: { cmd: '/bin/bash', args: ['-c'] },
  },
  stepTimeoutSec: 120,
  maxOutputBytes: 1048576,
  deny: ['autoPatternsFromGuard'],
};

// Резолв шелла под ОС / наличие файла.
export function resolveShell(
  cfg: AgentConfig,
  requested: 'pwsh' | 'bash' | undefined,
  fallbackNotes: string[] = [],
): { cmd: string; args: string[]; key: 'pwsh' | 'bash' | 'pwshFallback' | 'linuxBash' } {
  // На Linux всегда linuxBash.
  if (process.platform !== 'win32') {
    return { ...cfg.shells.linuxBash, key: 'linuxBash' };
  }
  if (!requested || requested === 'pwsh') {
    if (existsSync(cfg.shells.pwsh.cmd)) {
      return { ...cfg.shells.pwsh, key: 'pwsh' };
    }
    fallbackNotes.push(
      `shell pwsh недоступен по пути ${cfg.shells.pwsh.cmd} → fallback на powershell.exe`,
    );
    return { ...cfg.shells.pwshFallback, key: 'pwshFallback' };
  }
  // requested === 'bash'
  if (existsSync(cfg.shells.bash.cmd)) {
    return { ...cfg.shells.bash, key: 'bash' };
  }
  // Для bash нет fallback — это ошибка шага.
  throw new Error(`bash shell недоступен по пути ${cfg.shells.bash.cmd}`);
}

export function loadConfig(path: string): AgentConfig {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    return { ...DEFAULT_CONFIG };
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Partial<AgentConfig>;
  // Мягкий merge, чтобы новые поля дефолта не терялись при старом конфиге.
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    shells: { ...DEFAULT_CONFIG.shells, ...(parsed.shells ?? {}) },
  };
}

export function configPath(): string {
  // dist/config.js → __dirname = agent/dist  → root = __dirname/../..  (C:\Super_HandAI_z)
  // src/config.ts (tsx) → __dirname = agent/src → root = __dirname/../..
  // В обоих случаях 2 уровня вверх = корень проекта.
  const root = resolve(__dirname, '..', '..');
  return resolve(root, 'data', 'state', 'config.json');
}
