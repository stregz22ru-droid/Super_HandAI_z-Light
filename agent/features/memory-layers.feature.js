// memory-layers.feature.js — ПАМЯТЬ: 4 слоя (ghostweave: append-only).
// Витрина + диагностический маршрут со статистикой слоёв.
export const manifest = {
  name: 'memory-layers',
  title: 'Память: проект/чаты/агенты',
  description:
    'Слои памяти: (1) <workspace>/CONTEXT.md после task.done; (2) data/memory/projects.json; ' +
    '(3) data/memory/conversations/<chatId>.jsonl — append-only журнал чата-инициатора; ' +
    '(4) data/memory/agents/<agentId>.json — межагентские связи (заготовка Persona). ' +
    'GET /features/memory-layers — статистика слоёв.',
  version: '1.0.0',
  slot: ['route'],
  dependencies: [],
  minCore: '1.0.0',
};

export function create(ctx) {
  ctx.registerRoute('GET', '/features/memory-layers', async (req, res) => {
    let rt;
    try {
      rt = (await import('../dist/base2/runtime.js')).getBase2();
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'base2 runtime недоступен — пересобери ядро (npm run build): ' + (e instanceof Error ? e.message : String(e)) }));
      return;
    }
    if (!rt) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'base2 runtime не инициализирован' }));
      return;
    }
    const body = {
      ok: true,
      ...rt.memory.stats(),
      files: {
        projects: 'data/memory/projects.json',
        conversations: 'data/memory/conversations/<chatId>.jsonl',
        agents: 'data/memory/agents/<agentId>.json',
      },
      pattern: 'append-only (ghostweave): записи только добавляются',
    };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body, null, 2));
  });
  return {};
}
