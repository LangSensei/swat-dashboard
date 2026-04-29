// --- State ---
// Active and history lists are queried independently — each owns its own
// fetch, refresh interval, and pagination state. Refreshing one MUST NOT
// disrupt the other (no shared cache key, no shared offset, no shared DOM
// re-render path).
// Canonical operation statuses are defined server-side in the swat Go module
// (`operation.Status` in github.com/LangSensei/swat/operation). When that enum
// changes (rename / add / remove), update both lists below so polling does not
// silently drop ops. The backend `/api/ops?status=` accepts a comma list.
const ACTIVE_STATUSES = 'active,queued,classifying';
const HISTORY_STATUSES = 'completed,failed,cancelled';
let historyOffset = 0;
let historyTotal = 0;
let selectedOp = null;
// Per-runtime terminal state: { term, fitAddon, ws, closeTimer, div }
const terminals = {};
let currentRuntime = null;

// --- Keyed reconcile state ---
// Cache of loaded history ops for time-bucket grouping
let historyOpsCache = [];
// Flags for skeleton/empty-state coordination
let initialLoadStarted = 0;
let activeFirstLoaded = false;
let historyFirstLoaded = false;
let isLoadingHistory = false;

// IntersectionObserver for infinite scroll
let historyObserver = null;

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
  if (name !== 'detail') stopDetailRefresh();
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

function createOpCard(op) {
  const card = document.createElement('div');
  card.dataset.opId = op.id;
  updateOpCard(card, op);
  return card;
}

function updateOpCard(card, op) {
  const border = cardBorderClass(op);
  card.className = 'op-card' + (border ? ' ' + border : '') + (selectedOp === op.id ? ' selected' : '');
  card.onclick = () => selectOp(op);
  card._op = op;

  // Title
  const titleText = op.summary || sanitizeBrief(op.brief) || op.id;
  const fullTitle = op.summary || op.brief || op.id;
  let titleEl = card.querySelector('.op-title');
  if (!titleEl) {
    titleEl = document.createElement('div');
    titleEl.className = 'op-title';
    card.appendChild(titleEl);
  }
  titleEl.textContent = titleText;
  titleEl.title = fullTitle;

  // Meta row
  let metaRow = card.querySelector('.op-meta-row');
  if (!metaRow) {
    metaRow = document.createElement('div');
    metaRow.className = 'op-meta-row';
    card.appendChild(metaRow);
  }
  metaRow.innerHTML = '';

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

  // Op ID line
  let idLine = card.querySelector('.op-id-line');
  if (!idLine) {
    idLine = document.createElement('div');
    idLine.className = 'op-id-line';
    idLine.title = 'Click to copy';
    idLine.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(card.dataset.opId).then(() => toast('Copied: ' + card.dataset.opId)).catch(() => {});
    };
    card.appendChild(idLine);
  }
  idLine.textContent = op.id;
}

// Legacy wrapper for detail-view card rendering (appends to container)
function renderOpCard(op, container) {
  const card = createOpCard(op);
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
function historyStatusFilter(dropdown) {
  const { status } = parseFilterValue(dropdown);
  if (!status) return HISTORY_STATUSES;
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

// Status display labels and render order for active sub-groups
const ACTIVE_STATUS_ORDER = ['active', 'queued', 'classifying'];
const ACTIVE_STATUS_LABELS = { active: 'Running', queued: 'Queued', classifying: 'Classifying' };

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

    // Remove skeletons on first successful load (with 1.5s minimum display)
    if (!activeFirstLoaded) {
      const elapsed = Date.now() - initialLoadStarted;
      const delay = Math.max(0, 1500 - elapsed);
      if (delay > 0) {
        await new Promise(r => setTimeout(r, delay));
      }
      activeFirstLoaded = true;
      removeSkeleton(activeList);
    }

    if (ops.length === 0) {
      activeList.innerHTML = '';
      lastActiveCount = 0;
      updateSectionCounts();
      checkGlobalEmpty();
      return;
    }
    lastActiveCount = ops.length;
    updateSectionCounts();

    // Group ops by status
    const groups = {};
    for (const op of ops) {
      const s = op.status || 'active';
      if (!groups[s]) groups[s] = [];
      groups[s].push(op);
    }

    // Build map of existing cards by op.id for reuse
    const existingCards = {};
    activeList.querySelectorAll('.op-card[data-op-id]').forEach(c => {
      existingCards[c.dataset.opId] = c;
    });

    // Rebuild container with sub-headers, reusing card elements
    const fragment = document.createDocumentFragment();
    const usedIds = new Set();

    for (const status of ACTIVE_STATUS_ORDER) {
      const groupOps = groups[status];
      if (!groupOps || groupOps.length === 0) continue;

      const header = document.createElement('div');
      header.className = 'status-subheader';
      header.textContent = `${ACTIVE_STATUS_LABELS[status] || status} (${groupOps.length})`;
      fragment.appendChild(header);

      for (const op of groupOps) {
        usedIds.add(op.id);
        let card = existingCards[op.id];
        if (card) {
          updateOpCard(card, op);
        } else {
          card = createOpCard(op);
        }
        fragment.appendChild(card);
      }
    }

    // Handle any statuses not in ACTIVE_STATUS_ORDER
    for (const [status, groupOps] of Object.entries(groups)) {
      if (ACTIVE_STATUS_ORDER.includes(status)) continue;
      const header = document.createElement('div');
      header.className = 'status-subheader';
      header.textContent = `${status} (${groupOps.length})`;
      fragment.appendChild(header);
      for (const op of groupOps) {
        usedIds.add(op.id);
        let card = existingCards[op.id];
        if (card) {
          updateOpCard(card, op);
        } else {
          card = createOpCard(op);
        }
        fragment.appendChild(card);
      }
    }

    // In-place reconcile to preserve DOM node identity and CSS animations
    const desiredNodes = Array.from(fragment.childNodes);
    const currentNodes = Array.from(activeList.childNodes);
    for (const node of currentNodes) {
      if (!desiredNodes.includes(node)) {
        activeList.removeChild(node);
      }
    }
    let refNode = activeList.firstChild;
    for (const node of desiredNodes) {
      if (node === refNode) {
        refNode = refNode.nextSibling;
      } else {
        activeList.insertBefore(node, refNode);
      }
    }
    checkGlobalEmpty();
  } catch(e) {
    // Leave previous content intact on transient failure to avoid flicker.
  }
}

// --- History list (independent query, refreshes only on user action) ---

// Time bucket computation using local timezone
function getTimeBucket(isoStr) {
  if (!isoStr) return 'Earlier';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return 'Earlier';

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekAgo = new Date(todayStart);
  weekAgo.setDate(weekAgo.getDate() - 6); // 7-day rolling window

  if (d >= todayStart) return 'Today';
  if (d >= yesterdayStart) return 'Yesterday';
  if (d >= weekAgo) return 'This Week';
  return 'Earlier';
}

function renderHistoryWithBuckets() {
  const historyList = document.getElementById('history-list');

  if (historyOpsCache.length === 0) {
    const sentinel = document.getElementById('history-sentinel');
    historyList.innerHTML = '';
    historyList.appendChild(sentinel);
    renderEmpty(historyList, 'No operations');
    checkGlobalEmpty();
    return;
  }

  // Group ops by time bucket
  const bucketOrder = ['Today', 'Yesterday', 'This Week', 'Earlier'];
  const buckets = {};
  for (const op of historyOpsCache) {
    const ts = op.completed_at || op.created_at;
    const bucket = getTimeBucket(ts);
    if (!buckets[bucket]) buckets[bucket] = [];
    buckets[bucket].push(op);
  }

  // Build map of existing cards for reuse
  const existingCards = {};
  historyList.querySelectorAll('.op-card[data-op-id]').forEach(c => {
    existingCards[c.dataset.opId] = c;
  });

  // Rebuild with bucket headers, reusing card elements
  const fragment = document.createDocumentFragment();

  for (const bucketName of bucketOrder) {
    const ops = buckets[bucketName];
    if (!ops || ops.length === 0) continue;

    const header = document.createElement('div');
    header.className = 'time-bucket-header';
    header.textContent = `${bucketName} (${ops.length})`;
    fragment.appendChild(header);

    for (const op of ops) {
      let card = existingCards[op.id];
      if (card) {
        updateOpCard(card, op);
      } else {
        card = createOpCard(op);
      }
      fragment.appendChild(card);
    }
  }

  const sentinel = document.getElementById('history-sentinel');

  // In-place reconcile to preserve DOM node identity and CSS animations
  const desiredNodes = Array.from(fragment.childNodes);
  desiredNodes.push(sentinel); // sentinel always goes at the end
  const currentNodes = Array.from(historyList.childNodes);
  for (const node of currentNodes) {
    if (!desiredNodes.includes(node)) {
      historyList.removeChild(node);
    }
  }
  let refNode = historyList.firstChild;
  for (const node of desiredNodes) {
    if (node === refNode) {
      refNode = refNode.nextSibling;
    } else {
      historyList.insertBefore(node, refNode);
    }
  }
  checkGlobalEmpty();
}

function isSentinelVisible() {
  const sentinel = document.getElementById('history-sentinel');
  const scrollRoot = document.querySelector('.history-list');
  if (!sentinel || !scrollRoot) return false;
  const rootRect = scrollRoot.getBoundingClientRect();
  const sentinelRect = sentinel.getBoundingClientRect();
  return sentinelRect.top < rootRect.bottom + 100;
}

async function loadHistoryOps(reset = true) {
  const squad = document.getElementById('filter-squad').value;
  const keyword = document.getElementById('filter-keyword').value;
  const dropdown = document.getElementById('filter-status').value;

  const filter = historyStatusFilter(dropdown);

  if (filter === null) {
    historyOpsCache = [];
    historyOffset = 0;
    historyTotal = 0;
    renderHistoryWithBuckets();
    return;
  }

  if (reset) {
    historyOffset = 0;
    historyOpsCache = [];
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
    const rawOps = data.operations || [];
    historyTotal = data.total || 0;

    // Advance offset by raw page length before client-side filtering
    historyOffset += rawOps.length;

    // Client-side sub-filter by failure_reason bucket
    const ops = applyBucketFilter(rawOps, dropdown);

    lastHistoryCount = historyTotal;
    updateSectionCounts();

    // Remove skeletons on first successful load (with 1.5s minimum display)
    if (!historyFirstLoaded) {
      const elapsed = Date.now() - initialLoadStarted;
      const delay = Math.max(0, 1500 - elapsed);
      if (delay > 0) {
        await new Promise(r => setTimeout(r, delay));
      }
      historyFirstLoaded = true;
      removeSkeleton(document.getElementById('history-list'));
    }

    // Dedupe and append to cache
    const existingIds = new Set(historyOpsCache.map(o => o.id));
    for (const op of ops) {
      if (!existingIds.has(op.id)) {
        historyOpsCache.push(op);
        existingIds.add(op.id);
      }
    }

    // If a non-reset page returned 0 raw ops, reconcile total
    if (!reset && rawOps.length === 0) {
      historyTotal = historyOffset;
    }

    renderHistoryWithBuckets();
    updateInfiniteScroll();

    // Auto-fill: if filtered results didn't fill viewport, keep loading
    if (historyOffset < historyTotal && isSentinelVisible()) {
      await loadMore();
    }
  } catch(e) {
    if (reset && historyOffset === 0) {
      renderEmpty(document.getElementById('history-list'), 'Failed to load history');
    }
  } finally {
    isLoadingHistory = false;
  }
}

// Auto-refresh variant: fetches the first page and merges into the
// existing cache so newly completed operations appear without resetting
// scroll position or pagination state.
async function refreshHistoryOps() {
  if (isLoadingHistory) return;

  const squad = document.getElementById('filter-squad').value;
  const keyword = document.getElementById('filter-keyword').value;
  const dropdown = document.getElementById('filter-status').value;
  const filter = historyStatusFilter(dropdown);
  if (filter === null) return;

  const params = new URLSearchParams({ limit: '20', offset: '0', status: filter });
  if (squad) params.set('squad', squad);
  if (keyword) params.set('q', keyword);

  try {
    const resp = await fetch(`/api/ops?${params}`);
    const data = await resp.json();
    const rawOps = data.operations || [];
    historyTotal = data.total || 0;

    const ops = applyBucketFilter(rawOps, dropdown);
    lastHistoryCount = historyTotal;
    updateSectionCounts();

    // Merge: update existing items in-place, prepend genuinely new ones
    const existingIds = new Set(historyOpsCache.map(o => o.id));
    let insertedCount = 0;
    for (const op of ops) {
      if (!existingIds.has(op.id)) {
        historyOpsCache.unshift(op);
        existingIds.add(op.id);
        insertedCount++;
      } else {
        const idx = historyOpsCache.findIndex(o => o.id === op.id);
        if (idx !== -1) historyOpsCache[idx] = op;
      }
    }

    // Keep pagination offset aligned so "Load more" fetches the right slice
    historyOffset += insertedCount;

    renderHistoryWithBuckets();
    updateInfiniteScroll();
  } catch(e) { /* silent on auto-refresh */ }
}

async function loadMore() {
  if (isLoadingHistory) return;
  isLoadingHistory = true;
  showHistorySpinner();
  await loadHistoryOps(false);
  hideHistorySpinner();
}

// --- Infinite scroll ---

function showHistorySpinner() {
  let spinner = document.getElementById('history-spinner');
  if (!spinner) {
    spinner = document.createElement('div');
    spinner.id = 'history-spinner';
    spinner.className = 'history-spinner';
    spinner.textContent = 'Loading...';
    const sentinel = document.getElementById('history-sentinel');
    sentinel.parentNode.insertBefore(spinner, sentinel);
  }
  spinner.style.display = '';
}

function hideHistorySpinner() {
  const spinner = document.getElementById('history-spinner');
  if (spinner) spinner.style.display = 'none';
}

function updateInfiniteScroll() {
  const hasMore = historyOffset < historyTotal;
  if (hasMore) {
    setupInfiniteScroll();
  } else {
    teardownInfiniteScroll();
  }
}

function setupInfiniteScroll() {
  if (historyObserver) return;
  const sentinel = document.getElementById('history-sentinel');
  const scrollRoot = document.querySelector('.history-list');
  if (!sentinel) return;
  historyObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && !isLoadingHistory && historyOffset < historyTotal) {
        loadMore();
      }
    }
  }, { root: scrollRoot, rootMargin: '100px' });
  historyObserver.observe(sentinel);
}

function teardownInfiniteScroll() {
  if (historyObserver) {
    historyObserver.disconnect();
    historyObserver = null;
  }
  hideHistorySpinner();
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

// --- File categorization ---

const FILE_CATEGORIES = {
  working: {
    label: 'Working Files', icon: '\uD83D\uDCDD',
    patterns: [/^plan\.md$/, /^progress\.md$/, /^findings\.md$/, /^OPERATION\.md$/],
  },
  logs: {
    label: 'Logs', icon: '\uD83D\uDCCB',
    patterns: [/\.log$/, /^temp\//],
  },
  config: {
    label: 'Config', icon: '\u2699\uFE0F',
    patterns: [/^AGENTS\.md$/, /^\.github\//, /^\.copilot\//, /^\.mcp\.json$/, /^\.squad\//, /^\.context_refresh_ts$/],
  },
};

function categorizeFiles(files) {
  const cats = { report: [], working: [], logs: [], config: [], other: [] };
  for (const f of files) {
    // Report files get special treatment in primary content
    if (/^report\.(html?|md)$/i.test(f)) { cats.report.push(f); continue; }
    let matched = false;
    for (const [cat, def] of Object.entries(FILE_CATEGORIES)) {
      if (def.patterns.some(p => p.test(f))) { cats[cat].push(f); matched = true; break; }
    }
    if (!matched) cats.other.push(f);
  }
  return cats;
}

// --- Cancel / Retry / Copy ID actions ---

async function cancelOp(opId) {
  if (!confirm('Cancel operation ' + opId + '?')) return;
  stopDetailRefresh();
  const btn = document.querySelector('.action-btn.danger');
  if (btn) { btn.disabled = true; btn.textContent = 'Cancelling\u2026'; }
  try {
    const resp = await fetch('/api/ops/cancel?op=' + encodeURIComponent(opId), { method: 'POST' });
    if (resp.ok) {
      toast('Cancelled: ' + opId);
      loadActiveOps();
      loadHistoryOps(true);
      loadStats();
      if (selectedOp === opId) refreshSelectedDetail();
    } else if (resp.status === 501) {
      toast('Cancel not yet implemented — coming soon', 'error');
    } else {
      toast('Cancel failed: ' + await resp.text(), 'error');
    }
  } catch (e) {
    toast('Cancel failed: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Cancel'; }
  }
}

async function retryOp(opId) {
  try {
    const resp = await fetch('/api/ops/retry?op=' + encodeURIComponent(opId), { method: 'POST' });
    if (resp.ok) {
      const newOp = await resp.json();
      toast('Retried as: ' + newOp.id);
      loadActiveOps();
      loadHistoryOps(true);
      loadStats();
    } else if (resp.status === 501) {
      toast('Retry not yet implemented — coming soon', 'error');
    } else {
      toast('Retry failed: ' + await resp.text(), 'error');
    }
  } catch (e) {
    toast('Retry failed: ' + e.message, 'error');
  }
}

function copyOpId(opId) {
  navigator.clipboard.writeText(opId).then(() => toast('Copied: ' + opId)).catch(() => {});
}

// --- Detail refresh for active/running ops ---

let detailRefreshTimer = null;
let selectedOpData = null;

function startDetailRefresh(op) {
  stopDetailRefresh();
  if (op.status === 'active' || op.status === 'queued' || op.status === 'classifying') {
    detailRefreshTimer = setInterval(() => refreshSelectedDetail(), 5000);
  }
}

function stopDetailRefresh() {
  if (detailRefreshTimer) { clearInterval(detailRefreshTimer); detailRefreshTimer = null; }
}

// Pause detail polling when the browser tab is hidden; resume when visible.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopDetailRefresh();
  } else if (selectedOpData && document.getElementById('detail-view').classList.contains('visible')) {
    startDetailRefresh(selectedOpData);
  }
});

async function refreshSelectedDetail() {
  if (!selectedOp || !selectedOpData) return;
  try {
    const resp = await fetch('/api/ops/get?op=' + encodeURIComponent(selectedOp));
    if (!resp.ok) return;
    const freshOp = await resp.json();
    // Status changed? Full re-render
    if (freshOp.status !== selectedOpData.status) {
      selectOp(freshOp);
      return;
    }
    selectedOpData = freshOp;
    // Refresh primary content files for active ops
    if (freshOp.status === 'active' || freshOp.status === 'classifying') {
      const progressArea = document.getElementById('primary-progress-area');
      if (progressArea) {
        try {
          const fResp = await fetch('/api/file?op=' + encodeURIComponent(freshOp.id) + '&file=progress.md');
          if (fResp.ok) {
            const text = await fResp.text();
            progressArea.innerHTML = '<div class="md-content">' + renderMarkdown(text) + '</div>';
            // Auto-scroll to bottom
            progressArea.scrollTop = progressArea.scrollHeight;
          }
        } catch (e) {}
      }
    }
  } catch (e) {}
}

// --- Status-adaptive selectOp ---

async function selectOp(op) {
  selectedOp = op.id;
  selectedOpData = op;
  showTab('detail');
  stopDetailRefresh();
  teardownActiveIframeResize();

  document.getElementById('detail-empty').style.display = 'none';
  const content = document.getElementById('detail-content');
  content.style.display = '';

  // Status-colored border
  content.className = '';
  const border = cardBorderClass(op);
  if (border) content.classList.add('detail-panel', border);

  const dotClass = statusDotClass(op);
  const briefHtml = renderMarkdown(op.brief);
  const statusLabel = op.status.charAt(0).toUpperCase() + op.status.slice(1);

  // --- Header ---
  let html = '<div class="detail-header">';
  html += '<a class="detail-back" onclick="showTab(\'session\')">\u2190 Back to list</a>';

  // Row 1: status dot + ID + squad
  html += '<div class="detail-header-row">';
  html += '<span class="status-dot ' + dotClass + '"></span>';
  html += '<span class="detail-header-id">' + escapeHtml(op.id) + '</span>';
  if (op.squad) {
    html += '<span class="squad-chip" style="background:' + squadColor(op.squad) + '">' + escapeHtml(op.squad) + '</span>';
  }
  html += '</div>';

  // Brief
  html += '<div class="detail-header-brief"><div class="md-content">' + briefHtml + '</div></div>';

  // Meta row: status + duration + time + actions
  html += '<div class="detail-header-meta">';
  html += '<span class="status-label ' + escapeHtml(op.status) + '">' + escapeHtml(statusLabel) + '</span>';
  if (op.elapsed) html += '<span>\u00B7 ' + escapeHtml(op.elapsed) + '</span>';
  if (op.created_at) html += '<span>\u00B7 ' + escapeHtml(relativeTime(op.created_at)) + '</span>';

  // Action buttons (right-aligned)
  html += '<span class="detail-header-actions">';
  if (op.status === 'active' || op.status === 'queued' || op.status === 'classifying') {
    html += '<button class="action-btn danger" onclick="cancelOp(\'' + escapeHtml(op.id) + '\')">Cancel</button>';
  }
  if (op.status === 'failed') {
    html += '<button class="action-btn primary" onclick="retryOp(\'' + escapeHtml(op.id) + '\')">Retry</button>';
  }
  html += '<button class="action-btn icon" onclick="copyOpId(\'' + escapeHtml(op.id) + '\')" title="Copy ID">\uD83D\uDCCB</button>';
  html += '</span>';
  html += '</div>'; // end meta row
  html += '</div>'; // end header

  // --- Primary content area (status-dependent) ---
  html += '<div class="primary-content" id="primary-content-area">Loading...</div>';

  // --- File categories placeholder ---
  html += '<div id="file-categories-area"></div>';

  content.innerHTML = html;

  // Stale-request guard
  if (selectedOp !== op.id) return;

  // Fetch file list
  let files = [];
  try {
    const filesResp = await fetch('/api/files?op=' + encodeURIComponent(op.id));
    if (selectedOp !== op.id) return;
    if (filesResp.ok) files = (await filesResp.json()) || [];
  } catch (e) {}
  if (selectedOp !== op.id) return;

  const cats = categorizeFiles(files);

  // Render status-specific primary content
  const primaryArea = document.getElementById('primary-content-area');
  if (!primaryArea || selectedOp !== op.id) return;

  await renderPrimaryContent(op, cats, files, primaryArea);
  if (selectedOp !== op.id) return;

  // Render file categories below primary content
  const categoriesArea = document.getElementById('file-categories-area');
  if (categoriesArea) renderFileCategories(op, cats, categoriesArea);

  // Start auto-refresh for active ops
  startDetailRefresh(op);

  // Highlight selected card
  document.querySelectorAll('.op-card').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.op-card').forEach(c => {
    if (c.dataset.opId === op.id) c.classList.add('selected');
  });
}

async function renderPrimaryContent(op, cats, files, container) {
  switch (op.status) {
    case 'completed':
      await renderCompletedContent(op, cats, files, container);
      break;
    case 'failed':
      await renderFailedContent(op, cats, files, container);
      break;
    case 'active':
      await renderActiveContent(op, cats, files, container);
      break;
    case 'queued':
    case 'classifying':
      await renderQueuedContent(op, cats, files, container);
      break;
    default:
      container.innerHTML = '<div class="md-content">' + renderMarkdown(op.summary || op.brief || '\u2014') + '</div>';
  }
}

async function renderCompletedContent(op, cats, files, container) {
  // 1. report.html → iframe
  const reportHtml = cats.report.find(f => /\.html?$/i.test(f));
  if (reportHtml) {
    try {
      const resp = await fetch('/api/file?op=' + encodeURIComponent(op.id) + '&file=' + encodeURIComponent(reportHtml));
      if (selectedOp !== op.id) return;
      if (resp.ok) {
        const text = await resp.text();
        const fileUrl = '/api/file?op=' + encodeURIComponent(op.id) + '&file=' + encodeURIComponent(reportHtml);
        container.innerHTML = '<a href="' + escapeHtml(fileUrl) + '" target="_blank" class="open-tab-btn">Open in new tab \u2197</a>';
        const iframe = document.createElement('iframe');
        iframe.className = 'html-frame';
        iframe.setAttribute('sandbox', 'allow-same-origin');
        iframe.srcdoc = text;
        attachIframeAutoResize(iframe);
        container.appendChild(iframe);
        return;
      }
    } catch (e) {}
  }

  // 2. report.md → markdown
  const reportMd = cats.report.find(f => /\.md$/i.test(f));
  if (reportMd) {
    try {
      const resp = await fetch('/api/file?op=' + encodeURIComponent(op.id) + '&file=' + encodeURIComponent(reportMd));
      if (selectedOp !== op.id) return;
      if (resp.ok) {
        const text = await resp.text();
        container.innerHTML = '<div class="md-content">' + renderMarkdown(text) + '</div>';
        return;
      }
    } catch (e) {}
  }

  // 3. OPERATION.md summary
  if (op.summary) {
    container.innerHTML = '<div class="detail-field"><div class="detail-label">Summary</div><div class="detail-value"><div class="md-content">' + renderMarkdown(op.summary) + '</div></div></div>';
  } else {
    // 4. Show OPERATION.md content
    await renderFileInline(op.id, 'OPERATION.md', container);
  }
}

async function renderFailedContent(op, cats, files, container) {
  let html = '';

  // 1. Failure reason box at top
  if (op.failure_reason && typeof FAILURE_REASONS !== 'undefined') {
    const fr = FAILURE_REASONS[op.failure_reason];
    if (fr) {
      html += '<div class="failure-reason-box">';
      html += '<div class="failure-header"><span>' + fr.icon + '</span> ' + escapeHtml(fr.label) + '</div>';
      html += '<div class="failure-code">' + escapeHtml(op.failure_reason) + '</div>';
      html += '<div class="failure-hint">' + escapeHtml(fr.hint) + '</div>';
      html += '</div>';
    } else {
      html += '<div class="failure-reason-box">';
      html += '<div class="failure-header">\u274C Failure</div>';
      html += '<div class="failure-code">' + escapeHtml(op.failure_reason) + '</div>';
      html += '</div>';
    }
  } else if (op.failure_reason) {
    html += '<div class="failure-reason-box">';
    html += '<div class="failure-header">\u274C Failure</div>';
    html += '<div class="failure-code">' + escapeHtml(op.failure_reason) + '</div>';
    html += '</div>';
  }

  // 2. progress.md expanded
  html += '<div id="failed-progress-area"><pre>Loading progress.md...</pre></div>';

  // 3. Last log file expanded
  const logFiles = cats.logs.filter(f => f.endsWith('.log'));
  if (logFiles.length > 0) {
    html += '<div id="failed-log-area"><pre>Loading log...</pre></div>';
  }

  container.innerHTML = html;
  if (selectedOp !== op.id) return;

  // Load progress.md
  const progressArea = document.getElementById('failed-progress-area');
  if (progressArea && files.includes('progress.md')) {
    await renderFileInline(op.id, 'progress.md', progressArea);
  } else if (progressArea) {
    progressArea.innerHTML = '<div style="color:var(--color-fg-muted);font-size:13px;">No progress.md found</div>';
  }

  // Load last log
  if (logFiles.length > 0) {
    const logArea = document.getElementById('failed-log-area');
    if (logArea) {
      const lastLog = logFiles[logFiles.length - 1];
      await renderFileInline(op.id, lastLog, logArea, lastLog);
    }
  }
}

async function renderActiveContent(op, cats, files, container) {
  let html = '';

  // 1. progress.md auto-refreshing
  html += '<div class="detail-field">';
  html += '<div class="detail-label">Progress <span style="color:var(--color-success-fg);font-size:10px;">\u25CF live</span></div>';
  html += '<div class="detail-value" id="primary-progress-area" style="max-height:400px;overflow-y:auto;"><pre>Loading progress.md...</pre></div>';
  html += '</div>';

  // 2. plan.md
  html += '<div class="detail-field">';
  html += '<div class="detail-label">Plan</div>';
  html += '<div class="detail-value" id="primary-plan-area"><pre>Loading plan.md...</pre></div>';
  html += '</div>';

  container.innerHTML = html;
  if (selectedOp !== op.id) return;

  // Load progress.md
  const progressArea = document.getElementById('primary-progress-area');
  if (progressArea && files.includes('progress.md')) {
    await renderFileInline(op.id, 'progress.md', progressArea);
  } else if (progressArea) {
    progressArea.innerHTML = '<div style="color:var(--color-fg-muted);font-size:13px;">No progress.md yet</div>';
  }

  // Load plan.md
  const planArea = document.getElementById('primary-plan-area');
  if (planArea && files.includes('plan.md')) {
    await renderFileInline(op.id, 'plan.md', planArea);
  } else if (planArea) {
    planArea.innerHTML = '<div style="color:var(--color-fg-muted);font-size:13px;">No plan.md yet</div>';
  }
}

async function renderQueuedContent(op, cats, files, container) {
  let html = '';

  // Status message
  const msg = op.status === 'classifying' ? 'Waiting for classification...' : 'In queue...';
  html += '<div class="status-message"><span class="spinner"></span>' + escapeHtml(msg) + '</div>';

  // OPERATION.md content
  html += '<div id="queued-operation-area"><pre>Loading OPERATION.md...</pre></div>';

  container.innerHTML = html;
  if (selectedOp !== op.id) return;

  const opArea = document.getElementById('queued-operation-area');
  if (opArea) {
    await renderFileInline(op.id, 'OPERATION.md', opArea);
  }
}

// Helper: render a file's content inline into a container
async function renderFileInline(opId, filename, container, label) {
  try {
    const resp = await fetch('/api/file?op=' + encodeURIComponent(opId) + '&file=' + encodeURIComponent(filename));
    if (selectedOp !== opId) return;
    if (!resp.ok) {
      container.innerHTML = '<pre>Failed to load ' + escapeHtml(filename) + '</pre>';
      return;
    }
    const text = await resp.text();
    const ext = filename.split('.').pop().toLowerCase();
    if (label) {
      container.innerHTML = '<div class="detail-label">' + escapeHtml(label) + '</div>';
    } else {
      container.innerHTML = '';
    }
    if (ext === 'md' && typeof marked !== 'undefined') {
      container.innerHTML += '<div class="md-content">' + renderMarkdown(text) + '</div>';
    } else if (ext === 'html' || ext === 'htm') {
      const fileUrl = '/api/file?op=' + encodeURIComponent(opId) + '&file=' + encodeURIComponent(filename);
      container.innerHTML += '<a href="' + escapeHtml(fileUrl) + '" target="_blank" class="open-tab-btn">Open in new tab \u2197</a>';
      const iframe = document.createElement('iframe');
      iframe.className = 'html-frame';
      iframe.setAttribute('sandbox', 'allow-same-origin');
      iframe.srcdoc = text;
      attachIframeAutoResize(iframe);
      container.appendChild(iframe);
    } else {
      container.innerHTML += '<pre style="background:var(--color-canvas-overlay);padding:12px;border-radius:8px;font-size:13px;white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono);">' + escapeHtml(text) + '</pre>';
    }
  } catch (e) {
    container.innerHTML = '<pre>Failed to load ' + escapeHtml(filename) + '</pre>';
  }
}

// --- File category rendering ---

function renderFileCategories(op, cats, container) {
  let html = '';

  // Working files (expanded by default for completed/active, skip files already shown in primary)
  const primaryShown = getPrimaryShownFiles(op);
  const workingFiles = cats.working.filter(f => !primaryShown.has(f));
  if (workingFiles.length > 0) {
    html += renderCategorySection('working', FILE_CATEGORIES.working, workingFiles, op.id, true);
  }

  // Logs (collapsed by default)
  if (cats.logs.length > 0) {
    html += renderCategorySection('logs', FILE_CATEGORIES.logs, cats.logs, op.id, false);
  }

  // Config (hidden by default — shown via toggle)
  if (cats.config.length > 0) {
    html += '<div id="config-toggle-area">';
    html += '<div class="config-toggle" onclick="document.getElementById(\'config-section\').style.display=\'block\';this.style.display=\'none\';">';
    html += 'Show config files (' + cats.config.length + ')</div>';
    html += '<div id="config-section" style="display:none">';
    html += renderCategorySection('config', FILE_CATEGORIES.config, cats.config, op.id, false);
    html += '</div></div>';
  }

  // Other uncategorized files
  const otherFiles = (cats.other || []).filter(f => !primaryShown.has(f));
  if (otherFiles.length > 0) {
    html += renderCategorySection('other', { label: 'Other', icon: '\uD83D\uDCC1' }, otherFiles, op.id, false);
  }

  container.innerHTML = html;

  // Event delegation for file category items (avoids inline onclick with quote issues)
  container.addEventListener('click', function(e) {
    const item = e.target.closest('.file-category-item');
    if (!item) return;
    const file = item.getAttribute('data-file');
    const opId = item.getAttribute('data-op');
    if (file && opId) toggleFileInCategory(item, opId, file);
  });
}

function getPrimaryShownFiles(op) {
  const shown = new Set();
  if (op.status === 'completed') {
    // Report files shown in primary
    shown.add('report.html');
    shown.add('report.md');
  }
  if (op.status === 'failed') {
    shown.add('progress.md');
  }
  if (op.status === 'active') {
    shown.add('progress.md');
    shown.add('plan.md');
  }
  if (op.status === 'queued' || op.status === 'classifying') {
    shown.add('OPERATION.md');
  }
  return shown;
}

function renderCategorySection(id, def, files, opId, openByDefault) {
  let html = '<details class="file-category"' + (openByDefault ? ' open' : '') + '>';
  html += '<summary>' + def.icon + ' ' + escapeHtml(def.label);
  html += '<span class="count-badge">' + files.length + '</span>';
  html += '</summary>';
  html += '<div class="file-category-list">';
  for (const f of files) {
    const safeF = escapeHtml(f);
    html += '<div class="file-category-item" data-file="' + safeF + '" data-op="' + escapeHtml(opId) + '">' + safeF + '</div>';
  }
  html += '</div></details>';
  return html;
}

async function toggleFileInCategory(el, opId, filename) {
  // If already expanded, collapse
  const existing = el.nextElementSibling;
  if (existing && existing.classList.contains('file-inline-content')) {
    existing.remove();
    el.classList.remove('active');
    return;
  }
  // Collapse any other expanded file in this category
  const parent = el.closest('.file-category-list');
  if (parent) {
    parent.querySelectorAll('.file-inline-content').forEach(e => e.remove());
    parent.querySelectorAll('.file-category-item').forEach(e => e.classList.remove('active'));
  }
  el.classList.add('active');
  const contentDiv = document.createElement('div');
  contentDiv.className = 'file-inline-content';
  contentDiv.innerHTML = '<pre>Loading...</pre>';
  el.after(contentDiv);
  await renderFileInline(opId, filename, contentDiv, filename);
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

// --- Skeleton loader ---

function renderSkeletonCards(container, count) {
  for (let i = 0; i < count; i++) {
    const card = document.createElement('div');
    card.className = 'skeleton-card';
    card.innerHTML = '<div class="skeleton-line title"></div><div class="skeleton-line meta"></div><div class="skeleton-line id"></div>';
    container.appendChild(card);
  }
}

function removeSkeleton(container) {
  container.querySelectorAll('.skeleton-card').forEach(c => c.remove());
}

function showSkeletons() {
  const activeList = document.getElementById('active-list');
  const historyList = document.getElementById('history-list');
  const sentinel = document.getElementById('history-sentinel');
  activeList.innerHTML = '';
  historyList.innerHTML = '';
  historyList.appendChild(sentinel);
  renderSkeletonCards(activeList, 3);
  renderSkeletonCards(historyList, 5);
  initialLoadStarted = Date.now();
}

// --- Empty state ---

function checkGlobalEmpty() {
  const activeList = document.getElementById('active-list');
  const historyList = document.getElementById('history-list');

  // Only check after both sections have loaded at least once
  if (!activeFirstLoaded || !historyFirstLoaded) return;

  const hasActive = activeList.querySelector('.op-card') !== null;
  const hasHistory = historyOpsCache.length > 0;

  // Remove any existing empty state
  const existingEmpty = document.getElementById('global-empty-state');
  if (existingEmpty) existingEmpty.remove();

  if (!hasActive && !hasHistory) {
    const emptyDiv = document.createElement('div');
    emptyDiv.id = 'global-empty-state';
    emptyDiv.className = 'empty-state';
    emptyDiv.innerHTML = `
      <div class="empty-icon">\u26A1</div>
      <div class="empty-title">Nothing here yet</div>
      <div class="empty-hint">swat dispatch "fix the auth bug"</div>
      <button class="copy-btn" id="copy-cmd-btn">Copy command</button>
    `;
    // Insert after active list, before history title
    activeList.innerHTML = '';
    activeList.appendChild(emptyDiv);

    document.getElementById('copy-cmd-btn').addEventListener('click', () => {
      navigator.clipboard.writeText('swat dispatch "fix the auth bug"')
        .then(() => toast('Command copied!'))
        .catch(() => {});
    });
  }
}

// --- Filters ---
// Filter changes refresh BOTH lists once (each via its own independent query).
// Subsequent active polling never re-runs the history query.
let filterTimer;
function onFilterChange() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    teardownInfiniteScroll();
    loadActiveOps();
    loadHistoryOps(true);
    loadStats();
  }, 300);
}
document.getElementById('filter-squad').addEventListener('change', onFilterChange);
document.getElementById('filter-status').addEventListener('change', onFilterChange);
document.getElementById('filter-keyword').addEventListener('input', onFilterChange);

// --- Init ---
showSkeletons();
loadSquads();
loadActiveOps();
loadHistoryOps(true);
loadStats();
initTerminal();
loadRuntimes();

// Synchronized refresh: all lists update together so operations
// transitioning from active → history don't appear to vanish.
const REFRESH_INTERVAL = 5000;
setInterval(loadActiveOps, REFRESH_INTERVAL);
setInterval(refreshHistoryOps, REFRESH_INTERVAL);
setInterval(loadStats, REFRESH_INTERVAL);

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
