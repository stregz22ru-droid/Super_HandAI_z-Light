// autopilot.feature.js — BASE: серверная часть автопилота моста.
//
// Мост (юзерскрипт v3.4, вкладка chat.z.ai) при появлении в ответе GLM блока с
// каркасом ТЗ (# ЗАДАЧ + # META + ## ШАГ) сам копирует его (cmView) и отправляет
// сюда: POST /features/autopilot/start {tzText} — задача запускается штатным
// конвейером сервера (тот же путь, что WS task.start) БЕЗ ручной вставки.
//
// Двойная защита:
//  1) фича autopilot должна быть включена в config.features (иначе маршрут не
//     зарегистрирован вовсе — фича не загружается);
//  2) подрежим autopilot-active (one-click тумблер в OPERATOR-панели и панели
//     моста) должен быть true ПРЯМО СЕЙЧАС — живое чтение, без рестарта.
//
// Отчёты мосту отдаёт не этот модуль, а вкладка юзерскрипта на странице агента
// (WS task.done → GM-канал между вкладками). Состояние для панели:
//   GET /features/autopilot/status → {featureEnabled, active, busy, last}
export const manifest = {
  name: 'autopilot',
  title: 'Автопилот моста (серверная часть)',
  description:
    'HTTP-контракт юзерскрипта-автопилота: POST /features/autopilot/start {tzText} запускает ТЗ из чата штатным конвейером агента (только при подрежиме autopilot-active); GET /features/autopilot/status — состояние для панели моста. Отчёты вкладке z.ai доставляет юзерскрипт на странице агента (WS task.done).',
  version: '1.0.0',
  slot: ['route'],
  dependencies: [],
  minCore: '1.1.0',
  submodes: [
    {
      name: 'autopilot-active',
      description:
        'Автопилот активен: ТЗ из чата GLM запускаются агентом автоматически, отчёты возвращаются в чат по шаблону «↻ Следующий цикл». Тумблер действует сразу; стоп-критерии моста выключают его сами.',
    },
  ],
};

const BODY_MAX = 512 * 1024;

export function create(ctx) {
  let last = null; // { ts, ok, taskId?, error? } — последний запуск через мост

  function json(res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > BODY_MAX) throw new Error('body слишком большой');
      chunks.push(c);
    }
    const s = Buffer.concat(chunks).toString('utf8');
    return s ? JSON.parse(s) : {};
  }

  // POST /features/autopilot/start — {tzText: string}
  ctx.registerRoute('POST', '/features/autopilot/start', async (req, res) => {
    if (ctx.config.features['autopilot-active'] !== true) {
      json(res, 409, {
        ok: false,
        error: 'подрежим autopilot-active выключен — включите тумблером «AUTOPILOT» (панель моста или OPERATOR-панель)',
        active: false,
      });
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      json(res, 400, { ok: false, error: 'тело должно быть JSON {tzText}: ' + (e instanceof Error ? e.message : String(e)) });
      return;
    }
    const tzText = String(body?.tzText ?? '');
    if (!tzText.trim()) {
      json(res, 400, { ok: false, error: 'пустой tzText' });
      return;
    }
    const bridge = ctx.serverBridge ? ctx.serverBridge() : null;
    if (!bridge) {
      json(res, 503, { ok: false, error: 'конвейер задач недоступен (агент ещё стартует?)' });
      return;
    }
    if (bridge.isBusy()) {
      json(res, 409, { ok: false, error: 'task already running', busy: true });
      return;
    }
    const r = await bridge.startTask(tzText);
    last = { ts: new Date().toISOString(), ok: r.ok, taskId: r.taskId, error: r.error };
    json(res, r.ok ? 200 : 400, r);
  });

  // GET /features/autopilot/status — состояние для панели моста
  ctx.registerRoute('GET', '/features/autopilot/status', (req, res) => {
    const bridge = ctx.serverBridge ? ctx.serverBridge() : null;
    json(res, 200, {
      ok: true,
      featureEnabled: ctx.config.features['autopilot'] === true,
      active: ctx.config.features['autopilot-active'] === true,
      busy: bridge ? bridge.isBusy() : false,
      last,
    });
  });

  return {};
}
