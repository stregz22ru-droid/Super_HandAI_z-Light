// features/http.ts — HTTP-обработчики системы фич (вызывается из server.ts
// под токен-гейтом). Синтаксис ответов совместим с остальным ядром.
import { existsSync, unlinkSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FeatureRegistry,
  BUNDLED_FEATURES,
  validateManifest,
  type FeatureManifest,
} from './registry.js';
import type { AgentConfig } from '../config.js';

export interface FeatureHttpDeps {
  registry: FeatureRegistry;
  cfg: AgentConfig;
  cfgPath: string; // для записи features-секции при toggle
  root: string; // корень проекта (для временных файлов загрузки)
}

const UPLOAD_MAX_BYTES = 256 * 1024;

function json(res: any, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req: any): Promise<Buffer> {
  return new Promise((resolveP, rejectP) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      if (chunks.reduce((s, b) => s + b.length, 0) > UPLOAD_MAX_BYTES) {
        rejectP(new Error('body слишком большой'));
        req.destroy();
      }
    });
    req.on('end', () => resolveP(Buffer.concat(chunks)));
    req.on('error', rejectP);
  });
}

/**
 * Валидация загружаемого .feature.js: импорт из временного файла,
 * проверка манифеста и совпадения manifest.name с именем файла.
 * Код исполняется при импорте — это контракт фич (см. SECURITY в UI).
 */
export async function validateUploadedFeature(
  code: Buffer,
  filename: string,
  tmpDir: string,
): Promise<{ ok: boolean; manifest?: FeatureManifest; errors: string[] }> {
  const errors: string[] = [];
  const stem = filename.replace(/\.feature\.js$/i, '');
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(stem)) {
    return { ok: false, errors: [`имя файла должно быть <name>.feature.js, где name: [a-z0-9-]{2,32} (получено: "${filename}")`] };
  }
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `.upload-${Date.now()}-${Math.random().toString(16).slice(2)}.feature.js`);
  writeFileSync(tmp, code, 'utf8');
  try {
    let mod: any;
    try {
      mod = await import(pathToFileURL(tmp).href);
    } catch (e) {
      return { ok: false, errors: [`файл не импортируется: ${e instanceof Error ? e.message : String(e)}`] };
    }
    const v = validateManifest(mod.manifest);
    if (v.errors.length > 0) return { ok: false, errors: v.errors };
    if (v.manifest!.name !== stem) {
      return { ok: false, errors: [`manifest.name "${v.manifest!.name}" не совпадает с именем файла "${stem}.feature.js"`] };
    }
    if (typeof mod.create !== 'function') {
      return { ok: false, errors: ['модуль не экспортирует create(ctx)'] };
    }
    return { ok: true, manifest: v.manifest!, errors: [] };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp может не существовать */
    }
  }
}

/**
 * Диспетчер /features*. Возвращает true, если запрос обработан.
 * Вызывающая сторона (server.ts) обязана ПРЕДВАРИТЕЛЬНО проверить токен.
 */
export async function handleFeaturesApi(
  req: any,
  res: any,
  url: URL,
  deps: FeatureHttpDeps,
): Promise<boolean> {
  const { registry, cfg, cfgPath, root } = deps;
  const method = (req.method ?? 'GET').toUpperCase();
  const path = url.pathname;

  // GET /features — список: manifest + enabled (+ loaded/bundled/errors) + подрежимы
  if (method === 'GET' && path === '/features') {
    const rows = registry.list().map((r) => ({
      name: r.name,
      title: r.manifest?.title ?? '(манифест недоступен)',
      description: r.manifest?.description ?? r.errors.join('; '),
      version: r.manifest?.version ?? '',
      slot: r.manifest?.slot ?? [],
      dependencies: r.manifest?.dependencies ?? [],
      minCore: r.manifest?.minCore ?? '',
      // ЖИВОЕ состояние из cfg.features (toggle обновляет cfg сразу) — а не boot-снимок реестра;
      // r.enabled учитывает minCore/зависимости на старте и поэтому может устареть.
      enabled: cfg.features?.[r.name] === true,
      loaded: r.loaded,
      bundled: r.bundled,
      errors: r.errors,
    }));
    // СИСТЕМА ФИЧ: подрежимы (напр. dry-run-active) — one-click toggle в OPERATOR-панели.
    const submodes = registry
      .list()
      .flatMap((r) =>
        (r.manifest?.submodes ?? []).map((sm) => ({
          name: sm.name,
          description: sm.description,
          feature: r.name,
          featureEnabled: cfg.features?.[r.name] === true,
          enabled: cfg.features?.[sm.name] === true,
        })),
      );
    json(res, 200, { ok: true, features: rows, submodes });
    return true;
  }

  // POST /features/toggle — {name, enabled} -> пишет features-секцию config.json
  if (method === 'POST' && path === '/features/toggle') {
    let body: any;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {
      json(res, 400, { ok: false, error: 'тело должно быть JSON {name, enabled}' });
      return true;
    }
    const name = body?.name;
    const enabled = body?.enabled;
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(name) || typeof enabled !== 'boolean') {
      json(res, 400, { ok: false, error: 'ожидалось {name: string, enabled: boolean}' });
      return true;
    }
    if (!cfg.features) cfg.features = {};
    cfg.features[name] = enabled;
    try {
      mkdirSync(dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    } catch (e) {
      json(res, 500, { ok: false, error: `config.json не записан: ${e instanceof Error ? e.message : String(e)}` });
      return true;
    }
    json(res, 200, {
      ok: true,
      name,
      enabled,
      note:
        'включение/выключение фичи применяется после рестарта агента; подрежимы (напр. dry-run-active) действуют сразу',
    });
    return true;
  }

  // POST /features/upload — raw-тело .feature.js, имя через ?filename= или x-filename
  if (method === 'POST' && path === '/features/upload') {
    const filename = (url.searchParams.get('filename') ?? String(req.headers['x-filename'] ?? '')).trim();
    let code: Buffer;
    try {
      code = await readBody(req);
    } catch (e) {
      json(res, 413, { ok: false, error: e instanceof Error ? e.message : String(e) });
      return true;
    }
    if (code.length === 0) {
      json(res, 400, { ok: false, error: 'пустое тело — жду содержимое .feature.js (raw)' });
      return true;
    }
    const v = await validateUploadedFeature(code, filename, resolve(root, 'data', 'state'));
    if (!v.ok) {
      json(res, 400, { ok: false, error: 'фича не прошла валидацию', issues: v.errors });
      return true;
    }
    const target = join(registry.featuresDirectory, filename);
    const replaced = existsSync(target);
    const bundledCollision = BUNDLED_FEATURES.includes(v.manifest!.name);
    if (bundledCollision) {
      json(res, 409, { ok: false, error: `фича "${v.manifest!.name}" — bundled, загрузка с таким именем запрещена` });
      return true;
    }
    writeFileSync(target, code, 'utf8');
    json(res, 200, {
      ok: true,
      name: v.manifest!.name,
      version: v.manifest!.version,
      replaced,
      note: 'файл записан в agent/features — активируется после рестарта агента и toggle в config',
    });
    return true;
  }

  // DELETE /features/:name — удалить файл (кроме bundled)
  if (method === 'DELETE' && path.startsWith('/features/')) {
    const name = decodeURIComponent(path.slice('/features/'.length));
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(name)) {
      json(res, 400, { ok: false, error: 'некорректное имя фичи' });
      return true;
    }
    if (BUNDLED_FEATURES.includes(name)) {
      json(res, 403, { ok: false, error: `фича "${name}" — bundled, удаление запрещено (отключите через /features/toggle)` });
      return true;
    }
    const target = join(registry.featuresDirectory, `${name}.feature.js`);
    if (!existsSync(target)) {
      json(res, 404, { ok: false, error: `файл фичи не найден: ${name}.feature.js` });
      return true;
    }
    try {
      unlinkSync(target);
    } catch (e) {
      json(res, 500, { ok: false, error: `не удалён: ${e instanceof Error ? e.message : String(e)}` });
      return true;
    }
    json(res, 200, { ok: true, name, note: 'файл удалён; из памяти загруженного агента фича исчезнет после рестарта' });
    return true;
  }

  return false; // не наш маршрут — пусть server.ts отдаст 404 системы фич
}

/** Читает последние n строк journal.jsonl (для context-pack). */
export function readJournalTail(journalPath: string, n: number): unknown[] {
  if (!existsSync(journalPath)) return [];
  try {
    const lines = readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { action: '(битая запись)' };
      }
    });
  } catch {
    return [];
  }
}
