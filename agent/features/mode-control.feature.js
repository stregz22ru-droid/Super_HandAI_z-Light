// mode-control.feature.js — B1 (П-2): режим per-agent «Ручной ⇄ Автопилот».
// Витрина + диагностический маршрут. Сам режим хранит modeStore (base2),
// переключение — WS mode.set (тумблер UI) через modeGate; MCP — read-only.
export const manifest = {
  name: 'mode-control',
  title: 'Режим: Ручной ⇄ Автопилот',
  description:
    'B1: карта режимов per-agent (config.mode — отдельный ключ от features), единственный писатель modeStore, ' +
    'mode.changed через шину слотов, drain-политика, блокировка при открытой confirm-панели. ' +
    'GET /features/mode-control — текущая карта режимов и pendingDrain.',
  version: '1.0.0',
  slot: ['route'],
  dependencies: [],
  minCore: '1.0.0',
};

export function create(ctx) {
  ctx.registerRoute('GET', '/features/mode-control', async (req, res) => {
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
      res.end(JSON.stringify({ ok: false, error: 'base2 runtime не инициализирован (агент старой сборки?)' }));
      return;
    }
    const body = {
      ok: true,
      modes: rt.modeStore.listModes(),
      default: 'manual',
      mcpReadOnly: true,
      note: 'переключение — WS mode.set (тумблер UI); дефолт manual; state переживает рестарт (config.mode)',
    };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body, null, 2));
  });
  return {};
}
