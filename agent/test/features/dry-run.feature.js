// dry-run.feature.js — демо-фича «Сухой прогон» (СИСТЕМА ФИЧ).
// Слот beforeRun: если в config.features['dry-run-active'] === true
// (подрежим включается toggle'ом без рестарта), перехватывает RUN/RUN_BG,
// печатает «[DRY] было бы: <команда>» и возвращает skip без исполнения.
export const manifest = {
  name: 'dry-run',
  title: 'Сухой прогон',
  description:
    'Подрежим dry-run-active: перехватывает RUN/RUN_BG, печатает «[DRY] было бы: <команда>» и пропускает исполнение (шаг в отчёте — skip). Переключается одно-кликовым тумблером DRY-RUN в OPERATOR-панели без рестарта.',
  version: '1.1.0',
  slot: ['beforeRun'],
  dependencies: [],
  minCore: '1.0.0',
  // СИСТЕМА ФИЧ: подрежимы — флаги config.features с one-click toggle в OPERATOR-панели.
  submodes: [
    {
      name: 'dry-run-active',
      description:
        'Сухой прогон: RUN/RUN_BG не исполняются, в терминал печатается «[DRY] было бы: <команда>». Действует сразу, без рестарта агента.',
    },
  ],
};

export function create(ctx) {
  return {
    beforeRun(i, directive) {
      if (!directive || (directive.kind !== 'RUN' && directive.kind !== 'RUN_BG')) return undefined;
      if (ctx.config.features['dry-run-active'] !== true) return undefined;
      const cmd = String(directive.script ?? '').split('\n')[0];
      ctx.log('warn', `[DRY] было бы: ${cmd}`);
      return { skip: true, reason: 'dry-run: исполнение подавлено (подрежим dry-run-active)' };
    },
  };
}
