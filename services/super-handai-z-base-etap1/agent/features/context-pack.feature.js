// context-pack.feature.js — демо-фича «Контекст-пак» (СИСТЕМА ФИЧ).
// Слот route: регистрирует GET /features/context-pack, который собирает
// git status, config, последние 20 записей journal и versions
// в единый markdown-артефакт (удобно отдать LLM-мосту как контекст).
export const manifest = {
  name: 'context-pack',
  title: 'Контекст-пак',
  description:
    'GET /features/context-pack — единый markdown-артефакт: git status workspace, config, последние 20 записей journal, versions ядра и фич.',
  version: '1.0.0',
  slot: ['route'],
  dependencies: [],
  minCore: '1.0.0',
};

export function create(ctx) {
  ctx.registerRoute('GET', '/features/context-pack', async (req, res) => {
    const [git, journal] = await Promise.all([ctx.gitStatus(), ctx.journalTail(20)]);
    const md = [
      '# Context Pack — ' + new Date().toISOString(),
      '',
      '## versions',
      '',
      '```json',
      JSON.stringify(ctx.versions(), null, 2),
      '```',
      '',
      '## config',
      '',
      '```json',
      JSON.stringify(ctx.config, null, 2),
      '```',
      '',
      '## git status',
      '',
      '```',
      git,
      '```',
      '',
      `## journal (последние ${journal.length})`,
      '',
      '```json',
      JSON.stringify(journal, null, 2),
      '```',
      '',
      '',
    ].join('\n');
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    res.end(md);
  });
  return {};
}
