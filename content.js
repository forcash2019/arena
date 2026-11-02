// MCP Bridge for Arena - content script. Runs on arena.ai / lmarena.ai.
(() => {
  if (window.__mcpBridgeLoaded) return;
  window.__mcpBridgeLoaded = true;
  const L = MCPLib;

  const state = {
    servers: [], tools: new Map(), status: {},
    auto: false, autoSend: false, primed: false, href: location.href, open: false, msg: '',
  };

  const bg = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => {
    if (chrome.runtime.lastError) res({ ok: false, error: chrome.runtime.lastError.message });
    else res(r || { ok: false, error: 'no response from extension' });
  }));

  const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'checked') e.checked = !!v;
      else if (v !== undefined && v !== null) e.setAttribute(k, v);
    }
    for (const c of kids.flat()) { if (c == null || c === false) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); }
    return e;
  };

  // ---------- storage / servers ----------
  async function loadSettings() {
    const s = await chrome.storage.local.get({ servers: [], auto: false, autoSend: false });
    state.servers = s.servers; state.auto = s.auto; state.autoSend = s.autoSend;
  }
  async function saveSettings() {
    await chrome.storage.local.set({ servers: state.servers, auto: state.auto, autoSend: state.autoSend });
  }
  async function refreshTools() {
    state.tools = new Map(); state.status = {};
    for (const url of state.servers) {
      state.status[url] = { loading: true }; render();
      const r = await bg({ type: 'MCP_LIST', url });
      if (r.ok) {
        state.status[url] = { ok: true, count: r.tools.length };
        for (const t of r.tools) if (!state.tools.has(t.name)) state.tools.set(t.name, { server: url, def: t });
      } else state.status[url] = { ok: false, error: r.error };
    }
    render();
  }

  // ---------- composer helpers ----------
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 10 && getComputedStyle(el).visibility !== 'hidden'; };
  function findComposer() {
    const c = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]')]
      .filter((e) => !host.contains(e) && !e.readOnly && visible(e));
    if (!c.length) return null;
    if (document.activeElement && c.includes(document.activeElement)) return document.activeElement;
    return c.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  }
  const isComposer = (el) => el && (el.tagName === 'TEXTAREA' || el.isContentEditable || el.getAttribute('role') === 'textbox') && !host.contains(el);
  const getText = (el) => (el.tagName === 'TEXTAREA' ? el.value : el.innerText || '');
  function setTextarea(el, v) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function clearComposer(el) {
    if (el.tagName === 'TEXTAREA') setTextarea(el, '');
    else { el.focus(); document.execCommand('selectAll'); document.execCommand('delete'); }
  }
  function appendToComposer(text) {
    const el = findComposer();
    if (!el) { note('Не нашёл поле ввода чата'); return false; }
    el.focus();
    if (el.tagName === 'TEXTAREA') { const cur = el.value; setTextarea(el, cur ? cur + '\n\n' + text : text); }
    else { const sel = getSelection(); sel.selectAllChildren(el); sel.collapseToEnd(); document.execCommand('insertText', false, text); }
    return true;
  }
  function sendComposer() {
    const el = findComposer();
    const btn = [...document.querySelectorAll('button')].find((b) => !host.contains(b) && !b.disabled &&
      /send|submit|отправ/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.title || '')))
      || (el && el.closest('form') && el.closest('form').querySelector('button[type=submit]:not([disabled])'));
    if (btn) btn.click();
    else if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  }

  // ---------- commands typed in the chat box ----------
  async function runCommand(cmd) {
    if (cmd.cmd === 'tools') {
      if (!state.tools.size) { note('Нет подключённых инструментов. Наберите: /c http://localhost:3000/sse'); return; }
      appendToComposer(L.buildPrompt([...state.tools.values()].map((t) => t.def))); note('Инструкции вставлены в чат'); return;
    }
    if (!cmd.url) { note('Не вижу URL. Пример: /c http://localhost:3000/sse'); return; }
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(cmd.url)) { note('Разрешены только http://localhost и 127.0.0.1'); return; }
    if (!state.servers.includes(cmd.url)) { state.servers.push(cmd.url); await saveSettings(); }
    note('Подключаюсь к ' + cmd.url + ' ...'); setOpen(true);
    await refreshTools();
    const st = state.status[cmd.url];
    if (st && st.ok) {
      note('Подключено, инструментов: ' + st.count + '. Инструкции вставлены в поле чата - отправьте их модели.');
      appendToComposer(L.buildPrompt([...state.tools.values()].filter((t) => t.server === cmd.url).map((t) => t.def)));
    } else note('Ошибка: ' + ((st && st.error) || 'неизвестная'));
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || !isComposer(e.target)) return;
    const cmd = L.parseCommand(getText(e.target));
    if (!cmd) return;
    e.preventDefault(); e.stopImmediatePropagation();
    clearComposer(e.target);
    runCommand(cmd);
  }, true);

  // ---------- helpers for detecting assistant messages ----------
  function findMessageContainer(el) {
    let node = el, depth = 0;
    while (node && node.parentElement && depth < 20) {
      if (node.parentElement.getAttribute && node.parentElement.getAttribute('data-perf-target') === 'transcript') return node;
      node = node.parentElement; depth++;
    }
    return null;
  }
  function isAssistantMessage(container) {
    return !!container && !/justify-end/.test(container.className || '');
  }
  async function execCall(card) {
    const args = L.coerceArgs(card.call.rawParams, card.tool.def.inputSchema);
    const r = await bg({ type: 'MCP_CALL', url: card.tool.server, name: card.call.name, args });
    card.status = r.ok && !r.isError ? 'done' : 'error';
    card.result = r.ok ? r.text : r.error;
    return card;
  }

  // ---------- detecting tool calls in model answers (inline cards) ----------
  function scan() {
    if (location.href !== state.href) { state.href = location.href; state.primed = false; }

    document.querySelectorAll('pre.shiki-code-block:not([data-mcp-scanned])').forEach((pre) => {
      pre.setAttribute('data-mcp-scanned', '1');

      const container = findMessageContainer(pre);
      if (!isAssistantMessage(container)) return;

      const text = pre.innerText;
      if (!text.includes('<function_calls>')) return;

      const calls = L.parseFunctionCalls(text);
      if (!calls.length || !state.primed) return;

      const anchor = pre.closest('[data-code-block="true"]') || pre;
      let insertAfter = anchor;

      calls.forEach((c) => {
        const tool = state.tools.get(c.name);
        if (!tool) return;
        const card = { call: c, tool, status: 'pending', result: '' };
        const wrap = renderInlineCard(card);
        insertAfter.insertAdjacentElement('afterend', wrap);
        insertAfter = wrap;
      });
    });

    state.primed = true;
    render();
  }
  new MutationObserver(() => setTimeout(scan, 1500))
    .observe(document.body, { childList: true, subtree: true, characterData: true });
  setTimeout(scan, 2500);

  // ---------- inline card (rendered right under the code block in the answer) ----------
  function renderInlineCard(card) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin:8px 0;';
    const root = wrap.attachShadow({ mode: 'open' });

    const css = document.createElement('style');
    css.textContent = `
      .card{border:1px solid #30363d;border-radius:10px;background:#1e2126;color:#e6edf3;
        font:13px system-ui,sans-serif;padding:10px 12px;}
      .title{color:#58a6ff;font-weight:700;margin-bottom:2px}
      .desc{color:#9aa4b2;font-size:12px;margin-bottom:8px}
      button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 14px;
        font-weight:600;cursor:pointer;margin-right:6px}
      button:disabled{opacity:.6;cursor:default}
      button.g{background:#30363d}
      pre.res{white-space:pre-wrap;word-break:break-word;background:#0d1117;border-radius:6px;
        padding:8px;margin-top:8px;font-size:12px;max-height:240px;overflow:auto}
      .status{font-size:12px;margin-left:4px;color:#9aa4b2}
      .bad{color:#f85149}
    `;
    root.append(css);

    const box = document.createElement('div');
    box.className = 'card';
    root.append(box);

    function paint() {
      box.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = card.call.name;
      box.append(title);

      if (card.call.description) {
        const d = document.createElement('div');
        d.className = 'desc';
        d.textContent = card.call.description;
        box.append(d);
      }

      const runBtn = document.createElement('button');
      runBtn.textContent = (card.status === 'done' || card.status === 'error') ? '↻ Run again' : '▶ Run';
      runBtn.disabled = card.status === 'running';
      runBtn.onclick = async () => {
        card.status = 'running'; paint();
        await execCall(card);
        paint();
        if (state.autoSend) {
          const formatted = L.formatResult(card.call.callId, card.call.name, card.result, card.status === 'error');
          if (appendToComposer(formatted)) setTimeout(sendComposer, 400);
        }
      };
      box.append(runBtn);

      if (card.status === 'running') {
        const s = document.createElement('span');
        s.className = 'status'; s.textContent = '⏳ выполняется...';
        box.append(s);
      }

      if (card.result) {
        const pre = document.createElement('pre');
        pre.className = 'res' + (card.status === 'error' ? ' bad' : '');
        pre.textContent = card.result;
        box.append(pre);

        const insertBtn = document.createElement('button');
        insertBtn.className = 'g';
        insertBtn.textContent = '➡ Insert';
        insertBtn.onclick = () => {
          const formatted = L.formatResult(card.call.callId, card.call.name, card.result, card.status === 'error');
          appendToComposer(formatted);
        };
        box.append(insertBtn);
      }
    }

    paint();
    return wrap;
  }

  // ---------- floating panel (shadow DOM so Arena styles can't break it) ----------
  const host = h('div', { id: 'mcp-bridge-host' });
  host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;font:13px system-ui,sans-serif;';
  const root = host.attachShadow({ mode: 'open' });
  const css = document.createElement('style');
  css.textContent = `
    .fab{background:#0284c7;color:#fff;border:0;border-radius:20px;padding:8px 14px;font-weight:700;cursor:pointer;box-shadow:0 4px 14px #0006}
    .panel{position:absolute;bottom:44px;right:0;width:360px;max-height:70vh;overflow:auto;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:12px;padding:12px;box-shadow:0 12px 30px #0008}
    h4{margin:0 0 8px;color:#38bdf8;font-size:13px} .row{display:flex;gap:6px;align-items:center;margin:4px 0}
    .dim{color:#94a3b8;font-size:12px} .ok{color:#34d399} .bad{color:#f87171} .warn{color:#fbbf24}
    button.b{background:#0284c7;color:#fff;border:0;border-radius:6px;padding:5px 10px;cursor:pointer;font-weight:600}
    button.b.g{background:#334155}
    label{display:flex;gap:6px;align-items:center;margin:4px 0}`;
  root.append(css);
  const fab = h('button', { class: 'fab', onclick: () => setOpen(!state.open) }, 'MCP');
  const panel = h('div', { class: 'panel' });
  root.append(fab, panel);
  document.documentElement.appendChild(host);

  function setOpen(v) { state.open = v; render(); }
  function note(m) { state.msg = m; render(); }

  function render() {
    panel.style.display = state.open ? 'block' : 'none';
    fab.textContent = 'MCP' + (state.tools.size ? ' · ' + state.tools.size : '');
    if (!state.open) return;
    panel.replaceChildren(h('div', {},
      h('h4', {}, 'MCP Bridge'),
      h('div', { class: 'dim' }, 'В поле чата наберите: /c http://localhost:3000/sse  (Enter). /tools - вставить инструкции повторно.'),
      state.msg && h('div', { class: 'warn', style: 'margin:6px 0' }, state.msg),
      h('div', { style: 'margin-top:8px' }, 'Серверы:'),
      !state.servers.length && h('div', { class: 'dim' }, 'нет - добавьте командой /c'),
      state.servers.map((u) => {
        const s = state.status[u] || {};
        return h('div', { class: 'row' },
          h('span', { style: 'flex:1;word-break:break-all' }, u),
          s.loading ? h('span', { class: 'warn' }, '...') : s.ok ? h('span', { class: 'ok' }, s.count + ' tools') : h('span', { class: 'bad', title: s.error || '' }, 'ошибка'));
      }),
      Object.values(state.status).filter((s) => s.error).map((s) => h('div', { class: 'bad dim' }, s.error)),
      h('div', { class: 'row' },
        h('button', { class: 'b g', onclick: refreshTools }, 'Обновить'),
        h('button', { class: 'b', onclick: () => runCommand({ cmd: 'tools' }) }, 'Вставить инструкции в чат')),
      h('label', {}, h('input', { type: 'checkbox', checked: state.auto, onchange: (e) => { state.auto = e.target.checked; saveSettings(); } }), 'Выполнять вызовы автоматически (осторожно)'),
      h('label', {}, h('input', { type: 'checkbox', checked: state.autoSend, onchange: (e) => { state.autoSend = e.target.checked; saveSettings(); } }), 'Сразу отправлять результат в чат')));
  }

  chrome.storage.onChanged.addListener((ch) => { if (ch.servers) { state.servers = ch.servers.newValue || []; refreshTools(); } });
  loadSettings().then(() => { render(); refreshTools(); });
})();