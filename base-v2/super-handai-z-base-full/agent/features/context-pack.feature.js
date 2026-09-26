// context-pack.feature.js — демо-фича «Контекст-пак» (СИСТЕМА ФИЧ).
// Слот route: регистрирует GET /features/context-pack.
//
// ДОЗАКАЗ п.2 (принцип Ponytail): сборка markdown УБРАНА из фичи — она
// делегирует ЕДИНОМУ билдеру src/core/contextPack.ts (dist/core/contextPack.js),
// который вызывает и MCP-инструмент context_pack (mcp.ts) НАПРЯМУЮ, без HTTP.
// Здесь остаётся только регистрация маршрута и отдача результата.
export const manifest = {
  name: 'context-pack',
  title: 'Контекст-пак',
  description:
    'GET /features/context-pack — единый markdown-артефакт (versions/config/git status/journal). ' +
    'Сборка — общий билдер core/contextPack.ts: тот же, что у MCP-инструмента context_pack.',
  version: '1.1.0',
  slot: ['route'],
  dependencies: [],
  minCore: '1.0.0',
};

export function create(ctx) {
  ctx.registerRoute('GET', '/features/context-pack', async (req, res) => {
    // Ленивый импорт единого билдера: на момент запроса dist уже собран
    // (агент запускается из dist). Если dist нет — явная диагностика, не падение.
    let mod;
    try {
      mod = await import('../dist/core/contextPack.js');
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: false,
          error:
            'единый билдер context-pack недоступен (dist/core/contextPack.js) — пересобери ядро (npm run build): ' +
            (e instanceof Error ? e.message : String(e)),
        }),
      );
      return;
    }
    const versions = ctx.versions();
    const md = await mod.buildContextPack({
      journalLimit: 20,
      featuresVersions: versions && versions.features ? versions.features : {},
    });
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    res.end(md);
  });
  return {};
}
