// agp-check.feature.js — BASE: AGP-клиент (договор README-AGP, Этап 4 шлюза).
//
// Слот beforeRun: перед каждым RUN/RUN_BG/WRITE спрашивает AGP-шлюз
//   POST {agp.gatewayUrl}/agent/check-operation
//        {agentId, operation: run|write, preview, targetPath?, workspace}
//   → ALLOW            = исполнить (undefined)
//   → DENY             = skip с заметкой
//   → REVIEW           = confirm-запрос оператору через штатный канал
//                        (семантика confirm не меняется: отмена = SKIP)
// Шлюз недоступен / таймаут / мусорный ответ — fail-closed: skip + заметка.
//
// Слот afterRun: POST /agent/notify {eventId, result: success|fail, durationMs}
//   — RESULT-событие в единую цепь аудита AGP (eventId из решения check-operation).
//
// agentId/шлюз/таймаут — config.agp {gatewayUrl, agentId, timeoutMs};
// выключение на лету — toggle флага config.features['agp-check'] (живое чтение).
export const manifest = {
  name: 'agp-check',
  title: 'AGP-контроль операций',
  description:
    'Перед каждым RUN/RUN_BG/WRITE — check-operation в AGP-шлюз: DENY = шаг пропущен, REVIEW = подтверждение оператора, ALLOW = исполнение; после исполнения шлёт RESULT в /agent/notify. Шлюз недоступен — fail-closed (шаг пропущен с заметкой).',
  version: '1.0.0',
  slot: ['beforeRun', 'afterRun'],
  dependencies: [],
  minCore: '1.1.0',
};

const DEFAULTS = {
  gatewayUrl: 'http://127.0.0.1:8790',
  agentId: 'super_handai_z_light',
  timeoutMs: 3000,
};

export function create(ctx) {
  // eventId последнего check-operation по ключу «kind:первая-строка» (после
  // исполнения движок вызывает afterRun с тем же kind и cmd — см. stepEngine).
  const pending = new Map();

  function agpCfg() {
    const c = ctx.config.agp ?? {};
    return {
      gatewayUrl: String(c.gatewayUrl ?? DEFAULTS.gatewayUrl).replace(/\/+$/, ''),
      agentId: String(c.agentId ?? DEFAULTS.agentId),
      timeoutMs: Number(c.timeoutMs ?? DEFAULTS.timeoutMs),
    };
  }

  async function post(path, body) {
    const { gatewayUrl, timeoutMs } = agpCfg();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(gatewayUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await r.text();
      if (r.status !== 200) {
        throw new Error('HTTP ' + r.status + (text ? ': ' + text.slice(0, 140) : ''));
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('ответ не JSON: ' + text.slice(0, 80));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  function opOf(directive) {
    const kind = directive?.kind;
    if (kind === 'RUN' || kind === 'RUN_BG') {
      return { operation: 'run', preview: String(directive.script ?? '').split('\n')[0], targetPath: undefined };
    }
    if (kind === 'WRITE') {
      return {
        operation: 'write',
        preview: String(directive.content ?? '').split('\n')[0],
        targetPath: directive.path,
      };
    }
    return null; // GIT и прочие — вне договора agp-check
  }

  function keyOf(kind, cmdOrPath) {
    return kind + ':' + String(cmdOrPath ?? '');
  }

  return {
    async beforeRun(i, directive) {
      if (!directive) return undefined;
      if (ctx.config.features['agp-check'] !== true) return undefined; // живой флаг — мгновенный toggle
      const op = opOf(directive);
      if (!op) return undefined;
      const { agentId } = agpCfg();
      let resp;
      try {
        resp = await post('/agent/check-operation', {
          agentId,
          operation: op.operation,
          preview: op.preview,
          ...(op.targetPath ? { targetPath: op.targetPath } : {}),
          workspace: ctx.config.workspaceRoot,
        });
        if (!resp || typeof resp.decision !== 'string') {
          throw new Error('в ответе нет decision');
        }
      } catch (e) {
        const why = 'agp-check: fail-closed — шлюз недоступен (' + (e instanceof Error ? e.message : String(e)) + ')';
        ctx.log('warn', '[AGP] ШАГ ' + i + ' ' + directive.kind + ' → ' + why);
        return { skip: true, reason: why };
      }

      const reason = String(resp.reason ?? '');
      const eventId = resp.eventId_used ?? resp.decision?.eventId_used ?? resp.decision?.eventId;
      const kind = directive.kind;
      ctx.log(
        resp.decision === 'ALLOW' ? 'info' : 'warn',
        '[AGP] ШАГ ' + i + ' ' + kind + ' → ' + resp.decision + (reason ? ': ' + reason : ''),
      );

      if (resp.decision === 'DENY') {
        return { skip: true, reason: 'agp: DENY — ' + (reason || 'запрещено политикой AGP') };
      }
      if (resp.decision === 'REVIEW') {
        // eventId сохраняем сразу: при одобрении оператора директива исполняется,
        // afterRun доложит RESULT; при отклонении запись перезатрётся следующим
        // check той же операции или останется безвредной (после неё afterRun нет).
        if (eventId) {
          pending.set(keyOf(kind, kind === 'WRITE' ? op.targetPath : op.preview), { eventId, at: Date.now() });
        }
        return {
          confirm: { kind: kind === 'WRITE' ? 'WRITE' : kind, preview: op.preview },
          reason: 'agp: REVIEW — ' + (reason || 'требуется подтверждение оператора'),
        };
      }
      // ALLOW (и всё неизвестное трактуем как ALLOW — решение принял шлюз)
      if (eventId) pending.set(keyOf(kind, kind === 'WRITE' ? op.targetPath : op.preview), { eventId, at: Date.now() });
      return undefined;
    },

    async afterRun(i, info) {
      if (!info || !info.kind) return;
      const key = keyOf(info.kind, info.kind === 'WRITE' ? String(info.cmd ?? '').replace(/^WRITE\s+/, '') : info.cmd);
      const held = pending.get(key);
      if (!held) return;
      pending.delete(key);
      const result = info.status === 'ok' ? 'success' : 'fail';
      try {
        await post('/agent/notify', {
          eventId: held.eventId,
          result,
          durationMs: Math.max(0, Math.round(info.durationMs ?? 0)),
        });
        ctx.log('info', '[AGP] RESULT ' + result + ' → ' + held.eventId);
      } catch (e) {
        ctx.log('warn', '[AGP] notify не доставлен (' + (e instanceof Error ? e.message : String(e)) + ')');
      }
    },
  };
}
