// app.js — клиент Super_HandAI_z (xterm@5 API)
(function () {
  'use strict';

  const url = new URL(window.location.href);
  const token = url.searchParams.get('t') || '';

  document.querySelectorAll('link[href*="TOKEN"], script[src*="TOKEN"]').forEach((el) => {
    const attr = el.tagName === 'LINK' ? 'href' : 'src';
    const v = el.getAttribute(attr);
    if (v) el.setAttribute(attr, v.replace('TOKEN', encodeURIComponent(token)));
  });

  const $ = (id) => document.getElementById(id);

  const term = new window.Terminal({
    cols: 100,
    rows: 28,
    fontFamily: 'SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#0c0d10', foreground: '#e6e6e6' },
  });
  term.open($('term'));

  term.onData((data) => {
    send({ type: 'pty.write', data, task: state.taskId });
  });

  const wsUrl = `ws://${window.location.host}/ws`;
  let ws = null;
  let connectPromise = null;

  function connect() {
    if (connectPromise) return connectPromise;
    connectPromise = new Promise((resolve, reject) => {
      const sock = new WebSocket(wsUrl);
      ws = sock;
      sock.onopen = () => {
        sock.send(JSON.stringify({ type: 'auth', token }));
        connectPromise = null;
        resolve(sock);
      };
      sock.onerror = (e) => {
        connectPromise = null;
        reject(e);
      };
      sock.onclose = () => {
        connectPromise = null;
        ws = null;
        setStatus('соединение закрыто');
      };
      sock.onmessage = (ev) => {
        let msg = null;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        handleMessage(msg);
      };
    });
    return connectPromise;
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  const state = {
    taskId: null,
    steps: [],
    status: 'idle',
    pendingConfirm: null,
  };

  function setStatus(s) {
    $('status').textContent = s;
  }

  function renderSteps() {
    const ol = $('steps');
    ol.innerHTML = '';
    state.steps.forEach((s) => {
      const li = document.createElement('li');
      li.className = `step step-${s.state}`;
      li.innerHTML = `<span class="dot"></span><span class="num">${s.i}.</span> <span class="t">${escapeHtml(
        s.title,
      )}</span>${s.state ? ` <span class="state">${s.state}</span>` : ''}${
        s.ms ? ` <span class="ms">${(s.ms / 1000).toFixed(2)}s</span>` : ''
      }`;
      ol.appendChild(li);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'task.accepted': {
        state.taskId = msg.taskId;
        state.steps = msg.steps.map((s) => ({ ...s, state: '' }));
        renderSteps();
        setStatus(`задача: ${state.taskId} — шагов: ${state.steps.length}`);
        break;
      }
      case 'step.status': {
        const i = msg.i;
        if (i >= 1 && i <= state.steps.length) {
          state.steps[i - 1].state = msg.state;
          if (msg.ms !== undefined) state.steps[i - 1].ms = msg.ms;
          renderSteps();
          if (msg.state === 'run') {
            setStatus(`шаг ${i}/${state.steps.length} — ${state.steps[i - 1].title}`);
          } else if (msg.state === 'fail') {
            setStatus(`шаг ${i} — FAIL: ${msg.msg || ''}`);
          } else if (msg.state === 'denied') {
            setStatus(`шаг ${i} — DENIED: ${msg.msg || ''}`);
          }
        }
        break;
      }
      case 'pty.data': {
        term.write(msg.data);
        break;
      }
      case 'task.done': {
        $('report').value = msg.reportMd;
        setStatus(`готово: ${msg.status}`);
        state.taskId = null;
        break;
      }
      case 'lint.result': {
        const issues = msg.issues || [];
        if (issues.length > 0) {
          const txt = issues
            .map((i) => `[${i.level}] line ${i.line}: ${i.msg}`)
            .join('\n');
          term.write(`\x1b[33mЛинт:\n${txt}\x1b[0m\r\n`);
        }
        break;
      }
      case 'confirm.request': {
        state.pendingConfirm = msg.id;
        $('confirmText').textContent = msg.text;
        $('confirm').classList.remove('hidden');
        break;
      }
      case 'error': {
        term.write(`\x1b[31m[error] ${msg.msg || ''}\x1b[0m\r\n`);
        break;
      }
      default:
        break;
    }
  }

  // --- Кнопки ---
  $('btnRun').onclick = async () => {
    const tzText = $('tzText').value;
    if (!tzText.trim()) {
      alert('Вставьте ТЗ в поле выше');
      return;
    }
    await connect();
    send({ type: 'task.start', tzText });
    $('report').value = '';
    setStatus('старт...');
  };

  $('btnStop').onclick = () => send({ type: 'task.stop' });

  // Долг N7: Вставить из буфера — замена содержимого поля.
  $('btnPaste').onclick = async () => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      alert('Браузер не дал доступ к буферу. Используй Ctrl+V в поле.');
      return;
    }
    if (!text || !text.trim()) {
      alert('Буфер обмена пуст');
      return;
    }
    const el = $('tzText');
    if (el.value.trim() && !confirm('Поле непустое — заменить целиком содержимым буфера?')) return;
    el.value = text;
    el.focus();
  };

  $('btnCopy').onclick = async () => {
    const txt = $('report').value;
    if (!txt) {
      alert('Отчёт пуст');
      return;
    }
    try {
      await navigator.clipboard.writeText(txt);
      const btn = $('btnCopy');
      const prev = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => (btn.textContent = prev), 900);
    } catch {
      $('report').select();
      document.execCommand('copy');
    }
  };

  $('confirmOk').onclick = () => {
    if (state.pendingConfirm) {
      send({ type: 'confirm.answer', id: state.pendingConfirm, answer: true });
      state.pendingConfirm = null;
      $('confirm').classList.add('hidden');
    }
  };
  $('confirmCancel').onclick = () => {
    if (state.pendingConfirm) {
      send({ type: 'confirm.answer', id: state.pendingConfirm, answer: false });
      state.pendingConfirm = null;
      $('confirm').classList.add('hidden');
    }
  };

  connect().catch(() => setStatus('не удалось подключиться'));

  window.addEventListener('resize', () => {
    try {
      term.fit && term.fit();
    } catch {
      // ignore
    }
  });
})();