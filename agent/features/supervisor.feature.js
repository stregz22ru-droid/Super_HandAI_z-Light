// supervisor.feature.js — BASE: супервизор циклов.
//
// afterRun/onTaskDone: учёт истории задач (оборот цикла, серии FAIL).
// onFail: счёт одинаковых FAIL подряд; при пороге (config.supervisor.maxSameFails,
//   дефолт 3) — уведомление «N FAIL подряд на ШАГ i — нужны указания».
// onTaskDone: серия оборотов без SUCCESS по проекту (workdir); при пороге
//   (config.supervisor.maxTurnsNoSuccess, дефолт 5) — уведомление оператору.
//
// Уведомления (ASK-подобные) складываются в очередь, которую мост забирает
//   GET /features/supervisor/notifications?since=<id>
// Остановка автопилота по стоп-критериям моста регистрируется здесь же:
//   POST /features/supervisor/intervention {reason, context?}
// (попадает и в очередь, и в терминал агента — оператор видит контекст).
export const manifest = {
  name: 'supervisor',
  title: 'Супервизор циклов',
  description:
    'Учёт истории задач (обороты, FAIL-серии) и пороги вмешательства: N одинаковых FAIL подряд / M оборотов без SUCCESS — ASK-подобные уведомления в панель моста (GET /features/supervisor/notifications) и терминал агента. Остановка автопилота регистрируется через POST /features/supervisor/intervention.',
  version: '1.0.0',
  slot: ['afterRun', 'onFail', 'onTaskDone', 'route'],
  dependencies: [],
  minCore: '1.1.0',
};

const QUEUE_CAP = 100;

export function create(ctx) {
  const notifications = [];
  let lastId = 0;
  // taskId -> { failsInRow, lastSig, failsTotal }
  const tasks = new Map();
  // workdir -> { noSuccessStreak, lastStatus, lastCycle, lastTs }
  const projects = new Map();

  function thresholds() {
    const s = ctx.config?.supervisor ?? {};
    return {
      maxSameFails: Number(s.maxSameFails ?? 3),
      maxTurnsNoSuccess: Number(s.maxTurnsNoSuccess ?? 5),
    };
  }

  function push(kind, text, context) {
    const n = { id: ++lastId, ts: new Date().toISOString(), kind, text, context: context ?? null };
    notifications.push(n);
    if (notifications.length > QUEUE_CAP) notifications.splice(0, notifications.length - QUEUE_CAP);
    ctx.log('warn', '[SUPERVISOR] ' + text);
    return n;
  }

  function taskOf(taskId) {
    let t = tasks.get(taskId);
    if (!t) {
      t = { failsInRow: 0, lastSig: '', failsTotal: 0 };
      tasks.set(taskId, t);
    }
    return t;
  }

  function json(res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const s = Buffer.concat(chunks).toString('utf8');
    return s ? JSON.parse(s) : {};
  }

  // --- маршруты для моста и UI ---
  ctx.registerRoute('GET', '/features/supervisor/notifications', (req, res) => {
    const url = new URL(req.url ?? '/features/supervisor/notifications', 'http://local');
    const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0;
    json(res, 200, {
      ok: true,
      notifications: notifications.filter((n) => n.id > since),
      lastId,
    });
  });

  ctx.registerRoute('POST', '/features/supervisor/intervention', async (req, res) => {
    let body;
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { ok: false, error: 'тело должно быть JSON {reason, context?}' });
      return;
    }
    const reason = String(body?.reason ?? '').trim();
    if (!reason) {
      json(res, 400, { ok: false, error: 'reason обязателен' });
      return;
    }
    const n = push('intervention', 'Автопилот остановлен: ' + reason.slice(0, 300), body?.context ?? null);
    json(res, 200, { ok: true, id: n.id });
  });

  return {
    afterRun(i, info) {
      if (!info?.taskId) return;
      taskOf(info.taskId); // регистрируем активность (шаги без отказов сбрасывают серию ниже)
      const t = tasks.get(info.taskId);
      if (info.status === 'ok') {
        t.failsInRow = 0;
        t.lastSig = '';
      }
    },

    onFail(i, failReason, info) {
      const taskId = info?.taskId;
      if (!taskId) return;
      const t = taskOf(taskId);
      const firstLine = String(failReason ?? '').split('\n')[0].slice(0, 160);
      const sig = String(info?.kind ?? '?') + '|' + firstLine;
      if (sig === t.lastSig) t.failsInRow++;
      else {
        t.failsInRow = 1;
        t.lastSig = sig;
      }
      t.failsTotal++;
      const { maxSameFails } = thresholds();
      if (t.failsInRow === maxSameFails) {
        push(
          'fail-series',
          t.failsInRow + ' FAIL подряд на ШАГ ' + i + ' (' + (info?.kind ?? '?') + '): ' + firstLine + ' — нужны указания',
          { taskId, i, kind: info?.kind, failReason: firstLine },
        );
      }
    },

    onTaskDone(info) {
      tasks.delete(info.taskId);
      const wd = info.meta?.workdir || String(info.workspace ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '?';
      const p = projects.get(wd) ?? { noSuccessStreak: 0 };
      if (info.status === 'SUCCESS') p.noSuccessStreak = 0;
      else p.noSuccessStreak++;
      p.lastStatus = info.status;
      p.lastCycle = info.meta?.cycle ?? null;
      p.lastTs = new Date().toISOString();
      projects.set(wd, p);

      push('task-done', 'Задача "' + info.title + '" (' + wd + ') завершена: ' + info.status + ', оборот ' + (info.meta?.cycle ?? '?') + '.', { taskId: info.taskId, workdir: wd, status: info.status });

      const { maxTurnsNoSuccess } = thresholds();
      if (info.status !== 'SUCCESS' && p.noSuccessStreak >= maxTurnsNoSuccess) {
        push(
          'no-success-streak',
          p.noSuccessStreak + ' оборотов подряд без SUCCESS в "' + wd + '" — вмешательство оператора',
          { workdir: wd, lastStatus: info.status },
        );
        p.noSuccessStreak = 0; // уведомили — не спамим на каждом следующем обороте
      }
    },
  };
}
