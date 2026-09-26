// autopilot-core.feature.js — B2/B3: мост автопилота (вход/выход/петля).
// Витрина + диагностический маршрут: состояние FSM петель, очереди, дедуп.
export const manifest = {
  name: 'autopilot-core',
  title: 'Автопилот: мост и петля',
  description:
    'B2+B3: распознавание ТЗ по контракту ```shai-tz```, дедуп sha256, очередь 1 слот с TTL, idle-gate; ' +
    'ledger оборотов с отпечатками K4 (per-инициатор K9), стоп-политика (N без SUCCESS, 3 отпечатка, ' +
    'контрактное завершение), outflow с redaction per-agent и квотой, эскалация 3+1 приёмника, ' +
    'персистентность FSM data/autopilot-state.json (K5). GET /features/autopilot-core — снапшот петель.',
  version: '1.0.0',
  slot: ['route'],
  dependencies: [],
  minCore: '1.0.0',
};

export function create(ctx) {
  ctx.registerRoute('GET', '/features/autopilot-core', async (req, res) => {
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
      loops: rt.fsm.snapshotAll(),
      tasks: rt.taskService.snapshot(),
      queueSlots: rt.queue.size(),
      config: {
        maxTurnsNoSuccess: rt.cfg.autopilot?.maxTurnsNoSuccess ?? 5,
        queueTtlSec: rt.cfg.autopilot?.queueTtlSec ?? 600,
        outQuotaChars: rt.cfg.autopilot?.outQuotaChars ?? 12000,
        helperAgentId: rt.cfg.autopilot?.helperAgentId ?? '',
        trustedAgents: rt.cfg.helpers?.trustedAgents ?? [],
      },
    };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body, null, 2));
  });
  return {};
}
