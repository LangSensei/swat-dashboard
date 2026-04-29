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
    theme: { background:'#0d1117', foreground:'#e6edf3', cursor:'#58a6ff', selectionBackground:'#264f78' },
    fontFamily: "var(--font-mono, 'Cascadia Code','Fira Code',monospace)",
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

function connectSession(rt) {
  if (!rt) rt = currentRuntime;
  if (!rt) return;
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
        document.getElementById('terminal-placeholder').innerHTML = '<div style="color:var(--color-fg-muted);font-size:14px;">Disconnected</div><button onclick="connectSession()" style="background:var(--color-accent-fg);border:none;color:#fff;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:13px;">Reconnect</button>';
        document.getElementById('terminal-placeholder').style.display = 'flex';
      }
    }, 2000);
  };
}

// Toast helper for switch feedback
function toast(msg, kind) {
  let el = document.getElementById('runtime-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'runtime-toast';
    el.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:10px 16px;border-radius:6px;font-size:13px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:360px;';
    document.body.appendChild(el);
  }
  el.style.background = kind === 'error' ? 'var(--color-danger-fg)' : 'var(--color-canvas-subtle)';
  el.style.color = 'var(--color-fg-default)';
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// Tear down a runtime's local WS+terminal state so a follow-up
// connectSession() spins up a fresh one against the new active backend.
function teardownRuntimeState(rt) {
  const state = terminals[rt];
  if (!state) return;
  if (state.closeTimer) { clearTimeout(state.closeTimer); state.closeTimer = null; }
  if (state.ws) { state.ws.onclose = null; try { state.ws.close(); } catch(e) {} state.ws = null; }
}

let switchInFlight = false;
async function switchRuntime(to) {
  if (switchInFlight) return;
  if (to === currentRuntime) return;
  switchInFlight = true;
  // Disable BOTH runtime tab buttons during the in-flight window so a
  // double-click cannot race the backend into an unnecessary 409. We
  // restore visual state in finally; on the success path loadRuntimes
  // re-renders tabs from scratch which also clears the disabled styles.
  const tabs = document.querySelectorAll('#runtime-tabs .tab');
  tabs.forEach(t => {
    t.dataset.prevPointer = t.style.pointerEvents;
    t.dataset.prevOpacity = t.style.opacity;
    t.style.pointerEvents = 'none';
    t.style.opacity = '0.5';
  });
  try {
    const resp = await fetch('/api/runtime/switch?to=' + encodeURIComponent(to), { method:'POST' });
    if (resp.status === 200) {
      teardownRuntimeState(currentRuntime);
      teardownRuntimeState(to);
      await loadRuntimes(true);
      connectSession(to);
    } else if (resp.status === 409) {
      toast('Another runtime switch is in progress. Try again.', 'error');
      loadRuntimes(true);
    } else if (resp.status === 400) {
      toast(to + ' CLI is not available on PATH', 'error');
      loadRuntimes(true);
    } else {
      const txt = await resp.text();
      toast('Switch failed: ' + (txt || resp.statusText), 'error');
    }
  } catch (e) {
    toast('Switch failed: ' + e.message, 'error');
  } finally {
    switchInFlight = false;
    // Restore tabs that survived the in-flight window. On success/409/400
    // loadRuntimes re-renders tabs entirely (these resets are no-ops on the
    // freshly-rendered DOM); on the unexpected error/catch paths this
    // restores the original interactive state.
    document.querySelectorAll('#runtime-tabs .tab').forEach(t => {
      t.style.pointerEvents = t.dataset.prevPointer || '';
      t.style.opacity = t.dataset.prevOpacity || '';
      delete t.dataset.prevPointer;
      delete t.dataset.prevOpacity;
    });
  }
}

function renderRuntimeTabs(runtimes, activeName) {
  const container = document.getElementById('runtime-tabs');
  if (!container) return;
  container.innerHTML = '';
  runtimes.forEach(rt => {
    const tab = document.createElement('div');
    const isActive = rt.name === activeName;
    tab.className = 'tab' + (isActive ? ' active' : '');
    tab.textContent = rt.name + (rt.available ? '' : ' (n/a)');
    tab.title = rt.session_id ? ('session ' + rt.session_id) : '';
    tab.style.cssText = 'cursor:' + (rt.available ? 'pointer' : 'not-allowed') + ';opacity:' + (rt.available ? '1' : '0.5') + ';padding:4px 12px;border-radius:6px;font-size:12px;border:1px solid var(--color-border-default);' + (isActive ? 'background:var(--color-accent-fg);color:#fff;border-color:var(--color-accent-fg);' : 'background:var(--color-canvas-default);color:var(--color-fg-default);');
    if (rt.available) {
      tab.addEventListener('click', () => switchRuntime(rt.name));
    }
    container.appendChild(tab);
  });
}

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

// Brief sanitizer: strip routing noise to keep semantic content.
function sanitizeBrief(text) {
  if (!text) return '';
  return text
    .replace(/^\[.*?\]\s*/g, '')        // [squad-prefix]
    .replace(/^Branch:\s*\S+\s*/gi, '') // Branch: xxx
    .replace(/^Mode\s+\w+\s*/gi, '')    // Mode X
    .replace(/^###\s*Context\s*/gi, '') // ### Context heading
    .trim();
}

// Relative time: "3 min ago", "2h ago", "just now"
function relativeTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return Math.floor(secs / 60) + ' min ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
}

// Deterministic hashed color for squad chip background.
function squadColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue}, 50%, 25%)`;
}

// Determine the left-border CSS class for a card based on status + failure_reason.
function cardBorderClass(op) {
  if (op.status === 'failed' && op.failure_reason) {
    const entry = typeof FAILURE_REASONS !== 'undefined' ? FAILURE_REASONS[op.failure_reason] : null;
    if (entry) return 'border-' + entry.bucket;
    return 'border-crashed'; // unknown failure_reason defaults to red
  }
  if (op.status === 'active' || op.status === 'queued') return 'border-active';
  if (op.status === 'completed') return 'border-completed';
  return '';
}

// Determine the status-dot CSS class (for detail view, etc.)
function statusDotClass(op) {
  if (op.status === 'failed' && op.failure_reason) {
    const entry = typeof FAILURE_REASONS !== 'undefined' ? FAILURE_REASONS[op.failure_reason] : null;
    if (entry) return entry.bucket;
  }
  return op.status;
}

function renderOpCard(op, container) {
  const card = document.createElement('div');
  const border = cardBorderClass(op);
  card.className = 'op-card' + (border ? ' ' + border : '') + (selectedOp === op.id ? ' selected' : '');
  card.onclick = () => selectOp(op);

  // Title: summary > brief (sanitized) > id as last resort
  const titleText = op.summary || sanitizeBrief(op.brief) || op.id;
  const fullTitle = op.summary || op.brief || op.id;

  const titleEl = document.createElement('div');
  titleEl.className = 'op-title';
  titleEl.textContent = titleText;
  titleEl.title = fullTitle;
  card.appendChild(titleEl);

  // Meta row: squad chip + relative time
  const metaRow = document.createElement('div');
  metaRow.className = 'op-meta-row';

  if (op.squad) {
    const chip = document.createElement('span');
    chip.className = 'squad-chip';
    chip.textContent = op.squad;
    chip.style.backgroundColor = squadColor(op.squad);
    metaRow.appendChild(chip);
  }

  const dot = document.createElement('span');
  dot.className = 'status-dot ' + statusDotClass(op);
  metaRow.appendChild(dot);

  if (op.created_at) {
    const timeEl = document.createElement('span');
    timeEl.textContent = relativeTime(op.created_at);
    timeEl.title = op.created_at;
    metaRow.appendChild(timeEl);
  }

  card.appendChild(metaRow);

  // Op ID: muted, bottom-right, click-to-copy
  const idLine = document.createElement('div');
  idLine.className = 'op-id-line';
  idLine.textContent = op.id;
  idLine.title = 'Click to copy';
  idLine.onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(op.id).then(() => toast('Copied: ' + op.id)).catch(() => {});
  };
  card.appendChild(idLine);

  container.appendChild(card);
}

// Failure bucket → failure_reason identifiers mapping for client-side filtering.
const BUCKET_REASONS = {
  cancelled: ['cancelled_by_user'],
  crashed: ['process_exited_without_completion'],
  setup: ['classify_spawn_failed', 'classify_move_failed', 'provision_failed', 'launch_failed'],
  config: ['classify_no_squad', 'classify_squad_not_installed'],
};

// Parse the dropdown value. Returns { status, bucket } where bucket is null
// for non-sub-filtered selections.
function parseFilterValue(dropdown) {
  if (!dropdown) return { status: null, bucket: null };
  if (dropdown.startsWith('failed:')) return { status: 'failed', bucket: dropdown.slice(7) };
  return { status: dropdown, bucket: null };
}

// Compute the status filter for the history list.
// - No dropdown filter → all terminal statuses
// - Dropdown matches a terminal status → that single status
// - Dropdown matches an active-bucket status → treat as no filter (show all terminal)
function historyStatusFilter(dropdown) {
  const { status } = parseFilterValue(dropdown);
  if (!status) return HISTORY_STATUSES;
  if (status === 'active' || status === 'queued') return HISTORY_STATUSES;
  return status;
}

// Client-side failure_reason sub-filter. Returns ops filtered by bucket.
function applyBucketFilter(ops, dropdown) {
  const { bucket } = parseFilterValue(dropdown);
  if (!bucket) return ops;
  const reasons = BUCKET_REASONS[bucket];
  if (!reasons) return ops;
  return ops.filter(op => reasons.includes(op.failure_reason));
}

function renderEmpty(container, text) {
  container.innerHTML = `<div style="padding:8px 12px;color:var(--color-fg-muted);font-size:13px;">${text}</div>`;
}

// --- Active list (independent query, frequent polling) ---

async function loadActiveOps() {
  const squad = document.getElementById('filter-squad').value;
  const keyword = document.getElementById('filter-keyword').value;

  const activeList = document.getElementById('active-list');

  const params = new URLSearchParams({ limit: '100', offset: '0', status: ACTIVE_STATUSES });
  if (squad) params.set('squad', squad);
  if (keyword) params.set('q', keyword);

  try {
    const resp = await fetch(`/api/ops?${params}`);
    const data = await resp.json();
    const ops = data.operations || [];
    activeList.innerHTML = '';
    if (ops.length === 0) {
      renderEmpty(activeList, 'No active operations');
      lastActiveCount = 0;
      updateSectionCounts();
      return;
    }
    lastActiveCount = ops.length;
    updateSectionCounts();
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
    let ops = data.operations || [];
    // Client-side sub-filter by failure_reason bucket
    ops = applyBucketFilter(ops, dropdown);
    historyTotal = data.total || 0;
    lastHistoryCount = historyTotal;
    updateSectionCounts();
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

// Track latest counts for section titles
let lastActiveCount = 0;
let lastHistoryCount = 0;

function updateSectionCounts() {
  const activeTitle = document.getElementById('section-active-title');
  const historyTitle = document.getElementById('section-history-title');
  if (activeTitle) activeTitle.textContent = `Active (${lastActiveCount})`;
  if (historyTitle) historyTitle.textContent = `History (${lastHistoryCount})`;
}

async function loadStats() {
  try {
    const resp = await fetch('/api/stats');
    const stats = await resp.json();
    document.getElementById('stat-active').textContent = `Active: ${(stats.active || 0) + (stats.queued || 0)}`;
    document.getElementById('stat-cancelled').textContent = `Cancelled: ${stats.cancelled || 0}`;
    document.getElementById('stat-crashed').textContent = `Crashed: ${stats.crashed || 0}`;
    document.getElementById('stat-setup').textContent = `Setup: ${stats.setup || 0}`;
    document.getElementById('stat-config').textContent = `Config: ${stats.config || 0}`;
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

  // Tear down any prior iframe's resize listeners before rebuilding
  teardownActiveIframeResize();

  document.getElementById('detail-empty').style.display = 'none';
  const content = document.getElementById('detail-content');
  content.style.display = '';

  // #6 Status surface: bucket-colored left-border on detail panel
  content.className = '';
  const border = cardBorderClass(op);
  if (border) content.classList.add('detail-panel', border);

  const dotClass = statusDotClass(op);
  const createdRel = relativeTime(op.created_at);
  const completedRel = op.completed_at ? relativeTime(op.completed_at) : 'running';

  // #1 Markdown render brief/summary
  const briefHtml = renderMarkdown(op.brief);
  const summaryHtml = op.summary ? renderMarkdown(op.summary) : '';

  // #2 Sidebar metadata layout (right sidebar) + main column
  let html = '<div class="detail-layout">';

  // Main column (left)
  html += '<div class="detail-main">';
  html += `
    <div class="detail-field">
      <div class="detail-label">Brief</div>
      <div class="detail-value"><div class="md-content">${briefHtml}</div></div>
    </div>
  `;
  if (op.summary) {
    html += `
    <div class="detail-field">
      <div class="detail-label">Summary</div>
      <div class="detail-value"><div class="md-content">${summaryHtml}</div></div>
    </div>
    `;
  }

  // Failure block: structured display when op has a failure_reason
  if (op.status === 'failed' && op.failure_reason && typeof FAILURE_REASONS !== 'undefined') {
    const fr = FAILURE_REASONS[op.failure_reason];
    if (fr) {
      let actionsHtml = '';
      if (fr.action) {
        if (fr.action.file) {
          actionsHtml = `<button class="failure-action-btn" onclick="loadFileContent('${escapeHtml(op.id)}','${escapeHtml(fr.action.file)}',document.querySelector('.file-tabs'))">${escapeHtml(fr.action.label)}</button>`;
        } else if (fr.action.href) {
          actionsHtml = `<a class="failure-action-btn" href="${escapeHtml(fr.action.href)}">${escapeHtml(fr.action.label)}</a>`;
        } else {
          actionsHtml = `<span class="failure-action-btn">${escapeHtml(fr.action.label)}</span>`;
        }
      }
      html += `
    <div class="detail-field">
      <div class="detail-label">Failure</div>
      <div class="failure-block">
        <div class="failure-header"><span>${fr.icon}</span> ${escapeHtml(fr.label)}</div>
        <div class="failure-code">${escapeHtml(op.failure_reason)}</div>
        <div class="failure-hint">${escapeHtml(fr.hint)}</div>
        ${actionsHtml ? `<div class="failure-actions">${actionsHtml}</div>` : ''}
      </div>
    </div>
      `;
    }
  } else if (op.status === 'failed' && op.failure_reason) {
    html += `
    <div class="detail-field">
      <div class="detail-label">Failure Reason</div>
      <div class="detail-value">${escapeHtml(op.failure_reason)}</div>
    </div>
    `;
  }

  // #3 References folding
  if (op.references && op.references.length > 0) {
    let refsInner = '';
    op.references.forEach(ref => {
      const val = escapeHtml(ref.value);
      if (ref.type === 'operation') {
        const opId = escapeHtml(extractOpId(ref.value));
        refsInner += `<li><a href="#" class="ref-link" data-op-id="${opId}">${opId}</a></li>`;
      } else {
        refsInner += `<li><span class="ref-type">${escapeHtml(ref.type)}</span>: ${val}</li>`;
      }
    });
    html += `
    <details class="detail-references">
      <summary>References (${op.references.length})</summary>
      <ul>${refsInner}</ul>
    </details>
    `;
  }

  html += '</div>'; // end detail-main

  // Sidebar (right)
  html += '<div class="detail-sidebar">';
  html += `
    <div class="sidebar-field">
      <div class="sidebar-label">Operation</div>
      <div class="sidebar-value mono">${escapeHtml(op.id)}</div>
    </div>
    <div class="sidebar-field">
      <div class="sidebar-label">Squad</div>
      <div class="sidebar-value"><span class="squad-chip" style="background:${squadColor(op.squad || '')}">${escapeHtml(op.squad || '\u2014')}</span></div>
    </div>
    <div class="sidebar-field">
      <div class="sidebar-label">Status</div>
      <div class="sidebar-value"><span class="status-dot ${dotClass}"></span>${escapeHtml(op.status)}</div>
    </div>
    <div class="sidebar-field">
      <div class="sidebar-label">Duration</div>
      <div class="sidebar-value">${escapeHtml(op.elapsed || '\u2014')}</div>
    </div>
    <div class="sidebar-field">
      <div class="sidebar-label">Created</div>
      <div class="sidebar-value" title="${escapeHtml(op.created_at || '')}">${escapeHtml(createdRel || '?')}</div>
    </div>
    <div class="sidebar-field">
      <div class="sidebar-label">Completed</div>
      <div class="sidebar-value" title="${escapeHtml(op.completed_at || '')}">${escapeHtml(completedRel)}</div>
    </div>
  `;
  html += '</div>'; // end detail-sidebar
  html += '</div>'; // end detail-layout

  // File tabs and content (full width, outside the 2-column grid)
  html += `
    <div id="file-tabs-container"></div>
    <div class="detail-field">
      <div id="file-content-label" class="detail-label">OPERATION.md</div>
      <div class="detail-value"><div id="file-content-area"><pre>Loading...</pre></div></div>
    </div>
  `;
  content.innerHTML = html;

  // Bind reference link click handlers (event delegation)
  content.querySelectorAll('.ref-link').forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      const refId = link.dataset.opId;
      try {
        const resp = await fetch('/api/ops?q=' + encodeURIComponent(refId) + '&limit=100');
        const data = await resp.json();
        const refOp = (data.operations || []).find(o => o.id === refId);
        if (refOp) selectOp(refOp);
        else toast('Referenced operation not found: ' + refId);
      } catch (err) {
        toast('Failed to load reference: ' + err.message, 'error');
      }
    });
  });

  // Stale-request guard
  if (selectedOp !== op.id) return;

  // Fetch file list
  let files = [];
  try {
    const filesResp = await fetch(`/api/files?op=${encodeURIComponent(op.id)}`);
    if (selectedOp !== op.id) return;
    if (filesResp.ok) files = (await filesResp.json()) || [];
  } catch(e) {}

  // Stale-request guard after files fetch
  if (selectedOp !== op.id) return;

  // Render file tabs
  const tabsContainer = document.getElementById('file-tabs-container');
  const labelEl = document.getElementById('file-content-label');
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
    if (labelEl) labelEl.style.display = 'none';
  }

  // Default to OPERATION.md if present, otherwise first file
  if (files.length > 0) {
    const defaultFile = files.includes('OPERATION.md') ? 'OPERATION.md' : files[0];
    loadFileContent(op.id, defaultFile, tabsContainer.querySelector('.file-tabs'));
  } else {
    document.getElementById('file-content-label').textContent = '';
    document.getElementById('file-content-area').textContent = 'No files available';
  }

  // Highlight selected card
  document.querySelectorAll('.op-card').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.op-card').forEach(c => {
    if (c.querySelector('.op-id')?.textContent === op.id) c.classList.add('selected');
  });
}

async function loadFileContent(opId, filename, tabsDiv) {
  if (selectedOp !== opId) return;
  // Tear down any prior iframe's resize listeners before replacing content.
  teardownActiveIframeResize();
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
      const sanitized = renderMarkdown(text);
      contentArea.innerHTML = `<div class="md-content">${sanitized}</div>`;
    } else if (ext === 'html' || ext === 'htm') {
      const fileUrl = `/api/file?op=${encodeURIComponent(opId)}&file=${encodeURIComponent(filename)}`;
      contentArea.innerHTML =
        `<a href="${escapeHtml(fileUrl)}" target="_blank" class="open-tab-btn">Open in new tab &#8599;</a>`;
      const iframe = document.createElement('iframe');
      iframe.className = 'html-frame';
      iframe.setAttribute('sandbox', 'allow-same-origin');
      iframe.srcdoc = text;
      attachIframeAutoResize(iframe);
      contentArea.appendChild(iframe);
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

// Render markdown to sanitized HTML. Falls back to escaped plain text when
// DOMPurify is unavailable so unsanitized marked output is never injected.
function renderMarkdown(text) {
  if (!text || typeof marked === 'undefined') return escapeHtml(text || '\u2014');
  const raw = marked.parse(text);
  if (typeof DOMPurify !== 'undefined') return DOMPurify.sanitize(raw);
  return escapeHtml(text);
}

// Extract an operation ID (YYYYMMDD-hex) from a reference value that may be
// a relative filesystem path like "../../squad/operations/20260317-b0320d3a/".
function extractOpId(refValue) {
  if (!refValue) return refValue;
  const match = refValue.match(/(\d{8}-[0-9a-f]+)/);
  return match ? match[1] : refValue;
}

// Resize iframe to its content height so it scrolls with the parent
// (#detail-view) instead of showing its own scrollbar. Works for same-origin
// srcdoc iframes since we can read the contained document directly.
let activeIframeResizeTeardown = null;
function teardownActiveIframeResize() {
  if (activeIframeResizeTeardown) {
    try { activeIframeResizeTeardown(); } catch (e) {}
    activeIframeResizeTeardown = null;
  }
}
function attachIframeAutoResize(iframe) {
  // Make sure we don't stack listeners from a previous iframe.
  teardownActiveIframeResize();
  let ro = null;
  let lastHeight = 0;
  let winListener = null;
  const onLoad = () => {
    let doc;
    try { doc = iframe.contentDocument; } catch (e) { return; }
    if (!doc) return;
    try {
      const styleEl = doc.createElement('style');
      styleEl.textContent = 'html,body{margin:0;overflow:hidden;}body{min-height:0;}';
      (doc.head || doc.documentElement).appendChild(styleEl);
    } catch (e) {}
    const resize = () => {
      let doc2;
      try { doc2 = iframe.contentDocument; } catch (e) { return; }
      if (!doc2 || !doc2.documentElement) return;
      const h = Math.max(
        doc2.documentElement.scrollHeight,
        doc2.body ? doc2.body.scrollHeight : 0
      );
      if (h && h !== lastHeight) {
        lastHeight = h;
        iframe.style.height = h + 'px';
      }
    };
    resize();
    if (window.ResizeObserver) {
      try {
        if (ro) ro.disconnect();
        ro = new ResizeObserver(resize);
        if (doc.body) ro.observe(doc.body);
        ro.observe(doc.documentElement);
      } catch (e) {}
    }
    if (winListener) window.removeEventListener('resize', winListener);
    winListener = () => resize();
    window.addEventListener('resize', winListener);
    setTimeout(resize, 100);
    setTimeout(resize, 500);
  };
  iframe.addEventListener('load', onLoad);
  activeIframeResizeTeardown = () => {
    if (winListener) {
      window.removeEventListener('resize', winListener);
      winListener = null;
    }
    if (ro) {
      try { ro.disconnect(); } catch (e) {}
      ro = null;
    }
    iframe.removeEventListener('load', onLoad);
  };
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

async function loadRuntimes(skipAutoConnect) {
  try {
    const resp = await fetch('/api/runtimes');
    const runtimes = await resp.json();
    const active = (runtimes.find(r => r.active) || {}).name || '';
    renderRuntimeTabs(runtimes, active);
    if (skipAutoConnect) return;
    const target = runtimes.find(r => r.active && r.available)
                || runtimes.find(r => r.available);
    if (target) {
      connectSession(target.name);
    } else {
      document.getElementById('terminal-placeholder').innerHTML = '<div style="color:var(--color-fg-muted);font-size:14px;">No CLI runtimes installed</div>';
    }
  } catch(e) {}
}
