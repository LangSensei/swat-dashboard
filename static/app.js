// --- State ---
let currentOffset = 0;
let totalOps = 0;
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

async function loadOps() {
  const squad = document.getElementById('filter-squad').value;
  const status = document.getElementById('filter-status').value;
  const keyword = document.getElementById('filter-keyword').value;

  const activeList = document.getElementById('active-list');
  const historyList = document.getElementById('history-list');
  activeList.innerHTML = '';
  historyList.innerHTML = '';

  try {
    // When no status filter is set, fetch active+queued ops separately
    // so they always appear regardless of pagination
    let activeOps = [];
    if (!status) {
      const activeParams = new URLSearchParams({ limit: '50', offset: '0', status: 'active' });
      if (squad) activeParams.set('squad', squad);
      if (keyword) activeParams.set('q', keyword);

      const queuedParams = new URLSearchParams({ limit: '50', offset: '0', status: 'queued' });
      if (squad) queuedParams.set('squad', squad);
      if (keyword) queuedParams.set('q', keyword);

      const [activeResp, queuedResp] = await Promise.all([
        fetch(`/api/ops?${activeParams}`),
        fetch(`/api/ops?${queuedParams}`)
      ]);
      const activeData = await activeResp.json();
      const queuedData = await queuedResp.json();
      activeOps = [...(activeData.operations || []), ...(queuedData.operations || [])];
    }

    // Main paginated fetch for the history list (or filtered view)
    const params = new URLSearchParams({ limit: '20', offset: '0' });
    if (squad) params.set('squad', squad);
    if (status) params.set('status', status);
    if (keyword) params.set('q', keyword);

    const resp = await fetch(`/api/ops?${params}`);
    const data = await resp.json();

    totalOps = data.total;
    currentOffset = 20;

    if (!status) {
      // No status filter: active section from dedicated fetch, history from paginated fetch minus active/queued
      if (activeOps.length === 0) {
        activeList.innerHTML = '<div style="padding:8px 12px;color:var(--fg2);font-size:13px;">No active operations</div>';
      }
      activeOps.forEach(op => renderOpCard(op, activeList));

      const rest = (data.operations || []).filter(op => op.status !== 'active' && op.status !== 'queued');
      rest.forEach(op => renderOpCard(op, historyList));
    } else {
      // Status filter active: show all results in the appropriate section
      const active = (data.operations || []).filter(op => op.status === 'active' || op.status === 'queued');
      const rest = (data.operations || []).filter(op => op.status !== 'active' && op.status !== 'queued');

      if (active.length === 0) {
        activeList.innerHTML = '<div style="padding:8px 12px;color:var(--fg2);font-size:13px;">No active operations</div>';
      }
      active.forEach(op => renderOpCard(op, activeList));
      rest.forEach(op => renderOpCard(op, historyList));
    }

    document.getElementById('load-more').style.display = currentOffset < totalOps ? '' : 'none';

    // Update stats from dedicated endpoint
    try {
      const statsResp = await fetch('/api/stats');
      const stats = await statsResp.json();
      document.getElementById('stat-active').textContent = `Active: ${(stats.active || 0) + (stats.queued || 0)}`;
      document.getElementById('stat-completed').textContent = `Completed: ${stats.completed || 0}`;
      document.getElementById('stat-failed').textContent = `Failed: ${stats.failed || 0}`;
    } catch(e) {
      document.getElementById('stat-active').textContent = `Active: ${activeOps.length}`;
    }
  } catch(e) {
    document.getElementById('stat-active').textContent = 'Active: 0';
    document.getElementById('stat-completed').textContent = 'Completed: 0';
    document.getElementById('stat-failed').textContent = 'Failed: 0';
  }
}

async function loadMore() {
  const squad = document.getElementById('filter-squad').value;
  const status = document.getElementById('filter-status').value;
  const keyword = document.getElementById('filter-keyword').value;

  const params = new URLSearchParams({ limit: '20', offset: String(currentOffset) });
  if (squad) params.set('squad', squad);
  if (status) params.set('status', status);
  if (keyword) params.set('q', keyword);

  const resp = await fetch(`/api/ops?${params}`);
  const data = await resp.json();
  currentOffset += 20;

  const historyList = document.getElementById('history-list');
  (data.operations || []).forEach(op => renderOpCard(op, historyList));
  document.getElementById('load-more').style.display = currentOffset < totalOps ? '' : 'none';
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
      const rawHtml = marked.parse(text);
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
let filterTimer;
function onFilterChange() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(loadOps, 300);
}
document.getElementById('filter-squad').addEventListener('change', onFilterChange);
document.getElementById('filter-status').addEventListener('change', onFilterChange);
document.getElementById('filter-keyword').addEventListener('input', onFilterChange);

// --- Stats polling ---
async function updateStats() {
  try {
    const resp = await fetch('/api/ops?limit=0');
    const data = await resp.json();
    // Count from filesystem scan
  } catch(e) {}
}

// --- Init ---
loadSquads();
loadOps();
initTerminal();
loadRuntimes();

// Poll active ops every 5s
setInterval(loadOps, 5000);

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
