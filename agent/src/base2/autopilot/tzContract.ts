// base2/autopilot/tzContract.ts — B2: КОНТРАКТ распознавания ТЗ в ответе GLM.
// Формат фиксируется ДО начала работ (требование ТЗ) и больше не меняется:
//
//   1) ТЗ — контейнер ИЗ ЧЕТЫРЁХ бэктиков: ````shai-tz ... ````. Четыре бэктика —
//      стандартное markdown-вложение: внутренние фенсы ТЗ (```bash, ```pwsh —
//      3 бэктика, требуются форматом ТЗ для RUN-блоков) НЕ закрывают контейнер.
//   2) Контрактное поле завершения — строка `complete: true` (регистро-
//      независимо) ПЕРВОЙ непустой строкой внутри блока, ЛИБО отдельный
//      маркер вне блока: <!--SHAI:AUTOPILOT:COMPLETE-->.
//   3) Всё вне блока — свободный текст: подстроки вида «задача завершена»
//      там НЕ распознаются (стоп только по контрактному полю — не подстрочный
//      поиск; критерий B3).
//   4) Дедуп — sha256 нормализованного текста ТЗ.
//
// Валидация содержимого — штатным parser'ом ядра (parseTz), правила приёмки —
// общий validateTzText из taskService (один билдер правил, Ponytail).
import { createHash } from 'node:crypto';
import { validateTzText } from '../taskService.js';

export const TZ_FENCE = 'shai-tz';
export const COMPLETE_MARKER = '<!--SHAI:AUTOPILOT:COMPLETE-->';

export interface TzContractRefusal {
  code:
    | 'multi-block'
    | 'empty-block'
    | 'complete-without-tz-not-allowed'
    | 'invalid-tz'
    | 'complete-inside-and-outside';
  message: string;
}

export interface ExtractResult {
  blockFound: boolean;
  /** true — только контрактное поле завершения (без ТЗ). */
  complete: boolean;
  tzText?: string;
  rawBlock?: string;
  refusal?: TzContractRefusal;
}

// Контейнер из 4 бэктиков: внутренние 3-бэктиковые фенсы ТЗ его не закрывают.
const FENCE_RE = /^````[ \t]*shai-tz[ \t]*\r?\n([\s\S]*?)\n[ \t]*````[ \t]*$/gm;
const COMPLETE_FIRST_RE = /^complete\s*:\s*true\s*$/i;

/** Нормализация текста ТЗ для дедупа: CRLF→LF, схлопывание пустых строк, trim. */
export function normalizeTz(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Отпечаток ТЗ для дедупа: sha256 нормализованного текста. */
export function tzFingerprint(text: string): string {
  return createHash('sha256').update(normalizeTz(text), 'utf8').digest('hex');
}

/** Извлечение контракта из ответа GLM. Ничего не запускает, ничего не журналирует —
 *  чистая функция (журналирование отказов — в bridgeIn). */
export function extractContract(answerText: string): ExtractResult {
  const text = String(answerText ?? '');
  FENCE_RE.lastIndex = 0;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) blocks.push(m[1]);

  const markerOutside = text.includes(COMPLETE_MARKER);

  if (blocks.length === 0) {
    // Маркер завершения может прийти и БЕЗ блока (петля закрывается в успехе).
    if (markerOutside) return { blockFound: false, complete: true };
    return { blockFound: false, complete: false };
  }
  if (blocks.length > 1) {
    return {
      blockFound: true,
      complete: false,
      refusal: { code: 'multi-block', message: `найдено ${blocks.length} блоков shai-tz — контракт допускает ровно один` },
    };
  }

  const rawBlock = blocks[0];
  let inner = normalizeTz(rawBlock);
  let completeInside = false;
  const innerLines = inner.split('\n');
  if (COMPLETE_FIRST_RE.test((innerLines[0] ?? '').trim())) {
    completeInside = true;
    inner = normalizeTz(innerLines.slice(1).join('\n'));
  }
  const complete = completeInside || markerOutside;
  if (completeInside && markerOutside) {
    return {
      blockFound: true,
      complete: true,
      rawBlock,
      refusal: { code: 'complete-inside-and-outside', message: 'контрактное поле завершения указано и в блоке, и маркером — оставь что-то одно' },
    };
  }
  if (!complete && inner === '') {
    return { blockFound: true, complete: false, rawBlock, refusal: { code: 'empty-block', message: 'блок shai-tz пуст' } };
  }
  if (complete && inner !== '') {
    return {
      blockFound: true,
      complete: true,
      rawBlock,
      refusal: { code: 'complete-without-tz-not-allowed', message: 'complete:true несовместим с текстом ТЗ в том же блоке' },
    };
  }
  if (complete) {
    // inner === '' — чистое контрактное завершение
    return { blockFound: true, complete: true, rawBlock };
  }
  return { blockFound: true, complete: false, tzText: inner, rawBlock };
}

/** Полная приёмка ТЗ из блока: контракт → штатный parser ядра. */
export function validateContractTz(tzText: string): { ok: true } | { ok: false; refusal: TzContractRefusal } {
  const v = validateTzText(tzText);
  if (v.ok) return { ok: true };
  return { ok: false, refusal: { code: 'invalid-tz', message: v.error } };
}
