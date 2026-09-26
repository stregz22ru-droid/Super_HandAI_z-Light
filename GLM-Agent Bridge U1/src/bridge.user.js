// ==UserScript==
// @name         GLM-Agent Bridge U1
// @match        https://chat.z.ai/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==
// v3.3: кнопка «🧹 Очистить workspace» — POST /workspace/purge с токеном.
    <button id="export">⤓ Экспорт чата (Ctrl+A → Ctrl+C сначала)</button>
// Защита на сервере: активная задача блокирует очистку (409).
// v3.2: линтер — только RUN-скрипты; v3.1: каркасный детект; v3: cmView.
(() => {
  const AGENT = 'http://127.0.0.1:8787';
  const FILE_BASE = 'file:///C:/Super_HandAI_z/GLM-Agent%20Bridge%20U1/Temp/pack';

  // Токен агента: вводится один раз, хранится в GM. Берётся из URL агента (?t=...)
  let AGENT_TOKEN = GM_getValue('agentToken', '');
  async function ensureToken() {
    if (AGENT_TOKEN) return AGENT_TOKEN;
    const t = prompt('Токен агента (из URL агента: 127.0.0.1:8787/?t=...):');
    if (!t) throw new Error('токен не задан');
    AGENT_TOKEN = t.trim();
    GM_setValue('agentToken', AGENT_TOKEN);
    return AGENT_TOKEN;
  }

  const gmFetch = (url) => new Promise((res, rej) => GM_xmlhttpRequest({
    url, timeout: 3000,
    onload: r => (r.status === 200 && r.responseText) ? res(r.responseText) : rej(new Error('HTTP ' + r.status)),
    onerror: () => rej(new Error('network')),
    ontimeout: () => rej(new Error('timeout')),
  }));

  async function loadFile(name) {
    try { return await gmFetch(`${AGENT}/pack/${name}`); } catch {}
    try { return await gmFetch(`${FILE_BASE}/${name}`); } catch {}
    throw new Error('unavailable');
  }

  // --- панель в shadow DOM ---
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    #p{font:12px system-ui;background:#1e1f24;border:1px solid #444;border-radius:8px;padding:6px;width:230px;color:#ddd}
    button{display:block;width:100%;margin:3px 0;padding:5px 8px;border:0;border-radius:5px;background:#2d6cdf;color:#fff;cursor:pointer;text-align:left}
    button:hover{background:#3d7def}
    button.alt{background:#555}
    button.danger{background:#a33} button.danger:hover{background:#c44}
    #st{opacity:.6;padding:2px}</style>
    <div id="p"><div id="st">bridge: …</div><div id="b"></div>
    <button class="alt" id="sys">⤓ Системный промпт</button>
    <button class="alt" id="ctx">⤓ Контекст ОС</button>
    <button class="danger" id="purge">🧹 Очистить workspace</button></div>`;
  const $ = id => root.getElementById(id);

  // --- вставка в контролируемый инпут ---
  const inputEl = () => document.querySelector('[contenteditable="true"]')
    || [...document.querySelectorAll('textarea')].pop();
  function insert(text) {
    const el = inputEl();
    if (!el) { alert('Поле ввода не найдено'); return; }
    el.focus();
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch {}
    if (!ok) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (set) {
        set.call(el, (el.value || '') + text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        el.value += text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }

  // --- шаблоны ---
  async function apply(t, alt) {
    let text = t.text;
    const wantAsk = (t.mode === 'ask') !== alt;
    if (wantAsk) {
      for (const ph of [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))]) {
        let v = null;
        if (ph === 'CONTEXT') { try { v = await loadFile('context.txt'); } catch { v = ''; } }
        else v = window.prompt(`{{${ph}}}:`);
        if (v === null) break;
        text = text.replaceAll(`{{${ph}}}`, v);
      }
    }
    insert(text);
  }

  // --- чтение блока: cmView -> .cm-line -> textContent ---
  function scrollThrough(container) {
    try {
      const sc = container.querySelector('.cm-scroller');
      if (sc) { const y = sc.scrollTop; sc.scrollTop = sc.scrollHeight; sc.scrollTop = y; }
    } catch {}
  }
  function readViaCmView(container) {
    const content = container.querySelector('.cm-content');
    if (!content || !content.cmView) return null;
    try {
      const v = content.cmView.view || content.cmView;
      const doc = v.state && v.state.doc;
      if (doc && typeof doc.toString === 'function') {
        const t = doc.toString();
        if (t && t.length > 0) return t;
      }
    } catch {}
    return null;
  }
  function readViaLines(container) {
    const lines = container.querySelectorAll('.cm-line');
    if (lines.length > 0) return [...lines].map(l => l.textContent || '').join('\n');
    return null;
  }
  function readBlockText(container) {
    scrollThrough(container);
    return readViaCmView(container) || readViaLines(container) || container.textContent || '';
  }

  // --- нормализация ТЗ ---
  function extractTz(raw) {
    let s = String(raw).replace(/^\uFEFF/, '');
    const idx = s.search(/^#\s*ЗАДАЧ/m);
    if (idx > 0) s = s.slice(idx);
    else if (idx === -1) {
      s = s.replace(/^\s*(?:tz|markdown)?\s*\r?\n/, '');
    }
    return s.trim();
  }
  const isTz = s => /^#\s*ЗАДАЧ/.test(s)
    && /^#\s*META/m.test(s)
    && /^##\s*ШАГ/mi.test(s);

  // --- линтер: только RUN-скрипты (N17) ---
  const lint = s => {
    const e = [];
    if (!/^#\s*ЗАДАЧ/m.test(s)) e.push('нет # ЗАДАЧ');
    if (!/^##\s*ШАГ/mi.test(s)) e.push('нет шагов');
    const fences = (s.match(/^```/gm) || []).length;
    if (fences % 2 !== 0) e.push('нечётное число оградок — ТЗ оборвано?');
    const runBlocks = [...s.matchAll(/^RUN(_BG)?[^\n]*\n```[^\n]*\n([\s\S]*?)\n```/gmi)];
    for (const [idx, m] of runBlocks.entries()) {
      const script = m[2];
      const isBg = !!m[1];
      if (/%[\w]+%/.test(script)) e.push('RUN №' + (idx + 1) + ': %VAR% — cmd-синтаксис');
      if (/^\s*(mkdir -p|del |rd |copy )/m.test(script)) e.push('RUN №' + (idx + 1) + ': cmd-синтаксис не годится для pwsh');
      const isBash = /shell:\s*bash/i.test(m[0]);
      if (!isBash && /(^|\s)(grep|sed|awk|which)\s/.test(script)) e.push('RUN №' + (idx + 1) + ': POSIX-утилита — только shell: bash');
    }
    s.split(/^##\s*ШАГ/mi).slice(1).forEach((c, i) => {
      if (/^\s*RUN(_BG)?\b/m.test(c) && !/^\s*(EXPECT|WAIT)\b/m.test(c)) e.push('ШАГ ' + (i + 1) + ': RUN без EXPECT/WAIT');
    });
    return e;
  };

  // --- кнопка "⧉ ТЗ" ---
  function decorateBlock(langDiv) {
    if (langDiv.dataset.tzDone) return;
    const tz = extractTz(readBlockText(langDiv));
    if (!isTz(tz)) return;
    const hostEl = langDiv.closest('div.relative') || langDiv.parentElement;
    if (!hostEl) return;
    if (hostEl.querySelector('.tz-copy-btn')) { langDiv.dataset.tzDone = '1'; return; }
    langDiv.dataset.tzDone = '1';

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tz-copy-btn';
    b.textContent = '⧉ ТЗ';
    b.title = 'Копирует ПОЛНЫЙ текст ТЗ (CodeMirror state)';
    b.style.cssText = 'position:absolute;top:4px;right:8px;z-index:50;padding:3px 10px;border:0;border-radius:5px;background:#2d6cdf;color:#fff;cursor:pointer;font:12px system-ui;box-shadow:0 1px 4px rgba(0,0,0,.4)';
    b.onclick = async (ev) => {
      ev.stopPropagation(); ev.preventDefault();
      const fresh = extractTz(readBlockText(langDiv));
      if (!isTz(fresh)) { alert('Блок больше не похож на ТЗ'); return; }
      if (fresh.length > 2000 && !confirm('Длинное ТЗ (' + fresh.length + ' символов).\nНачало: "' + (fresh.split('\n')[0] || '').slice(0, 60) + '"\nПродолжить копирование?')) return;
      const errs = lint(fresh);
      if (errs.length && !confirm('Замечания:\n- ' + errs.join('\n- ') + '\n\nВсё равно копировать?')) return;
      await GM_setClipboard(fresh);
      b.textContent = '✓ ' + fresh.length;
      setTimeout(() => b.textContent = '⧉ ТЗ', 1200);
    };
    hostEl.style.position = hostEl.classList.contains('relative') ? hostEl.style.position : 'relative';
    hostEl.appendChild(b);
  }

  function scanAll() {
    document.querySelectorAll('.markdown-prose div[class*="language-"]').forEach(decorateBlock);
    document.querySelectorAll('pre code').forEach(code => {
      const pre = code.parentElement;
      if (!pre || pre.dataset.tzDone) return;
      const tz = extractTz(code.textContent || '');
      if (!isTz(tz)) return;
      pre.dataset.tzDone = '1';
      pre.style.position = 'relative';
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tz-copy-btn';
      b.textContent = '⧉ ТЗ';
      b.style.cssText = 'position:absolute;top:4px;right:4px;z-index:50;padding:3px 10px;border:0;border-radius:5px;background:#2d6cdf;color:#fff;cursor:pointer;font:12px system-ui';
      b.onclick = async () => {
        await GM_setClipboard(extractTz(code.textContent || ''));
        b.textContent = '✓'; setTimeout(() => b.textContent = '⧉ ТЗ', 900);
      };
      pre.appendChild(b);
    });
  }

  new MutationObserver(() => scanAll()).observe(document.body, { childList: true, subtree: true });
  scanAll();

  // --- очистка workspace (N18) ---
  $('purge').onclick = async () => {
    if (!confirm('Удалить ВСЕ папки в workspace?\nНеобратимо. Активная задача заблокирует очистку.')) return;
    if (!confirm('Точно? Последнее предупреждение.')) return;
    try {
      const t = await ensureToken();
      const r = await new Promise((res, rej) => GM_xmlhttpRequest({
        url: AGENT + '/workspace/purge?t=' + encodeURIComponent(t),
        method: 'POST', timeout: 10000,
        onload: x => res({ status: x.status, body: x.responseText }),
        onerror: () => rej(new Error('агент недоступен')),
        ontimeout: () => rej(new Error('таймаут')),
      }));
      if (r.status === 200) {
        const j = JSON.parse(r.body);
        alert('Очищено: ' + j.removed + ' папок');
      } else if (r.status === 409) {
        const j = JSON.parse(r.body);
        alert('Отклонено: ' + j.error);
      } else if (r.status === 403) {
        alert('Токен неверен. Обнови: GM-меню → сбрось agentToken (через повтор кнопки после очистки хранилища) или впиши заново.');
        GM_setValue('agentToken', '');
      } else {
        alert('HTTP ' + r.status + ': ' + r.body.slice(0, 200));
      }
    } catch (e) {
      alert('Ошибка: ' + e.message + '\n(агент запущен?)');
    }
  };

  // --- нижние кнопки + шаблоны ---
  let sys = '', ctx = '';
  $('ctx').onclick = () => ctx ? insert(ctx) : alert('context.txt не загружен');
  $('sys').onclick = () => sys ? insert(sys) : alert('glm-system.md не загружен');

  function renderTemplates(tpl) {
    $('b').innerHTML = '';
    for (const t of tpl.templates) {
      const b = document.createElement('button');
      b.textContent = (t.hotkey ? '[' + t.hotkey.replace('alt', '⎇') + '] ' : '') + t.label;
      b.title = 'Клик — режим шаблона; Alt+клик — инверсия подстановки';
      b.onclick = e => apply(t, e.altKey);
      $('b').appendChild(b);
    }
  }

  (async () => {
    try {
      const tpl = JSON.parse(await loadFile('templates.json'));
      sys = await loadFile('glm-system.md').catch(() => '');
      ctx = await loadFile('context.txt').catch(() => '');
      GM_setValue('lastTemplates', tpl); GM_setValue('lastSys', sys); GM_setValue('lastCtx', ctx);
      $('st').textContent = 'bridge: ' + tpl.name + ' · ' + tpl.templates.length + ' шабл. (агент)';
      renderTemplates(tpl);
    } catch {
      const tpl = GM_getValue('lastTemplates', null);
      sys = GM_getValue('lastSys', ''); ctx = GM_getValue('lastCtx', '');
      if (tpl) {
        $('st').textContent = 'bridge: ' + tpl.name + ' (кэш) · ' + tpl.templates.length + ' шабл.';
        renderTemplates(tpl);
      } else {
        $('st').textContent = 'bridge: пак недоступен (агент запущен?)';
      }
    }
  })();
})();
