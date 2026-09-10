#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Super_HandAI_z deny-tests — runner (zero-dependency, Node ≥ 18)
//
// Режимы:
//   node run.mjs                          — AUDIT: markdown-отчёт по корпусу
//                                           (для человека / разработчика guard-а)
//   node run.mjs --adapter ./adapter.mjs  — TEST: прогон корпуса через
//                                           deny-чек вашего агента
//   node run.mjs --adapter ... --json     — машиночитаемый результат (для CI)
//
// Exit codes: 0 — всё ок / аудит; 1 — есть проваленные кейсы; 2 — ошибка запуска.
// ═══════════════════════════════════════════════════════════════════
import { cases } from './cases.mjs';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const args = process.argv.slice(2);
const adapterIdx = args.indexOf('--adapter');
const adapterPath = adapterIdx >= 0 ? args[adapterIdx + 1] : null;
const asJson = args.includes('--json');

// ── валидация корпуса ──────────────────────────────────────────────
const ids = new Set();
const VALID_SHELL = new Set(['pwsh', 'bash', 'cmd']);
const VALID_EXPECT = new Set(['blocked', 'flagged', 'allowed']);
for (const c of cases) {
  if (ids.has(c.id)) fail(`дубль id: ${c.id}`);
  ids.add(c.id);
  if (!VALID_SHELL.has(c.shell)) fail(`${c.id}: плохой shell "${c.shell}"`);
  if (!VALID_EXPECT.has(c.expect)) fail(`${c.id}: плохой expect "${c.expect}"`);
  if (!c.cmd || !c.why) fail(`${c.id}: пусто cmd/why`);
}
function fail(msg) { console.error(`✗ CORPUS: ${msg}`); process.exit(2); }

const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'NONE'];
const byCat = [...new Set(cases.map(c => c.cat))];

// ── AUDIT-режим ────────────────────────────────────────────────────
if (!adapterPath) {
  const lines = [];
  lines.push(`# Deny-tests — аудит-отчёт (${cases.length} кейсов)\n`);
  const stats = {};
  for (const c of cases) stats[c.sev] = (stats[c.sev] || 0) + 1;
  lines.push('Состав: ' + order.filter(s => stats[s]).map(s => `${s}: ${stats[s]}`).join(' · ') + '\n');
  for (const cat of byCat) {
    const group = cases.filter(c => c.cat === cat)
      .sort((a, b) => order.indexOf(a.sev) - order.indexOf(b.sev));
    lines.push(`\n## ${cat.toUpperCase()} (${group.length})\n`);
    lines.push('| id | shell | sev | ожидание | команда | почему это обход |');
    lines.push('|---|---|---|---|---|---|');
    for (const c of group) {
      lines.push(`| \`${c.id}\` | ${c.shell} | ${c.sev} | ${c.expect} | \`${c.cmd.replace(/\|/g, '\\|')}\` | ${c.why} |`);
    }
  }
  const out = lines.join('\n');
  if (asJson) console.log(JSON.stringify({ mode: 'audit', total: cases.length, cases }, null, 2));
  else console.log(out);
  process.exit(0);
}

// ── TEST-режим ─────────────────────────────────────────────────────
let denyCheck;
try {
  const mod = await import(pathToFileURL(adapterPath).href);
  denyCheck = mod.denyCheck ?? mod.default?.denyCheck ?? mod.default;
  if (typeof denyCheck !== 'function') throw new Error('нет экспорта denyCheck({command, shell})');
} catch (e) {
  console.error(`✗ ADAPTER: ${e.message}`);
  process.exit(2);
}

const results = [];
for (const c of cases) {
  let verdict = 'error', reason = '';
  try {
    const r = await denyCheck({ command: c.cmd, shell: c.shell, meta: { cat: c.cat, sev: c.sev } });
    verdict = (r && r.verdict) || 'error';
    reason = (r && r.reason) || '';
  } catch (e) { reason = `adapter threw: ${e.message}`; }
  const ok = verdict === c.expect
    || (c.expect === 'flagged' && verdict === 'blocked'); // блокировать строже flagged — можно
  results.push({ id: c.id, sev: c.sev, cat: c.cat, expect: c.expect, verdict, ok, reason, cmd: c.cmd });
}

const failed = results.filter(r => !r.ok);
const verdictRu = { blocked: 'BLOCKED', flagged: 'FLAGGED', allowed: 'ALLOWED', error: 'ERROR' };

if (asJson) {
  console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results }, null, 2));
} else {
  console.log(`\n═══ deny-tests: ${results.length - failed.length}/${results.length} passed ═══\n`);
  for (const cat of byCat) {
    const group = results.filter(r => r.cat === cat);
    if (!group.length) continue;
    console.log(`── ${cat} ──`);
    for (const r of group) {
      const mark = r.ok ? '✓' : '✗';
      console.log(`${mark} ${r.id.padEnd(28)} expect=${verdictRu[r.expect]} got=${verdictRu[r.verdict]}${r.ok ? '' : '  ← ' + (r.reason || '')}`);
    }
    console.log('');
  }
  if (failed.length) {
    console.log('═══ ПРОВАЛЫ (деньги на стол) ═══');
    for (const r of failed.filter(f => f.sev === 'CRITICAL')) console.log(`🚨 CRITICAL ${r.id}: ${r.cmd}`);
    for (const r of failed.filter(f => f.sev === 'HIGH')) console.log(`🔥 HIGH     ${r.id}: ${r.cmd}`);
    for (const r of failed.filter(f => f.sev === 'MEDIUM')) console.log(`⚠️  MEDIUM   ${r.id}: ${r.cmd}`);
    for (const r of failed.filter(f => f.sev === 'NONE')) console.log(`🧪 CONTROL  ${r.id}: ${r.cmd}`);
  }
}
process.exit(failed.length ? 1 : 0);
