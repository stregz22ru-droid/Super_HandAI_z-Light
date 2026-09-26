// test/skills-sync.test.ts — ЭТАП 1, МОДУЛЬ 3: sync-guard парности пак ↔ SKILL.md
// (по образцу openclaw-skills.test.js донора). Падает при дрейфе: если кто-то
// поправил skills/web-dev/SKILL.md или scilss_agent/packs/web-dev/* и не
// пересобрал конвертером — тест красный.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPack, importSkill, checkSync, parseSkillMd, deriveDescription, DESCRIPTION_MAX, renderSkillMd, readPack } from '../src/skillconv.js';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PACK_DIR = join(REPO, 'scilss_agent', 'packs', 'web-dev');
const SKILL_DIR = join(REPO, 'skills', 'web-dev');

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'shz-skill-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('МОДУЛЬ 3.1 — наш пак → SKILL.md', () => {
  it('exportPack: name = id пака, description ≤160, body дословно, templates.json рядом', () => {
    const out = join(tmp, 'web-dev');
    const r = exportPack(PACK_DIR, out);
    expect(r.name).toBe('web-dev');
    expect(r.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(r.templatesCopied).toBe(true);
    const parsed = parseSkillMd(readFileSync(r.skillPath, 'utf8'));
    expect(parsed.frontmatter['name']).toBe('web-dev');
    expect(parsed.frontmatter['description']).toBe(r.description);
    // body дословно (допускается только финальный перевод строки)
    const packBody = readFileSync(join(PACK_DIR, 'glm-system.md'), 'utf8');
    const norm = (s: string) => s.replace(/\n+$/, '\n');
    expect(norm(parsed.body)).toBe(norm(packBody));
    // supporting-файл — байт-в-байт
    expect(readFileSync(join(out, 'templates.json'), 'utf8')).toBe(
      readFileSync(join(PACK_DIR, 'templates.json'), 'utf8'),
    );
  });

  it('description по умолчанию берётся из H1 и проходит лимит 160', () => {
    const d = deriveDescription(readFileSync(join(PACK_DIR, 'glm-system.md'), 'utf8'));
    expect(d).toContain('постановщик ТЗ');
    expect(d.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
  });

  it('description >160 обрезается с многоточием', () => {
    const long = 'Слово '.repeat(60);
    const d = deriveDescription(long);
    expect(d.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(d.endsWith('…')).toBe(true);
  });
});

describe('МОДУЛЬ 3.2 — SKILL.md → наш пак', () => {
  it('importSkill: body → glm-system.md, frontmatter отброшен, templates.json — стартовый', () => {
    // готовим SKILL.md через export (честный цикл)
    const skillDir = join(tmp, 'skill');
    exportPack(PACK_DIR, skillDir);
    // и «чужой» SKILL.md с кастомным frontmatter
    const foreignDir = join(tmp, 'foreign');
    mkdirSync(foreignDir, { recursive: true });
    writeFileSync(
      join(foreignDir, 'SKILL.md'),
      ['---', 'name: foreign-skill', 'description: чужой скилл', 'license: MIT', 'argument-hint: что-то', '---', '', '# Заголовок', '', 'тело скилла'].join('\n'),
      'utf8',
    );
    const packDir = join(tmp, 'pack');
    const r = importSkill(join(foreignDir, 'SKILL.md'), packDir);
    expect(r.discardedFrontmatter['name']).toBe('foreign-skill');
    expect(r.discardedFrontmatter['argument-hint']).toBe('что-то'); // frontmatter вернули для журнала
    // body → glm-system.md дословно
    expect(readFileSync(r.glmPath, 'utf8')).toBe(['# Заголовок', '', 'тело скилла', ''].join('\n'));
    // стартовый templates.json
    const tpl = JSON.parse(readFileSync(r.templatesPath, 'utf8')) as { name: string; templates: unknown[] };
    expect(tpl.name).toBe('foreign-skill');
    expect(Array.isArray(tpl.templates)).toBe(true);
    expect(tpl.templates.length).toBe(0);
  });
});

describe('МОДУЛЬ 3.3 — sync-guard (дрейф ловится)', () => {
  it('репо: scilss_agent/packs/web-dev ↔ skills/web-dev ПАРНЫ (чек-пойнт дрейфа)', () => {
    const r = checkSync(PACK_DIR, SKILL_DIR);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('дрейф body → checkSync false', () => {
    const skillDir = join(tmp, 'skill');
    exportPack(PACK_DIR, skillDir);
    // правим пак-копию и SKILL.md по-разному
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, readFileSync(skillPath, 'utf8').replace('# Системный промпт', '# Дрейф'), 'utf8');
    const r = checkSync(PACK_DIR, skillDir);
    expect(r.ok).toBe(false);
    expect(r.issues.join('\n')).toContain('дрейф');
  });

  it('дрейф templates.json → checkSync false', () => {
    const skillDir = join(tmp, 'skill');
    exportPack(PACK_DIR, skillDir);
    writeFileSync(join(skillDir, 'templates.json'), '{"name":"web-dev","templates":[]}', 'utf8');
    const r = checkSync(PACK_DIR, skillDir);
    expect(r.ok).toBe(false);
    expect(r.issues.join('\n')).toContain('templates.json');
  });

  it('круговой цикл: export → import → glm-system.md совпадает', () => {
    const skillDir = join(tmp, 'skill');
    exportPack(PACK_DIR, skillDir);
    const pack2 = join(tmp, 'pack2');
    importSkill(join(skillDir, 'SKILL.md'), pack2, 'web-dev');
    const norm = (s: string) => s.replace(/\n+$/, '\n');
    expect(norm(readFileSync(join(pack2, 'glm-system.md'), 'utf8'))).toBe(
      norm(readFileSync(join(PACK_DIR, 'glm-system.md'), 'utf8')),
    );
  });

  it('renderSkillMd/readPack: id из templates.json, а не из имени каталога', () => {
    const dir = join(tmp, 'не-web-dev');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'glm-system.md'), '# Заголовок\n\nтело\n', 'utf8');
    writeFileSync(join(dir, 'templates.json'), '{"name":"other-id","templates":[]}', 'utf8');
    const pack = readPack(dir);
    expect(pack.id).toBe('other-id');
    const md = renderSkillMd(pack);
    expect(md.startsWith('---\nname: other-id\n')).toBe(true);
  });
});
