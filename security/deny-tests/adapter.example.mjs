// Пример адаптера — контракт между корпусом deny-tests и guard-ом агента.
//
// Замените тело на вызов РЕАЛЬНОЙ проверки вашего агента:
//   node run.mjs --adapter ./adapter.example.mjs
//
// Контракт:
//   denyCheck({ command, shell, meta })
//     command : string            — команда из RUN-шага ТЗ
//     shell   : 'pwsh'|'bash'|'cmd'
//     meta    : { cat, sev }      — категория/серьёзность кейса (для логов, НЕ для решения!)
//   → { verdict: 'blocked' | 'flagged' | 'allowed', reason?: string }
//
// ВАЖНО: meta существует только для отчётности. Если guard подглядывает в meta
// и решает по ней — тест становится бесполезным (это читерство, runner не
// запрещает, но совесть — запрещает).

export function denyCheck({ command, shell }) {
  // ── ЗАГЛУШКА: пропускает всё ─────────────────────────────────────
  // Запустите как есть — runner покажет FAILED по всем критичным кейсам.
  // Это и есть демонстрация: no-op guard ловится тестами мгновенно.
  return { verdict: 'allowed', reason: 'stub adapter — пропускает всё' };

  // ── РЕАЛЬНАЯ РЕАЛИЗАЦИЯ (скелет для вдохновения) ─────────────────
  // const DENY = [
  //   /\b(remove-item|del|rd|erase|ri)\b/i,                  // алиасы удаления
  //   /\[system\.io\.(file|directory)\]::delete/i,           // .NET-обход
  //   /\b(cmd|bash|sh|wscript|cscript|msiexec|rundll32)\b/i, // cross-shell
  //   /-enc(odedcommand)?\b|\binvoke-expression\b|\biex\b/i, // обфускация
  //   /\b(net\s+user|schtasks|reg\s+add|sc\s+create|new-service)\b/i,
  //   /\b(invoke-webrequest|iwr|invoke-restmethod|irm)\b.*-method\s+post/i,
  //   /\b(curl|wget|certutil|bitsadmin|scp)\b/i,             // egress
  //   /\$env:path\s*=/i, /\bmklink\b|\bsubst\b|junction/i,   // escape/process
  // ];
  // if (DENY.some(re => re.test(command))) return { verdict: 'blocked' };
  // // тут же: разворот вложенных вызовов cmd /c "…", bash -lc "…",
  // // канонизация путей против workspace, разрешение алиасов,
  // // проверка egress-флага в META ТЗ и т.д. — см. README.
  // return { verdict: 'allowed' };
}
