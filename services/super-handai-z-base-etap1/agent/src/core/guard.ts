// core/guard.ts — deny-паттерны опасных команд.
export interface DenyResult {
  denied: boolean;
  reason?: string;
}

// Список паттернов (применяем к "скрипту шага" целиком).
// Абсолютный — любое срабатывание → запрет.
const DENY_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\brm\s+-rf\b/, reason: 'rm -rf запрещён' },
  {
    re: /Remove-Item[\s\S]*?-Recurse[\s\S]*?-Force|Remove-Item[\s\S]*?-Force[\s\S]*?-Recurse/,
    reason: 'Remove-Item -Recurse -Force запрещён',
  },
  { re: /Format-Volume/, reason: 'Format-Volume запрещён' },
  { re: /Clear-Disk/, reason: 'Clear-Disk запрещён' },
  { re: /Stop-Computer/, reason: 'Stop-Computer запрещён' },
  { re: /\bshutdown\b/, reason: 'shutdown запрещён' },
  { re: /\bformat\s+/i, reason: 'format запрещён' },
  { re: /\bmkfs\b/, reason: 'mkfs запрещён' },
  { re: /\bdd\b[\s\S]*?of=\/dev\//, reason: 'dd of=/dev/ запрещён' },
  { re: /\btaskkill\b/, reason: 'taskkill запрещён' },
  { re: /Remove-ItemProperty/, reason: 'Remove-ItemProperty запрещён' },
  { re: /Set-ExecutionPolicy/, reason: 'Set-ExecutionPolicy запрещён' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, reason: 'fork bomb запрещена' },
];

// Проверка WRITE на абсолютный путь вне workspaceRoot.
export function checkWritePath(path: string, workspaceRoot: string): DenyResult {
  // Если путь абсолютный (Windows или POSIX), он должен быть внутри workspaceRoot.
  const isAbsWin = /^[A-Za-z]:[\\/]/.test(path);
  const isAbsPosix = path.startsWith('/') || path.startsWith('\\');
  if (!isAbsWin && !isAbsPosix) return { denied: false };
  // Нормализуем для сравнения
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const wsRoot = norm(workspaceRoot).replace(/\/$/, '');
  const target = norm(path);
  if (target.startsWith(wsRoot + '/') || target === wsRoot) {
    return { denied: false };
  }
  return { denied: true, reason: `WRITE путь вне workspace: ${path}` };
}

// Главная функция: проверка скрипта шага + (опц.) WRITE-путь.
export function checkScript(script: string, workspaceRoot?: string, writePath?: string): DenyResult {
  for (const p of DENY_PATTERNS) {
    if (p.re.test(script)) return { denied: true, reason: p.reason };
  }
  if (writePath && workspaceRoot) {
    return checkWritePath(writePath, workspaceRoot);
  }
  return { denied: false };
}
