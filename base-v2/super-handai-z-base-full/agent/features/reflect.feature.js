// reflect.feature.js — демо-фича «Рефлексия самонадзора» (СИСТЕМА ФИЧ).
// Слот afterRun: считает RUN/RUN_BG/WRITE/GIT, каждые N шагов печатает
// в терминал чек-лист самонадзора (бэкап? EXPECT? чекпоинт?).
export const manifest = {
  name: 'reflect',
  title: 'Рефлексия самонадзора',
  description:
    'Счётчик RUN/RUN_BG/WRITE/GIT; каждые 3 шага печатает в терминал чек-лист самонадзора: бэкап? EXPECT-проверки актуальны? чекпоинт/GIT после успешной серии?',
  version: '1.0.0',
  slot: ['afterRun'],
  dependencies: [],
  minCore: '1.0.0',
};

export function create(ctx) {
  const N = 3; // период рефлексии (шагов)
  const counts = { RUN: 0, RUN_BG: 0, WRITE: 0, GIT: 0 };
  let total = 0;
  return {
    afterRun(i, info) {
      if (!info || typeof info.kind !== 'string') return;
      if (info.kind in counts) counts[info.kind] += 1;
      total += 1;
      if (total % N !== 0) return;
      ctx.log('info', `[REFLECT] шагов: ${total} | ${JSON.stringify(counts)}`);
      ctx.log('info', '[REFLECT] чек-лист самонадзора: бэкап сделан? EXPECT-проверки актуальны? чекпоинт/GIT после успешной серии?');
    },
  };
}
