// src/skillconv.ts — SKILL-конвертер (ЭТАП 1, МОДУЛЬ 3; по Ponytail-Research табл. 11).
//
// Направления:
//   export  : наш пак (glm-system.md + templates.json) → SKILL.md
//             name = id пака, description = однострочник ≤160 символов,
//             body = glm-system.md ДОСЛОВНО, templates.json — supporting-файлом рядом.
//   import  : SKILL.md → наш пак: body → glm-system.md, frontmatter отбрасывается,
//             templates.json = пустой стартовый каталог {"name": ..., "templates": []}.
//   check   : sync-guard — парность pack ↔ SKILL.md (падение при дрейфе,
//             по образцу openclaw-skills.test.js донора).
//
// Гигиена входа: BOM-strip (Windows-редакторы любят U+FEFF), CRLF-толерантность
// только для РАЗБОРА frontmatter — body экспорта/импорта хранится дословно.
//
// Формат frontmatter де-факто совместим с Anthropic Agent Skills:
//   ---
//   name: <id>
//   description: <однострочник ≤160>
//   ---
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, basename, dirname, isAbsolute } from 'node:path';

export const DESCRIPTION_MAX = 160;

/** BOM-strip на входе (гигиена Windows, п. 2.4 спеки). */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function readText(p: string): string {
  return stripBom(readFileSync(p, 'utf8'));
}

export interface PackInfo {
  id: string;
  description: string;
  body: string; // glm-system.md дословно
  templatesPath: string | null;
}

/**
 * Описание по умолчанию: первый заголовок H1 (без '#'), иначе первая непустая
 * строка; markdown-разметка снимается, пробелы схлопываются, обрез до 160.
 */
export function deriveDescription(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let source = '';
  for (const l of lines) {
    const t = l.trim();
    if (t.length === 0) continue;
    if (t.startsWith('#')) { source = t.replace(/^#+\s*/, ''); break; }
    source = t;
    break;
  }
  let s = source
    .replace(/`+/g, '')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > DESCRIPTION_MAX) s = s.slice(0, DESCRIPTION_MAX - 1).trimEnd() + '…';
  return s;
}

/** Чтение пака: id из templates.json.name, иначе имя каталога. */
export function readPack(packDir: string, descriptionOverride?: string): PackInfo {
  const dir = resolve(packDir);
  if (!existsSync(dir)) throw new Error(`пак не найден: ${dir}`);
  const glmPath = join(dir, 'glm-system.md');
  if (!existsSync(glmPath)) throw new Error(`в паке нет glm-system.md: ${dir}`);
  const body = readText(glmPath);
  let id = basename(dir);
  const tplPath = join(dir, 'templates.json');
  let templatesPath: string | null = null;
  if (existsSync(tplPath)) {
    templatesPath = tplPath;
    try {
      const tpl = JSON.parse(readText(tplPath)) as { name?: string };
      if (tpl.name && /^[a-z0-9][a-z0-9-]{1,31}$/.test(tpl.name)) id = tpl.name;
    } catch { /* битый templates.json — id из каталога */ }
  }
  const description = descriptionOverride ?? deriveDescription(body);
  if (description.length > DESCRIPTION_MAX) {
    throw new Error(`description длиннее ${DESCRIPTION_MAX} символов (${description.length})`);
  }
  return { id, description, body, templatesPath };
}

/** Рендер SKILL.md: frontmatter + body ДОСЛОВНО (гарантируем \n в конце файла). */
export function renderSkillMd(pack: PackInfo): string {
  const fm = ['---', `name: ${pack.id}`, `description: ${pack.description}`, '---', '', ''].join('\n');
  const body = pack.body.endsWith('\n') ? pack.body : pack.body + '\n';
  return fm + body;
}

export interface ExportResult {
  skillPath: string;
  templatesCopied: boolean;
  name: string;
  description: string;
}

/** Пак → SKILL.md (+ templates.json supporting-файлом). */
export function exportPack(packDir: string, outDir: string, descriptionOverride?: string): ExportResult {
  const pack = readPack(packDir, descriptionOverride);
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  const skillPath = join(out, 'SKILL.md');
  writeFileSync(skillPath, renderSkillMd(pack), 'utf8');
  let templatesCopied = false;
  if (pack.templatesPath) {
    copyFileSync(pack.templatesPath, join(out, 'templates.json'));
    templatesCopied = true;
  }
  return { skillPath, templatesCopied, name: pack.id, description: pack.description };
}

export interface ParsedSkill {
  frontmatter: Record<string, string>;
  body: string;
}

/** Разбор SKILL.md: frontmatter (--- ... ---) + body дословно. */
export function parseSkillMd(text: string): ParsedSkill {
  const t = stripBom(text).replace(/\r\n?/g, '\n');
  const lines = t.split('\n');
  if ((lines[0] ?? '').trim() !== '---') {
    return { frontmatter: {}, body: text }; // нет frontmatter — весь текст body
  }
  let close = -1;
  const frontmatter: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { close = i; break; }
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (m) frontmatter[m[1]] = m[2].trim();
  }
  if (close === -1) throw new Error('SKILL.md: frontmatter не закрыт (---)');
  // body — всё после закрывающего ---, ведущие пустые строки снимаем (дословно дальше)
  let bodyLines = lines.slice(close + 1);
  while (bodyLines.length > 0 && bodyLines[0].trim() === '') bodyLines = bodyLines.slice(1);
  return { frontmatter, body: bodyLines.join('\n') };
}

const EMPTY_TEMPLATES = (name: string) => JSON.stringify({ name, templates: [] }, null, 2) + '\n';

export interface ImportResult {
  packDir: string;
  glmPath: string;
  templatesPath: string;
  discardedFrontmatter: Record<string, string>;
}

/**
 * SKILL.md → наш пак. frontmatter отбрасывается (возвращается для журнала),
 * templates.json = пустой стартовый каталог.
 */
export function importSkill(skillPath: string, outPackDir: string, packId?: string): ImportResult {
  const src = resolve(skillPath);
  const stat = statSync(src);
  const file = stat.isDirectory() ? join(src, 'SKILL.md') : src;
  if (!existsSync(file)) throw new Error(`SKILL.md не найден: ${file}`);
  const parsed = parseSkillMd(readFileSync(file, 'utf8'));
  const name = packId ?? parsed.frontmatter['name'] ?? basename(dirname(file));
  const out = resolve(outPackDir);
  mkdirSync(out, { recursive: true });
  const glmPath = join(out, 'glm-system.md');
  const body = parsed.body.endsWith('\n') ? parsed.body : parsed.body + '\n';
  writeFileSync(glmPath, body, 'utf8');
  const templatesPath = join(out, 'templates.json');
  writeFileSync(templatesPath, EMPTY_TEMPLATES(name), 'utf8');
  return { packDir: out, glmPath, templatesPath, discardedFrontmatter: parsed.frontmatter };
}

export interface SyncCheckResult {
  ok: boolean;
  issues: string[];
}

/**
 * Sync-guard: пере-рендерим SKILL.md из пака и сверяем ПОБАЙТОВО + каталог
 * templates.json. Любой дрейф (кто-то поправил одну сторону) → ok:false.
 */
export function checkSync(packDir: string, skillDir: string): SyncCheckResult {
  const issues: string[] = [];
  let pack: PackInfo;
  try {
    pack = readPack(packDir);
  } catch (e) {
    return { ok: false, issues: [e instanceof Error ? e.message : String(e)] };
  }
  const skillPath = resolve(skillDir, 'SKILL.md');
  if (!existsSync(skillPath)) {
    return { ok: false, issues: [`нет ${skillPath} — сгенерируйте: skillconv export --pack ${packDir} --out ${skillDir}`] };
  }
  const existing = readFileSync(skillPath, 'utf8');
  const expected = renderSkillMd(pack);
  if (existing !== expected) {
    issues.push('SKILL.md дрейфанул от пака (побайтово другой); пересоберите export');
  }
  const parsed = parseSkillMd(existing);
  if (parsed.frontmatter['name'] !== pack.id) {
    issues.push(`frontmatter.name (${parsed.frontmatter['name']}) != id пака (${pack.id})`);
  }
  if ((parsed.frontmatter['description'] ?? '').length > DESCRIPTION_MAX) {
    issues.push(`frontmatter.description длиннее ${DESCRIPTION_MAX}`);
  }
  // body дословно? (нормализация только финального перевода строки)
  const normTail = (s: string) => s.replace(/\n+$/, '\n');
  if (normTail(parsed.body) !== normTail(pack.body)) {
    issues.push('body SKILL.md не совпадает с glm-system.md дословно');
  }
  const packTpl = pack.templatesPath ? readFileSync(pack.templatesPath, 'utf8') : null;
  const skillTplPath = resolve(skillDir, 'templates.json');
  if (packTpl !== null) {
    if (!existsSync(skillTplPath)) {
      issues.push('templates.json не скопирован рядом со SKILL.md');
    } else if (readFileSync(skillTplPath, 'utf8') !== packTpl) {
      issues.push('templates.json дрейфанул от пака');
    }
  }
  return { ok: issues.length === 0, issues };
}

// ---------- CLI --------------------------------------------------------------

function usage(): string {
  return [
    'skillconv — конвертер пак ↔ SKILL.md (Super_HandAI_z Base, Этап 1)',
    '',
    '  skillconv export --pack <dir> --out <dir> [--description "…"]',
    '  skillconv import --skill <dir|SKILL.md> --out <dir> [--name <id>]',
    '  skillconv check  --pack <dir> --skill <dir>',
    '',
    'export: пак (glm-system.md + templates.json) → SKILL.md + supporting-файлы',
    'import: SKILL.md → пак (frontmatter отбрасывается, templates.json — стартовый)',
    'check : sync-guard — падает (exit 1) при дрейфе pack ↔ SKILL.md',
  ].join('\n');
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv: string[]): number {
  const cmd = argv[0];
  try {
    if (cmd === 'export') {
      const pack = argValue(argv, '--pack');
      const out = argValue(argv, '--out');
      const description = argValue(argv, '--description');
      if (!pack || !out) { console.error(usage()); return 1; }
      const r = exportPack(pack, out, description);
      console.log(`EXPORT-OK: ${r.skillPath} (name=${r.name}, templates-copied=${r.templatesCopied})`);
      console.log(`DESCRIPTION (${r.description.length}/${DESCRIPTION_MAX}): ${r.description}`);
      return 0;
    }
    if (cmd === 'import') {
      const skill = argValue(argv, '--skill');
      const out = argValue(argv, '--out');
      const name = argValue(argv, '--name');
      if (!skill || !out) { console.error(usage()); return 1; }
      const r = importSkill(skill, out, name);
      console.log(`IMPORT-OK: ${r.glmPath} + ${r.templatesPath}`);
      const fm = JSON.stringify(r.discardedFrontmatter);
      console.log(`FRONTMATTER-DISCARDED: ${fm}`);
      return 0;
    }
    if (cmd === 'check') {
      const pack = argValue(argv, '--pack');
      const skill = argValue(argv, '--skill');
      if (!pack || !skill) { console.error(usage()); return 1; }
      const r = checkSync(pack, skill);
      if (r.ok) {
        console.log('SYNC-GUARD: OK (pack ↔ SKILL.md парны)');
        return 0;
      }
      console.error('SYNC-GUARD: DRIFT');
      for (const i of r.issues) console.error('  - ' + i);
      return 1;
    }
    console.error(usage());
    return 1;
  } catch (e) {
    console.error('ОШИБКА: ' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }
}

if (process.argv[1] && /skillconv\.(js|ts)$/.test(process.argv[1].replace(/\\/g, '/'))) {
  process.exit(main(process.argv.slice(2)));
}
