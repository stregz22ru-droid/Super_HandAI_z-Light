// features.js — витрина «Система фич» (СИСТЕМА ФИЧ; app.js не тронут).
(function () {
  'use strict';

  const url = new URL(window.location.href);
  const token = url.searchParams.get('t') || '';
  const $ = (id) => document.getElementById(id);
  const q = (extra) => '?t=' + encodeURIComponent(token) + (extra || '');

  function msg(text, isErr) {
    const el = $('featuresMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'features-msg' + (isErr ? ' features-msg-err' : '');
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadFeatures() {
    try {
      const r = await fetch('/features' + q());
      if (r.status === 403) { msg('токен недействителен — откройте UI по ссылке с ?t=', true); return; }
      const data = await r.json();
      render(data.features || []);
      renderSubmodes(data.submodes || [], data.features || []);
      msg('');
    } catch (e) {
      msg('не удалось получить список фич: ' + e.message, true);
    }
  }

  // СИСТЕМА ФИЧ: one-click тумблеры подрежимов в OPERATOR-панели (topbar).
  // Подрежим = флаг config.features (напр. dry-run-active), действует сразу, без рестарта.
  function renderSubmodes(submodes, features) {
    const bar = $('submodeBar');
    if (!bar) return;
    bar.innerHTML = '';
    const byName = new Map((features || []).map((f) => [f.name, f]));
    for (const sm of submodes || []) {
      const parent = byName.get(sm.feature);
      const parentOff = !!parent && !parent.enabled;
      const btn = document.createElement('button');
      btn.className = 'submode-toggle' + (sm.enabled ? ' on' : '');
      btn.dataset.name = sm.name;
      btn.disabled = parentOff;
      // dry-run-active → метка «DRY-RUN» (суффикс -active — служебный)
      btn.textContent = sm.name.replace(/-active$/i, '').toUpperCase() + ': ' + (sm.enabled ? 'ON' : 'OFF');
      btn.title = sm.description + (parentOff ? ' (фича "' + sm.feature + '" выключена — включите её в таблице «Фичи» ниже)' : ' (клик — переключить; действует сразу, без рестарта)');
      btn.addEventListener('click', async () => {
        const target = !sm.enabled;
        btn.disabled = true;
        try {
          const r = await fetch('/features/toggle' + q(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: sm.name, enabled: target }),
          });
          const data = await r.json();
          if (data.ok) msg('✓ подрежим ' + sm.name + ' = ' + target + ' (действует сразу)');
          else msg('ошибка toggle подрежима: ' + (data.error || r.status), true);
        } catch (e) {
          msg('ошибка toggle подрежима: ' + e.message, true);
        }
        loadFeatures();
      });
      bar.appendChild(btn);
    }
  }

  function render(features) {
    const tbody = $('featuresBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (features.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5">фичи не найдены</td></tr>';
      return;
    }
    for (const f of features) {
      const tr = document.createElement('tr');
      const stateBadge = f.loaded ? '' : f.errors.length > 0 ? ' <span class="feat-err" title="' + esc(f.errors.join('; ')) + '">ошибка</span>' : ' <span class="feat-pending">после рестарта</span>';
      tr.innerHTML =
        '<td class="feat-name">' + esc(f.name) + (f.bundled ? ' <span class="feat-bundled" title="входит в поставку ядра — удаление запрещено">встроена</span>' : '') + stateBadge + '</td>' +
        '<td class="feat-desc">' + esc(f.description) + (f.slot && f.slot.length ? '<br><span class="feat-slots">слоты: ' + esc(f.slot.join(', ')) + '</span>' : '') + '</td>' +
        '<td class="feat-ver">' + esc(f.version) + '</td>' +
        '<td class="feat-toggle"><input type="checkbox" data-name="' + esc(f.name) + '" ' + (f.enabled ? 'checked' : '') + '/></td>' +
        '<td class="feat-del"><button class="feat-del-btn" data-name="' + esc(f.name) + '" ' + (f.bundled ? 'disabled title="bundled-фича не удаляется"' : 'title="удалить файл фичи"') + '>✖</button></td>';
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('input[type=checkbox]').forEach((box) => {
      box.addEventListener('change', async () => {
        const name = box.getAttribute('data-name');
        const enabled = box.checked;
        box.disabled = true;
        try {
          const r = await fetch('/features/toggle' + q(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, enabled }),
          });
          const data = await r.json();
          if (data.ok) msg('✓ ' + name + ' = ' + enabled + ' → ' + data.note);
          else msg('ошибка toggle: ' + (data.error || r.status), true);
        } catch (e) {
          msg('ошибка toggle: ' + e.message, true);
        }
        box.disabled = false;
        loadFeatures();
      });
    });
    tbody.querySelectorAll('.feat-del-btn:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.getAttribute('data-name');
        if (!confirm('Удалить фичу "' + name + '" с диска? (файл ' + name + '.feature.js)')) return;
        try {
          const r = await fetch('/features/' + encodeURIComponent(name) + q(), { method: 'DELETE' });
          const data = await r.json();
          if (data.ok) msg('✓ удалена: ' + name + ' → ' + data.note);
          else msg('ошибка удаления: ' + (data.error || r.status), true);
        } catch (e) {
          msg('ошибка удаления: ' + e.message, true);
        }
        loadFeatures();
      });
    });
  }

  async function uploadFeature(file) {
    if (!file) return;
    if (!file.name.endsWith('.feature.js')) {
      msg('файл должен иметь расширение .feature.js', true);
      return;
    }
    if (!confirm('Загрузить фичу "' + file.name + '"?\n\nВНИМАНИЕ: фичи исполняются с правами агента — не ставьте код из недоверенных источников.')) return;
    try {
      const buf = await file.arrayBuffer();
      const r = await fetch('/features/upload' + q('&filename=' + encodeURIComponent(file.name)), {
        method: 'POST',
        headers: { 'content-type': 'application/javascript' },
        body: buf,
      });
      const data = await r.json();
      if (data.ok) msg('✓ загружена: ' + data.name + ' v' + data.version + ' → ' + data.note);
      else msg('отклонено: ' + (data.error || r.status) + (data.issues ? '\n' + data.issues.join('\n') : ''), true);
    } catch (e) {
      msg('ошибка загрузки: ' + e.message, true);
    }
    loadFeatures();
  }

  const fileInput = $('featureFile');
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      uploadFeature(f);
    });
  }
  const upBtn = $('btnFeatureUpload');
  if (upBtn) upBtn.addEventListener('click', () => fileInput && fileInput.click());
  const reloadBtn = $('btnFeaturesReload');
  if (reloadBtn) reloadBtn.addEventListener('click', loadFeatures);

  loadFeatures();
})();
