// --- State ---
// Active and history lists are queried independently — each owns its own
// fetch, refresh interval, and pagination state. Refreshing one MUST NOT
// disrupt the other (no shared cache key, no shared offset, no shared DOM
// re-render path).
// Canonical operation statuses are defined server-side in the swat Go module
// (`operation.Status` in github.com/LangSensei/swat/operation). When that enum
// changes (rename / add / remove), update both lists below so polling does not
// silently drop ops. The backend `/api/ops?status=` accepts a comma list.
const ACTIVE_STATUSES = 'active,queued';
const HISTORY_STATUSES = 'completed,failed,cancelled';
let historyOffset = 0;
let historyTotal = 0;
let selectedOp = null;
// Per-runtime terminal state: { term, fitAddon, ws, closeTimer, div }
const terminals = {};
let currentRuntime = null;

function getOrCreateTerminal(rt) {
  if (terminals[rt]) return terminals[rt];
  const container = document.getElementById('terminal-inner');
  const div = document.createElement('div');
  div.id = `term-${rt}`;
  div.style.cssText = 'width:100%;height:100%;display:none;';
  container.appendChild(div);
  const t = new Terminal({
    scrollback: 10000,
    theme: { background:'#0d1117', foreground:'#c9d1d9', cursor:'#58a6ff', selectionBackground:'#264f78' },
    fontFamily: "'Cascadia Code','Fira Code',monospace",
    fontSize: 14,
    cursorBlink: true
  });
  const fa = new FitAddon.FitAddon();
  t.loadAddon(fa);
  t.open(div);
  t.onData(data => {
    const s = terminals[rt];
    if (s && s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(data);
  });
  // Shift+Enter -> send LF (\n) instead of CR (\r) so the Copilot CLI input
  // treats it as an in-line newline rather than submitting the message.
  // Plain Enter keeps the default xterm behavior (sends \r -> submit).
  // Skip while an IME composition is in progress so confirming a CJK
  // candidate with Enter never accidentally submits or injects \n.
  t.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    if (e.isComposing || e.keyCode === 229) return true;
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const s = terminals[rt];
      if (s && s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send('\n');
      return false;
    }
    return true;
  });
  terminals[rt] = { term:t, fitAddon:fa, ws:null, closeTimer:null, div };
  return terminals[rt];
}

function initTerminal() {
  const ro = new ResizeObserver(() => {
    if (!currentRuntime || !terminals[currentRuntime]) return;
    const s = terminals[currentRuntime];
    if (s.div.style.display !== 'none') {
      s.fitAddon.fit();
      if (s.ws && s.ws.readyState === WebSocket.OPEN)
        s.ws.send(JSON.stringify({ type:'resize', cols:s.term.cols, rows:s.term.rows }));
    }
  });
  ro.observe(document.getElementById('terminal-container'));
}

function connectSession() {
  const rt = document.getElementById('runtime-select').value;
  // Hide all terminal divs
  for (const s of Object.values(terminals)) s.div.style.display = 'none';
  const state = getOrCreateTerminal(rt);
  document.getElementById('terminal-placeholder').style.display = 'none';
  document.getElementById('terminal-inner').style.display = 'block';
  state.div.style.display = 'block';
  currentRuntime = rt;
  // Already connected? Just show
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.fitAddon.fit();
    state.term.focus();
    return;
  }
  if (state.closeTimer) { clearTimeout(state.closeTimer); state.closeTimer = null; }
  if (state.ws) { state.ws.onclose = null; state.ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${proto}//${location.host}/ws/session?runtime=${rt}`);
  state.ws.binaryType = 'arraybuffer';
  state.ws.onopen = () => {
    setTimeout(() => {
      state.fitAddon.fit();
      state.ws.send(JSON.stringify({ type:'resize', cols:state.term.cols, rows:state.term.rows }));
      state.term.focus();
    }, 100);
  };
  state.ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) state.term.write(new Uint8Array(e.data));
    else state.term.write(e.data);
  };
  state.ws.onclose = () => {
    state.term.writeln('\r\n[Disconnected]');
    state.closeTimer = setTimeout(() => {
      if ((!state.ws || state.ws.readyState !== WebSocket.OPEN) && currentRuntime === rt) {
        state.div.style.display = 'none';
        document.getElementById('terminal-placeholder').innerHTML = '<div style="color:var(--fg2);font-size:14px;">Disconnected</div><button onclick="connectSession()" style="background:var(--accent);border:none;color:#fff;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:13px;">Reconnect</button>';
        document.getElementById('terminal-placeholder').style.display = 'flex';
      }
    }, 2000);
  };
}

document.getElementById('runtime-select').addEventListener('change', () => {
  if (document.getElementById('terminal-inner').style.display !== 'none') {
    connectSession();
  }
});

// --- Tabs ---
function showTab(name) {
  document.getElementById('tab-session').classList.toggle('active', name === 'session');
  document.getElementById('tab-detail').classList.toggle('active', name === 'detail');
  document.getElementById('terminal-container').classList.toggle('visible', name === 'session');
  document.getElementById('detail-view').classList.toggle('visible', name === 'detail');
  if (name === 'session' && currentRuntime && terminals[currentRuntime]) {
    terminals[currentRuntime].fitAddon.fit();
    terminals[currentRuntime].term.focus();
  }
}

// --- Operations ---
function renderOpCard(op, container) {
  const card = document.createElement('div');
  card.className = 'op-card' + (selectedOp === op.id ? ' selected' : '');
  card.onclick = () => selectOp(op);
  card.innerHTML = `
    <div class="op-squad"><span class="status-dot ${op.status}"></span>${op.squad}</div>
    <div class="op-id">${op.id}</div>
    <div class="op-meta">
      <span>${op.elapsed || '—'}</span>
      <span>${op.summary ? op.summary.substring(0, 60) + (op.summary.length > 60 ? '...' : '') : op.brief || ''}</span>
    </div>
  `;
  container.appendChild(card);
}

// Compute the status filter for the active list.
// - No dropdown filter → both active and queued
// - Dropdown matches an "active-bucket" status → that single status
// - Dropdown matches a terminal status → active list is empty (filter excludes it)
function activeStatusFilter(dropdown) {
  if (!dropdown) return ACTIVE_STATUSES;
  if (dropdown === 'active' || dropdown === 'queued') return dropdown;
  return null; // active list shows empty state
}

// Compute the status filter for the history list.
// - No dropdown filter → all terminal statuses
// - Dropdown matches a terminal status → that single status
// - Dropdown matches an active-bucket status → history list is empty
function historyStatusFilter(dropdown) {
  if (!dropdown) return HISTORY_STATUSES;
  if (dropdown === 'active' || dropdown === 'queued') return null;
  return dropdown;
}

function renderEmpty(container, text) {
  container.innerHTML = `<div style="padding:8px 12px;color:var(--fg2);font-size:13px;">${text}</div>`;
}

// --- Active list (independent query, frequent polling) ---

async function loadActiveOps() {
  const squad = document.getElementById('filter-squad').value;
  const keyword = document.getElementById('filter-keyword').value;
  const dropdown = document.getElementById('filter-status').value;

  const activeList = document.getElementById('active-list');
  const filter = activeStatusFilter(dropdown);
  if (filter === null) {
    renderEmpty(activeList, 'No active operations match the current filter');
    return;
  }

  const params = new URLSearchParams({ limit: '100', offset: '0', status: filter });
  if (squad) params.set('squad', squad);
  if (keyword) params.set('q', keyword);

  try {
    const resp = await fetch(`/api/ops?${params}`);
    const data = await resp.json();
    const ops = data.operations || [];
    activeList.innerHTML = '';
    if (ops.length === 0) {
      renderEmpty(activeList, 'No active operations');
      return;
    }
    ops.forEach(op => renderOpCard(op, activeList));
  } catch(e) {
    // Leave previous content intact on transient failure to avoid flicker.
  }
}

// --- History list (independent query, refreshes only on user action) ---

async function loadHistoryOps(reset = true) {
  const squad = document.getElementById('filter-squad').value;
  const keyword = document.getElementById('filter-keyword').value;
  const dropdown = document.getElementById('filter-status').value;

  const historyList = document.getElementById('history-list');
  const loadMoreBtn = document.getElementById('load-more');
  const filter = historyStatusFilter(dropdown);

  if (filter === null) {
    renderEmpty(historyList, 'No history matches the current filter');
    historyOffset = 0;
    historyTotal = 0;
    loadMoreBtn.style.display = 'none';
    return;
  }

  if (reset) {
    historyOffset = 0;
    historyList.innerHTML = '';
  }

  const params = new URLSearchParams({
    limit: '20',
    offset: String(historyOffset),
    status: filter,
  });
  if (squad) params.set('squad', squad);
  if (keyword) params.set('q', keyword);

  try {
    const resp = await fetch(`/api/ops?${params}`);
    const data = await resp.json();
    const ops = data.operations || [];
    historyTotal = data.total || 0;
    ops.forEach(op => renderOpCard(op, historyList));
    historyOffset += ops.length;
    // If a non-reset page returned 0 ops while the server still claims more
    // (e.g. data churned between fetches), reconcile total to current offset
    // so the Load-More button hides instead of looping on empty pages.
    if (!reset && ops.length === 0) {
      historyTotal = historyOffset;
    }
    if (reset && historyOffset === 0) {
      renderEmpty(historyList, 'No operations');
    }
    loadMoreBtn.style.display = historyOffset < historyTotal ? '' : 'none';
  } catch(e) {
    if (reset && historyOffset === 0) {
      renderEmpty(historyList, 'Failed to load history');
    }
  }
}

async function loadMore() {
  await loadHistoryOps(false);
}

// --- Stats (independent fetch and interval) ---

async function loadStats() {
  try {
    const resp = await fetch('/api/stats');
    const stats = await resp.json();
    document.getElementById('stat-active').textContent = `Active: ${(stats.active || 0) + (stats.queued || 0)}`;
    document.getElementById('stat-completed').textContent = `Completed: ${stats.completed || 0}`;
    document.getElementById('stat-failed').textContent = `Failed: ${stats.failed || 0}`;
  } catch(e) {
    // Keep prior values on transient failure.
  }
}

async function loadSquads() {
  const resp = await fetch('/api/squads');
  const squads = await resp.json();
  const select = document.getElementById('filter-squad');
  (squads || []).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    select.appendChild(opt);
  });
}

async function selectOp(op) {
  selectedOp = op.id;
  showTab('detail');

  document.getElementById('detail-empty').style.display = 'none';
  const content = document.getElementById('detail-content');
  content.style.display = '';

  // Build metadata section
  let html = `
    <div class="detail-field">
      <div class="detail-label">Operation</div>
      <div class="detail-value">${escapeHtml(op.id)} &nbsp; <span class="status-dot ${op.status}"></span>${escapeHtml(op.status)}</div>
    </div>
    <div class="detail-field">
      <div class="detail-label">Squad</div>
      <div class="detail-value">${escapeHtml(op.squad)}</div>
    </div>
    <div class="detail-field">
      <div class="detail-label">Brief</div>
      <div class="detail-value">${escapeHtml(op.brief || '—')}</div>
    </div>
    ${op.summary ? `<div class="detail-field"><div class="detail-label">Summary</div><div class="detail-value">${escapeHtml(op.summary)}</div></div>` : ''}
    <div class="detail-field">
      <div class="detail-label">Duration</div>
      <div class="detail-value">${escapeHtml(op.elapsed || '—')} &nbsp; (${escapeHtml(op.created_at || '?')} → ${escapeHtml(op.completed_at || 'running')})</div>
    </div>
    <div id="file-tabs-container"></div>
    <div class="detail-field">
      <div id="file-content-label" class="detail-label">OPERATION.md</div>
      <div class="detail-value"><div id="file-content-area"><pre>Loading...</pre></div></div>
    </div>
  `;
  content.innerHTML = html;

  // Fetch file list
  let files = [];
  try {
    const filesResp = await fetch(`/api/files?op=${encodeURIComponent(op.id)}`);
    if (filesResp.ok) files = (await filesResp.json()) || [];
  } catch(e) {}

  // Render file tabs
  const tabsContainer = document.getElementById('file-tabs-container');
  if (files.length > 0) {
    const tabsDiv = document.createElement('div');
    tabsDiv.className = 'file-tabs';
    files.forEach(f => {
      const tab = document.createElement('span');
      tab.className = 'file-tab';
      tab.textContent = f;
      tab.onclick = () => loadFileContent(op.id, f, tabsDiv);
      tabsDiv.appendChild(tab);
    });
    tabsContainer.appendChild(tabsDiv);
  }

  // Default to OPERATION.md if present, otherwise first file
  if (files.length > 0) {
    const defaultFile = files.includes('OPERATION.md') ? 'OPERATION.md' : files[0];
    loadFileContent(op.id, defaultFile, tabsContainer.querySelector('.file-tabs'));
  } else {
    document.getElementById('file-content-label').textContent = '';
    document.getElementById('file-content-pre').textContent = 'No files available';
  }

  // Highlight selected card
  document.querySelectorAll('.op-card').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.op-card').forEach(c => {
    if (c.querySelector('.op-id')?.textContent === op.id) c.classList.add('selected');
  });
}

async function loadFileContent(opId, filename, tabsDiv) {
  if (selectedOp !== opId) return;
  // Update active tab
  if (tabsDiv) {
    tabsDiv.querySelectorAll('.file-tab').forEach(t => {
      t.classList.toggle('active', t.textContent === filename);
    });
  }
  document.getElementById('file-content-label').textContent = filename;

  const contentArea = document.getElementById('file-content-area');
  contentArea.innerHTML = '<pre>Loading...</pre>';

  try {
    const resp = await fetch(`/api/file?op=${encodeURIComponent(opId)}&file=${encodeURIComponent(filename)}`);
    if (selectedOp !== opId) return;
    const text = resp.ok ? await resp.text() : 'Failed to load';

    const ext = filename.split('.').pop().toLowerCase();

    if (ext === 'md' && typeof marked !== 'undefined') {
      const body = typeof stripFrontmatter === 'function' ? stripFrontmatter(text) : text;
      const rawHtml = marked.parse(body);
      const sanitized = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(rawHtml) : rawHtml;
      contentArea.innerHTML = `<div class="md-content">${sanitized}</div>`;
    } else if (ext === 'html' || ext === 'htm') {
      const fileUrl = `/api/file?op=${encodeURIComponent(opId)}&file=${encodeURIComponent(filename)}`;
      contentArea.innerHTML =
        `<a href="${escapeHtml(fileUrl)}" target="_blank" class="open-tab-btn">Open in new tab &#8599;</a>` +
        `<iframe srcdoc="${escapeHtml(text)}" sandbox="allow-same-origin" class="html-frame"></iframe>`;
    } else {
      contentArea.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
    }
  } catch(e) {
    if (selectedOp !== opId) return;
    contentArea.innerHTML = '<pre>Failed to load</pre>';
  }
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// --- Filters ---
// Filter changes refresh BOTH lists once (each via its own independent query).
// Subsequent active polling never re-runs the history query.
let filterTimer;
function onFilterChange() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    loadActiveOps();
    loadHistoryOps(true);
    loadStats();
  }, 300);
}
document.getElementById('filter-squad').addEventListener('change', onFilterChange);
document.getElementById('filter-status').addEventListener('change', onFilterChange);
document.getElementById('filter-keyword').addEventListener('input', onFilterChange);

// --- Init ---
loadSquads();
loadActiveOps();
loadHistoryOps(true);
loadStats();
initTerminal();
loadRuntimes();

// Independent refresh policies:
//   - active list polls frequently (live data)
//   - history list never auto-polls; user pulls via filter change or "Load more"
//   - stats refresh on a slower cadence
setInterval(loadActiveOps, 5000);
setInterval(loadStats, 10000);

async function loadRuntimes() {
  try {
    const resp = await fetch('/api/runtimes');
    const runtimes = await resp.json();
    const select = document.getElementById('runtime-select');
    select.innerHTML = '';
    runtimes.forEach(rt => {
      const opt = document.createElement('option');
      opt.value = rt.name;
      opt.textContent = rt.name + (rt.available ? '' : ' (not installed)');
      opt.disabled = !rt.available;
      select.appendChild(opt);
    });
    // Select first available and auto-connect
    const first = runtimes.find(r => r.available);
    if (first) {
      select.value = first.name;
      connectSession();
    } else {
      document.getElementById('terminal-placeholder').innerHTML = '<div style="color:var(--fg2);font-size:14px;">No CLI runtimes installed</div>';
    }
  } catch(e) {}
}
