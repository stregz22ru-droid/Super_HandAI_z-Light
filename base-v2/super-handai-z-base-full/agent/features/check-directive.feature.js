// check-directive.feature.js — B4: CHECK-директива (preRun-слот stepEngine).
// ЕДИНСТВЕННАЯ врезка в ядро, одобренная Мастером. При выключенной фиче
// слот не регистрируется — поведение ядра побайтово базовое (но-оп).
// Guard-DENY финален и CHECK-ом не перегрывается; fail-closed для
// деструктивного класса; решения — data/logs/check-decisions.jsonl.
export const manifest = {
  name: 'check-directive',
  title: 'CHECK-директива (AGP)',
  description:
    'B4: перед деструктивным RUN/RUN_BG — вердикт шлюза AGP /agent/check-operation ' +
    '(ALLOW/DENY/CONFIRM/MODIFY; MODIFY = DENY с предложением). Кэш hash(команда,' +
    'рабочая папка, режим), TTL 60 c, инвалидация при смене режима, бюджет 1.5 c, ' +
    'fail-closed для деструктивного класса, origin.agentId — в AGP (статистика per-agent).',
  version: '1.0.0',
  slot: ['beforeRun'],
  dependencies: [],
  minCore: '1.0.0',
};

// create ОБЯЗАН быть синхронным (контракт реестра); dist-модули подгружаем
// лениво при первом вызове слота (агент исполняется из dist — dist уже собран).
let handlePromise = null;

function lazyHandle(ctx) {
  if (!handlePromise) {
    handlePromise = (async () => {
      const mod = await import('../dist/base2/check/directive.js');
      const cfgMod = await import('../dist/config.js');
      const cfg = cfgMod.loadConfig(cfgMod.configPath());
      return mod.createBeforeRunCheck({
        cfg,
        root: cfgMod.configPath().replace(/[\\/]data[\\/]state[\\/]config\.json$/i, ''),
        log: (level, msg) => ctx.log(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', msg),
      });
    })();
    handlePromise.catch((e) => {
      ctx.log('error', 'инициализация CHECK не удалась (директива НЕ активна): ' + (e instanceof Error ? e.message : String(e)));
    });
  }
  return handlePromise;
}

export function create(ctx) {
  return {
    beforeRun: async (i, directive) => {
      const handle = await lazyHandle(ctx);
      return handle.beforeRun(i, directive);
    },
  };
}
