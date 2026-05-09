// ===== Money Plus Board · 4자토크 연구실 =====
const socket = io();
let userName = localStorage.getItem('mp_user_name') || null;
let notes = [];
let meta = {};
let editingId = null;
let draggingId = null;
let activeFilter = 'all';
let cgInputState = null; // { noteId, value }
let commentInputState = null; // { noteId, value }
let expandedHistory = new Set(); // note IDs whose history panel is open

const board = document.getElementById('board');
const userNameEl = document.getElementById('user-name');
const userPillEl = document.getElementById('user-pill');
const connectedCountEl = document.getElementById('connected-count');
const tickerEl = document.getElementById('ticker');
const dateDisplayEl = document.getElementById('date-display');
const dateInputEl = document.getElementById('date-input');

const CATEGORY_LABELS = {
  index:   { ko: '지수',          en: 'INDEX',    color: '#5290cf' },
  sector:  { ko: '섹터',          en: 'SECTOR',   color: '#5fa885' },
  stocks:  { ko: '종목',          en: 'STOCKS',   color: '#d27a5a' },
  supply:  { ko: '수급',          en: 'LIQUIDITY', color: '#8e74bb' },
  us:      { ko: '미증시',        en: 'US',       color: '#3a5a82' },
  news:    { ko: '뉴스',          en: 'NEWS',     color: '#b89e44' },
  caster:  { ko: '캐스터 브리핑', en: 'CASTER',   color: '#b66890' },
};

const KOREAN_DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const DRAG_THRESHOLD = 5; // px movement before considered a drag

function getCat(key) {
  return CATEGORY_LABELS[key] || { ko: '기타', en: 'OTHER', color: '#8a96a8' };
}

function makeHistoryEntry(action, summary) {
  return {
    id: 'h_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    action,
    summary,
    by: userName,
    at: new Date().toISOString(),
  };
}

// Push history while keeping the array bounded (avoid unbounded growth)
function appendHistory(note, entry) {
  const prev = Array.isArray(note.history) ? note.history : [];
  const next = [...prev, entry];
  // keep most recent 30
  return next.length > 30 ? next.slice(next.length - 30) : next;
}

// ============================================================
// Question Order helpers (supports hierarchical strings like "2-1")
// ============================================================

// "2-1-3" → [2, 1, 3]
function parseOrder(o) {
  if (o == null) return [];
  return String(o).split('-').map(s => parseInt(s, 10) || 0);
}

// Sort comparator: "2" < "2-1" < "2-2" < "3" < "10"
function compareOrders(a, b) {
  const pa = parseOrder(a);
  const pb = parseOrder(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = i < pa.length ? pa[i] : -1;
    const vb = i < pb.length ? pb[i] : -1;
    if (va !== vb) return va - vb;
  }
  return 0;
}

function isValidOrderString(s) {
  return typeof s === 'string' && /^\d+(-\d+)*$/.test(s.trim());
}

function maxTopLevelOrder() {
  let max = 0;
  for (const n of notes) {
    if (!n.confirmed || n.questionOrder == null) continue;
    const top = parseOrder(n.questionOrder)[0] || 0;
    if (top > max) max = top;
  }
  return max;
}

// Confirmed notes in display order
function getSortedConfirmed() {
  return notes
    .filter(n => n.confirmed && n.questionOrder != null)
    .sort((a, b) => compareOrders(a.questionOrder, b.questionOrder));
}

// Ensure all confirmed notes have a questionOrder. Assigns missing ones at top-level.
function ensureOrders() {
  const confirmed = notes.filter(n => n.confirmed);
  const withoutOrder = confirmed.filter(n => !n.questionOrder);
  if (withoutOrder.length === 0) return;

  let next = maxTopLevelOrder() + 1;
  for (const n of withoutOrder) {
    const updated = { ...n, questionOrder: String(next++) };
    const idx = notes.findIndex(x => x.id === n.id);
    if (idx !== -1) notes[idx] = updated;
    socket.emit('update_note', updated);
  }
}

// Swap order strings between two notes
function swapOrders(a, b) {
  const aOrder = a.questionOrder;
  const bOrder = b.questionOrder;
  const updatedA = { ...a, questionOrder: bOrder };
  const updatedB = { ...b, questionOrder: aOrder };
  const idxA = notes.findIndex(n => n.id === a.id);
  const idxB = notes.findIndex(n => n.id === b.id);
  if (idxA !== -1) notes[idxA] = updatedA;
  if (idxB !== -1) notes[idxB] = updatedB;
  socket.emit('update_note', updatedA);
  socket.emit('update_note', updatedB);
  renderBoard();
}

// Set the order of a note. If another confirmed note already has this order, swap them.
function setQuestionOrder(noteId, newOrder) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !note.confirmed) return;
  newOrder = String(newOrder).trim();
  if (!isValidOrderString(newOrder)) return;
  if (compareOrders(newOrder, note.questionOrder) === 0) return;

  const conflict = notes.find(n =>
    n.confirmed && n.id !== noteId && n.questionOrder != null &&
    compareOrders(n.questionOrder, newOrder) === 0
  );

  if (conflict) {
    swapOrders(note, conflict);
    return;
  }

  const updated = { ...note, questionOrder: newOrder };
  const idx = notes.findIndex(x => x.id === note.id);
  if (idx !== -1) notes[idx] = updated;
  socket.emit('update_note', updated);
  renderBoard();
}

// Up/down: swap with adjacent in sorted order (works across levels)
function moveOrderUp(noteId) {
  const sorted = getSortedConfirmed();
  const idx = sorted.findIndex(n => n.id === noteId);
  if (idx <= 0) return;
  swapOrders(sorted[idx], sorted[idx - 1]);
}

function moveOrderDown(noteId) {
  const sorted = getSortedConfirmed();
  const idx = sorted.findIndex(n => n.id === noteId);
  if (idx === -1 || idx === sorted.length - 1) return;
  swapOrders(sorted[idx], sorted[idx + 1]);
}

// ============================================================
// Init
// ============================================================
function init() {
  if (!userName) showNameModal();
  else userNameEl.textContent = userName;
}

// ============================================================
// Socket events
// ============================================================
socket.on('connect', () => console.log('🟢 connected:', socket.id));

socket.on('state', (data) => {
  notes = (data && data.notes) || [];
  meta = (data && data.meta) || {};
  renderMeta();
  renderBoard();
});

socket.on('note_added', (note) => {
  if (notes.find(n => n.id === note.id)) return;
  notes.push(note);
  renderBoard();
  setTicker(`${note.createdBy}님이 [${getCat(note.category).ko}] 메모를 추가했습니다`);
});

socket.on('note_updated', (note) => {
  const idx = notes.findIndex(n => n.id === note.id);
  if (idx === -1) return;
  const prev = notes[idx];
  notes[idx] = note;
  if (editingId === note.id || draggingId === note.id) return;

  // Detect drag-only update (position changed, nothing else)
  const isDragOnly =
    prev &&
    (prev.x !== note.x || prev.y !== note.y) &&
    prev.text === note.text &&
    prev.confirmed === note.confirmed &&
    JSON.stringify(prev.cgIdeas || []) === JSON.stringify(note.cgIdeas || []) &&
    JSON.stringify(prev.comments || []) === JSON.stringify(note.comments || []) &&
    (prev.history || []).length === (note.history || []).length;

  renderBoard();
  if (!isDragOnly) {
    setTicker(`${note.lastEditedBy}님이 메모를 수정했습니다`);
  }
});

socket.on('note_deleted', (id) => {
  notes = notes.filter(n => n.id !== id);
  renderBoard();
  setTicker('메모가 삭제되었습니다');
});

socket.on('users_count', (count) => {
  connectedCountEl.textContent = count;
});

socket.on('meta_updated', (newMeta) => {
  const prevMeta = meta || {};
  const broadcastDateChanged =
    (prevMeta.broadcastDate || null) !== (newMeta.broadcastDate || null);

  // Detect any CG list-related change across both lists (A and B)
  let cgListChanged = false;
  let cgListPosOrTitleChanged = false;
  for (const id of ['A', 'B']) {
    const k1 = id === 'A' ? 'cgList' : 'cgListB';
    const k2 = k1 + 'Position';
    const k3 = k1 + 'Title';
    if (JSON.stringify(prevMeta[k1] || []) !== JSON.stringify(newMeta[k1] || [])) cgListChanged = true;
    if (JSON.stringify(prevMeta[k2] || null) !== JSON.stringify(newMeta[k2] || null)) cgListPosOrTitleChanged = true;
    if ((prevMeta[k3] || null) !== (newMeta[k3] || null)) cgListPosOrTitleChanged = true;
  }

  meta = newMeta;
  renderMeta();

  // Re-render board when CG list data, card position, or card title changed (only on canvas 'all')
  if ((cgListChanged || cgListPosOrTitleChanged) && activeFilter === 'all') renderBoard();

  if (broadcastDateChanged && newMeta.broadcastDate) {
    setTicker(`방송일이 ${formatBroadcastDate(newMeta.broadcastDate)}로 설정되었습니다`);
  } else if (cgListChanged) {
    setTicker('CG 리스트가 업데이트되었습니다');
  }
});

socket.on('reset_done', () => {
  setTicker('전체 메모가 초기화되었습니다 · 새 방송 준비를 시작하세요');
});

socket.on('disconnect', () => {
  setTicker('연결이 끊겼습니다. 다시 연결을 시도합니다...');
});

// ============================================================
// Meta (broadcast date)
// ============================================================
function formatBroadcastDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${KOREAN_DAYS[d.getDay()]})`;
}

function renderMeta() {
  if (meta.broadcastDate) {
    dateDisplayEl.textContent = `${formatBroadcastDate(meta.broadcastDate)} 방송`;
    dateInputEl.value = meta.broadcastDate;
  } else {
    dateDisplayEl.textContent = '방송일 설정';
    dateInputEl.value = '';
  }
}

document.getElementById('btn-date').addEventListener('click', () => {
  if (typeof dateInputEl.showPicker === 'function') {
    try { dateInputEl.showPicker(); return; } catch (e) {}
  }
  dateInputEl.click();
});

dateInputEl.addEventListener('change', (e) => {
  const v = e.target.value;
  if (!v) return;
  socket.emit('set_meta', { broadcastDate: v });
});

// ============================================================
// Filter
// ============================================================
document.querySelectorAll('.filter-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    activeFilter = pill.dataset.filter;
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.toggle('active', p === pill));
    renderBoard();
  });
});

function getVisibleNotes() {
  if (activeFilter === 'confirmed') return notes.filter(n => n.confirmed);
  if (activeFilter === 'cg') return notes.filter(n => (n.cgIdeas || []).length > 0);
  if (activeFilter === 'sequence') {
    return notes
      .filter(n => n.confirmed)
      .sort((a, b) => compareOrders(a.questionOrder, b.questionOrder));
  }
  return notes;
}

function updateCounts() {
  document.getElementById('count-all').textContent = notes.length;
  document.getElementById('count-confirmed').textContent = notes.filter(n => n.confirmed).length;
  // cg count = total CG ideas across all memos (not memo count)
  let cgCount = 0;
  for (const n of notes) cgCount += (n.cgIdeas || []).length;
  document.getElementById('count-cg').textContent = cgCount;
  const seqEl = document.getElementById('count-sequence');
  if (seqEl) seqEl.textContent = notes.filter(n => n.confirmed).length;
}

// ============================================================
// Render
// ============================================================
function renderBoard() {
  const isSequence = activeFilter === 'sequence';
  const isCGIdeas = activeFilter === 'cg';
  board.classList.toggle('is-sequence', isSequence);
  board.classList.toggle('is-cg-list', isCGIdeas);
  if (isSequence) ensureOrders();

  updateCounts();
  board.innerHTML = '';

  // CG ideas (brainstorm) — flat collection of every CG idea across memos
  if (isCGIdeas) {
    board.appendChild(renderCGList());
    recomputeBoardSize();
    return;
  }

  const visible = getVisibleNotes();

  if (visible.length === 0 && activeFilter !== 'all') {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    if (notes.length === 0) {
      empty.innerHTML = `
        <div class="empty-state-title">아직 비어있어요</div>
        <div class="empty-state-desc">우측 상단 ＋ 버튼으로 첫 메모를 추가해보세요</div>
      `;
    } else if (isSequence) {
      empty.innerHTML = `
        <div class="empty-state-title">확정된 메모가 없어요</div>
        <div class="empty-state-desc">메모 위 ✓ 버튼으로 확정 표시하면 자동으로 Q1, Q2... 순서가 매겨집니다</div>
      `;
    } else {
      empty.innerHTML = `
        <div class="empty-state-title">확정된 메모가 없어요</div>
        <div class="empty-state-desc">'전체' 필터를 눌러서 모든 메모를 볼 수 있습니다</div>
      `;
    }
    board.appendChild(empty);
    return;
  }

  if (isSequence) {
    const wrap = document.createElement('div');
    wrap.className = 'sequence-list';

    const help = document.createElement('div');
    help.className = 'sequence-help';
    help.innerHTML = `질문 순서 — <b>↑↓</b>로 한 칸씩 이동, <b>Q칩 탭</b>해서 직접 입력 (예: <b>2-1</b>로 서브 질문)`;
    wrap.appendChild(help);

    for (const note of visible) {
      wrap.appendChild(createNoteEl(note, true));
    }
    board.appendChild(wrap);
  } else {
    for (const note of visible) {
      board.appendChild(createNoteEl(note, false));
    }
    // On the canvas 'all' filter, render both CG list cards (A and B for two parties)
    if (activeFilter === 'all') {
      for (const listId of CG_LIST_IDS) {
        board.appendChild(createCGListCardEl(listId));
      }
    }
  }
  recomputeBoardSize();
}

// ============================================================
// CG list view (flat collection of all CG ideas across all memos)
// ============================================================
function renderCGList() {
  const wrap = document.createElement('div');
  wrap.className = 'cg-list-container';

  // Collect every CG idea with its parent note
  const items = [];
  for (const note of notes) {
    const cgIdeas = note.cgIdeas || [];
    for (const idea of cgIdeas) {
      items.push({ idea, note });
    }
  }

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.position = 'relative';
    empty.style.inset = 'auto';
    empty.style.marginTop = '60px';
    empty.innerHTML = `
      <div class="empty-state-title">아직 모인 CG 아이디어가 없어요</div>
      <div class="empty-state-desc">메모를 펼친 뒤 <b>＋ CG 아이디어</b> 로 추가할 수 있어요</div>
    `;
    wrap.appendChild(empty);
    return wrap;
  }

  const help = document.createElement('div');
  help.className = 'cg-list-help';
  help.innerHTML = `지금까지 모인 <b>CG 아이디어 ${items.length}개</b> — <b>↗</b> 누르면 원본 메모로 이동`;
  wrap.appendChild(help);

  // Newest first
  items.sort((a, b) => {
    const ta = new Date(a.idea.createdAt || 0).getTime();
    const tb = new Date(b.idea.createdAt || 0).getTime();
    return tb - ta;
  });

  for (const { idea, note } of items) {
    wrap.appendChild(createCGListItemEl(idea, note));
  }

  return wrap;
}

function createCGListItemEl(idea, note) {
  const cat = getCat(note.category);
  const fullText = note.text || '';
  const memoSnippet = fullText.slice(0, 60).trim() || '(빈 메모)';
  const truncated = fullText.length > 60 ? '…' : '';

  const el = document.createElement('div');
  el.className = 'cg-list-item';
  el.innerHTML = `
    <div class="cg-list-text">
      <div class="cg-list-text-main">${escapeHtml(idea.text)}</div>
      <div class="cg-list-meta">
        <span class="chip-cat-mini">
          <span class="cat-dot" style="background:${cat.color};"></span>
          <span>${cat.ko}</span>
        </span>
        <span class="memo-snippet">${escapeHtml(memoSnippet)}${truncated}</span>
        <span class="meta-sep">·</span>
        <span>${escapeHtml(idea.createdBy || '익명')}</span>
        <span class="meta-sep">·</span>
        <span>${formatTime(idea.createdAt)}</span>
      </div>
    </div>
    <div class="cg-list-actions">
      <button class="cg-list-action-btn" data-cgl-action="goto" title="원본 메모 보기">↗</button>
      <button class="cg-list-action-btn" data-cgl-action="remove" title="CG 아이디어 삭제">×</button>
    </div>
  `;

  el.querySelector('[data-cgl-action="remove"]').addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm('이 CG 아이디어를 삭제할까요?')) {
      removeCGIdea(note.id, idea.id);
    }
  });

  el.querySelector('[data-cgl-action="goto"]').addEventListener('click', (e) => {
    e.stopPropagation();
    // Switch to all view, then locate and pulse the parent memo
    activeFilter = 'all';
    document.querySelectorAll('.filter-pill').forEach(p =>
      p.classList.toggle('active', p.dataset.filter === 'all')
    );
    renderBoard();
    requestAnimationFrame(() => {
      const noteEl = board.querySelector(`[data-id="${note.id}"]`);
      if (!noteEl) return;
      noteEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      noteEl.classList.add('cg-pulse');
      setTimeout(() => noteEl.classList.remove('cg-pulse'), 1800);
    });
  });

  return el;
}

// ============================================================
// CG List cards on canvas (two cards: A and B for two parties)
// Each lives like a memo, position/title/items stored in meta.
// ============================================================
const CG_LIST_IDS = ['A', 'B'];
const CG_LIST_DEFAULTS = {
  A: { title: 'CG 리스트', position: { x: 40, y: 40 } },
  B: { title: 'CG 리스트 ②', position: { x: 40, y: 380 } },
};

// per-list input/title state — preserved across re-renders
const cgListInputState = {
  A: { value: '', focused: false },
  B: { value: '', focused: false },
};
const cgListTitleEditing = { A: false, B: false };

function cglKey(listId, suffix = '') {
  // A → 'cgList' / 'cgListPosition' / 'cgListTitle' (back-compat)
  // B → 'cgListB' / 'cgListBPosition' / 'cgListBTitle'
  const idPart = listId === 'A' ? '' : listId;
  return 'cgList' + idPart + suffix;
}

function getCGListItems(listId) {
  const v = meta[cglKey(listId)];
  return Array.isArray(v) ? v : [];
}

function getCGListPosition(listId) {
  return meta[cglKey(listId, 'Position')] || CG_LIST_DEFAULTS[listId].position;
}

function getCGListTitle(listId) {
  const v = meta[cglKey(listId, 'Title')];
  return (typeof v === 'string' && v.trim()) ? v : CG_LIST_DEFAULTS[listId].title;
}

function saveCGListMeta(listId, partial) {
  // partial keys: items, position, title
  const updates = {};
  if ('items' in partial) updates[cglKey(listId)] = partial.items;
  if ('position' in partial) updates[cglKey(listId, 'Position')] = partial.position;
  if ('title' in partial) updates[cglKey(listId, 'Title')] = partial.title;
  meta = { ...meta, ...updates };
  socket.emit('set_meta', updates);
}

function addCGListItem(listId, text, source) {
  const newItem = {
    id: 'cgl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    text,
    sourceNoteId: source ? source.noteId : null,
    sourceSnippet: source ? source.snippet : null,
    sourceCategory: source ? source.category : null,
    createdBy: userName,
    createdAt: new Date().toISOString(),
  };
  saveCGListMeta(listId, { items: [...getCGListItems(listId), newItem] });
  renderBoard();
}

function removeCGListItem(listId, itemId) {
  saveCGListMeta(listId, { items: getCGListItems(listId).filter(i => i.id !== itemId) });
  renderBoard();
}

// Hash a username to a stable hue for color-coding contributors
function userHue(name) {
  let hash = 0;
  const s = name || '익명';
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

function authorChipHtml(name) {
  const hue = userHue(name);
  return `<span class="cglc-author" style="color: hsl(${hue}, 55%, 38%); background: hsl(${hue}, 70%, 96%); border-color: hsl(${hue}, 50%, 85%);">${escapeHtml(name || '익명')}</span>`;
}

function createCGListCardEl(listId) {
  const items = getCGListItems(listId);
  const pos = getCGListPosition(listId);
  const title = getCGListTitle(listId);

  const el = document.createElement('div');
  el.className = 'cg-list-card';
  el.dataset.listId = listId;
  el.style.left = pos.x + 'px';
  el.style.top = pos.y + 'px';

  const itemsHtml = items.length === 0
    ? `<div class="cglc-empty">메모의 CG 아이디어 옆 <b>→</b> 또는<br/>아래 입력창으로 추가하세요</div>`
    : `<div class="cglc-list">
        ${items.map((item, i) => createCGListCardItemHtml(item, i + 1)).join('')}
      </div>`;

  el.innerHTML = `
    <div class="cglc-head" data-role="cglc-drag">
      <span class="cglc-icon">📺</span>
      <input type="text" class="cglc-title-input" data-role="cglc-title" value="${escapeHtml(title)}" maxlength="30" />
      ${items.length > 0 ? `<span class="cglc-count">${items.length}</span>` : ''}
    </div>
    <div class="cglc-body">${itemsHtml}</div>
    <div class="cglc-input-row">
      <span class="cglc-input-prefix">+</span>
      <textarea class="cglc-input" placeholder="새 CG 입력 — Enter로 줄바꿈, Cmd/Ctrl+Enter 또는 ↵로 추가" maxlength="300" rows="1"></textarea>
      <button class="cglc-submit-btn" data-role="cglc-submit" title="추가 (Cmd+Enter)">↵</button>
    </div>
  `;

  attachCGListCardHandlers(el, listId);
  return el;
}

function createCGListCardItemHtml(item, idx) {
  let sourceHtml = '';
  if (item.sourceNoteId) {
    const sourceNote = notes.find(n => n.id === item.sourceNoteId);
    if (sourceNote) {
      const cat = getCat(sourceNote.category || item.sourceCategory);
      sourceHtml = `<button class="cglc-source" data-cglist-action="goto" data-note-id="${sourceNote.id}" title="원본 메모 보기">
          <span class="cat-dot" style="background:${cat.color};"></span>
          <span>${cat.ko}</span>
          <span class="cglc-source-arrow">↗</span>
        </button>`;
    } else {
      sourceHtml = `<span class="cglc-source orphan">출처 삭제됨</span>`;
    }
  } else {
    sourceHtml = `<span class="cglc-source free">직접 입력</span>`;
  }

  return `
    <div class="cglc-item" data-item-id="${item.id}">
      <span class="cglc-num">${idx}.</span>
      <div class="cglc-content">
        <div class="cglc-text">${escapeHtml(item.text)}</div>
        <div class="cglc-meta">
          ${sourceHtml}
          ${authorChipHtml(item.createdBy)}
        </div>
      </div>
      <button class="cglc-remove" data-cglist-action="remove">×</button>
    </div>
  `;
}

function attachCGListCardHandlers(el, listId) {
  // Remove buttons
  el.querySelectorAll('[data-cglist-action="remove"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const itemEl = btn.closest('[data-item-id]');
      const itemId = itemEl ? itemEl.dataset.itemId : null;
      if (itemId && confirm('이 CG를 리스트에서 삭제할까요?')) {
        removeCGListItem(listId, itemId);
      }
    });
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  });

  // Goto source memo
  el.querySelectorAll('[data-cglist-action="goto"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const noteId = btn.dataset.noteId;
      const noteEl = board.querySelector(`[data-id="${noteId}"]`);
      if (!noteEl) return;
      noteEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      noteEl.classList.add('cg-pulse');
      setTimeout(() => noteEl.classList.remove('cg-pulse'), 1800);
    });
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  });

  // Title editing (click to edit, Enter to save, Escape to cancel)
  const titleInput = el.querySelector('[data-role="cglc-title"]');
  if (titleInput) {
    let originalTitle = getCGListTitle(listId);
    titleInput.addEventListener('focus', () => {
      cgListTitleEditing[listId] = true;
      originalTitle = titleInput.value;
      titleInput.select();
    });
    titleInput.addEventListener('blur', () => {
      cgListTitleEditing[listId] = false;
      const newTitle = (titleInput.value || '').trim();
      if (newTitle && newTitle !== originalTitle) {
        saveCGListMeta(listId, { title: newTitle });
      } else {
        titleInput.value = originalTitle;
      }
    });
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); titleInput.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); titleInput.value = originalTitle; titleInput.blur(); }
    });
    titleInput.addEventListener('pointerdown', (e) => e.stopPropagation());
    if (cgListTitleEditing[listId]) {
      setTimeout(() => titleInput.focus(), 30);
    }
  }

  // Item input (textarea — Enter is newline, Cmd/Ctrl+Enter submits)
  const input = el.querySelector('.cglc-input');
  const submitBtn = el.querySelector('[data-role="cglc-submit"]');
  const state = cgListInputState[listId];

  const submitItem = () => {
    const text = (state.value || '').trim();
    if (!text) return;
    addCGListItem(listId, text, null);
    state.value = '';
  };

  if (input && state) {
    input.value = state.value || '';
    const autoResize = () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    };
    autoResize();
    if (state.focused) {
      setTimeout(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        autoResize();
      }, 30);
    }
    input.addEventListener('input', (e) => {
      state.value = e.target.value;
      autoResize();
    });
    input.addEventListener('focus', () => { state.focused = true; });
    input.addEventListener('blur', () => { state.focused = false; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitItem();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        state.value = '';
        input.value = '';
        autoResize();
        input.blur();
      }
      // plain Enter: default behavior = insert newline
    });
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  if (submitBtn) {
    submitBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      submitItem();
    });
    submitBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // Drag the card via header background (not via title input)
  attachCGListCardDrag(el, listId);
}

function attachCGListCardDrag(el, listId) {
  const head = el.querySelector('[data-role="cglc-drag"]');
  if (!head) return;

  head.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    // Don't initiate drag if user pressed inside an editable element
    if (e.target.closest('input, textarea, button')) return;
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    const elRect = el.getBoundingClientRect();
    const boardRect = board.getBoundingClientRect();
    const offset = { x: startX - elRect.left, y: startY - elRect.top };
    let moved = false;
    const DRAG_THRESHOLD = 5;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        moved = true;
        el.classList.add('dragging');
      }
      if (moved) {
        ev.preventDefault();
        const x = Math.max(0, ev.clientX - boardRect.left - offset.x + board.scrollLeft);
        const y = Math.max(0, ev.clientY - boardRect.top - offset.y + board.scrollTop);
        el.style.left = x + 'px';
        el.style.top = y + 'px';

        const cw = el.offsetWidth;
        const ch = el.offsetHeight;
        if (x + cw + 200 > board.scrollWidth) {
          board.style.minWidth = (x + cw + 600) + 'px';
        }
        if (y + ch + 200 > board.scrollHeight) {
          board.style.minHeight = (y + ch + 600) + 'px';
        }
      }
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      el.classList.remove('dragging');
      if (moved) {
        const x = parseInt(el.style.left) || 0;
        const y = parseInt(el.style.top) || 0;
        saveCGListMeta(listId, { position: { x, y } });
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
}

// Grow board to fit notes (both directions) + buffer space.
function recomputeBoardSize() {
  if (activeFilter === 'sequence' || activeFilter === 'cg') {
    // List-style views size themselves naturally
    board.style.minWidth = '';
    board.style.minHeight = '';
    return;
  }
  const visible = getVisibleNotes();
  let maxRight = 0;
  let maxBottom = 0;
  for (const note of visible) {
    const noteEl = board.querySelector(`[data-id="${note.id}"]`);
    const w = noteEl ? noteEl.offsetWidth : 270;
    const h = noteEl ? noteEl.offsetHeight : 200;
    const right = (note.x || 0) + w;
    const bottom = (note.y || 0) + h;
    if (right > maxRight) maxRight = right;
    if (bottom > maxBottom) maxBottom = bottom;
  }
  // Also account for all CG list cards on the canvas (A, B)
  if (activeFilter === 'all') {
    for (const cardEl of board.querySelectorAll('.cg-list-card')) {
      const lid = cardEl.dataset.listId;
      const pos = lid ? getCGListPosition(lid) : { x: 0, y: 0 };
      const cright = pos.x + (cardEl.offsetWidth || 340);
      const cbottom = pos.y + (cardEl.offsetHeight || 200);
      if (cright > maxRight) maxRight = cright;
      if (cbottom > maxBottom) maxBottom = cbottom;
    }
  }
  const buffer = 500;
  // Default: at least the visible viewport area
  const defaultMinW = board.clientWidth || 600;
  const defaultMinH = board.clientHeight || 600;
  board.style.minWidth = Math.max(defaultMinW, maxRight + buffer) + 'px';
  board.style.minHeight = Math.max(defaultMinH, maxBottom + buffer) + 'px';
}

window.addEventListener('resize', () => {
  recomputeBoardSize();
});

function createNoteEl(note, isSequence = false) {
  const el = document.createElement('div');
  el.className = 'note';
  if (note.confirmed) el.classList.add('confirmed');
  el.dataset.id = note.id;
  el.dataset.category = note.category || 'memo';
  if (!isSequence) {
    el.style.left = note.x + 'px';
    el.style.top = note.y + 'px';
  }

  const cat = getCat(note.category);
  const text = note.text || '';
  const isEmpty = !text.trim();
  const cgIdeas = note.cgIdeas || [];
  const comments = note.comments || [];
  const history = note.history || [];
  const isCgInputOpen = cgInputState && cgInputState.noteId === note.id;
  const isComInputOpen = commentInputState && commentInputState.noteId === note.id;
  const isHistoryOpen = expandedHistory.has(note.id);
  const qOrder = note.questionOrder;

  // Action buttons differ in sequence mode
  const actionsHtml = isSequence ? `
    <button class="note-action-btn move-up" data-action="move-up" title="위로">↑</button>
    <button class="note-action-btn move-down" data-action="move-down" title="아래로">↓</button>
    <button class="note-action-btn is-delete" data-action="delete" title="삭제">×</button>
  ` : `
    <button class="note-action-btn is-confirm ${note.confirmed ? 'active' : ''}" data-action="confirm" title="확정 ${note.confirmed ? '해제' : '표시'}">✓</button>
    <button class="note-action-btn is-delete" data-action="delete" title="삭제">×</button>
  `;

  // In sequence mode, indent sub-questions visually by depth
  if (isSequence && qOrder) {
    const depth = Math.max(0, parseOrder(qOrder).length - 1);
    if (depth > 0) {
      el.style.marginLeft = (depth * 32) + 'px';
      el.dataset.depth = String(depth);
    }
  }

  el.innerHTML = `
    <div class="note-head">
      <span class="chip chip-cat">
        <span class="cat-dot" style="background:${cat.color};"></span>
        <span>${cat.ko}</span>
      </span>
      ${note.confirmed ? '<span class="chip chip-confirmed">✓ 확정</span>' : ''}
      ${qOrder ? `<span class="chip chip-q" data-action="set-order">Q${qOrder}</span>` : ''}
      ${cgIdeas.length > 0 ? `<span class="chip chip-cg">● CG ${cgIdeas.length}</span>` : ''}
      <div class="note-actions">${actionsHtml}</div>
    </div>
    <div class="note-body ${isEmpty ? 'placeholder' : ''}" data-role="body">${
      isEmpty ? '터치하여 메모 입력...' : escapeHtml(text)
    }</div>
    ${renderCGSection(note, cgIdeas, isCgInputOpen)}
    ${renderCommentsSection(note, comments, isComInputOpen)}
    <div class="note-foot">
      <span class="foot-left">
        <span>${escapeHtml(note.createdBy || '익명')}</span>
        <span>·</span>
        <span>${formatTime(note.createdAt)}</span>
      </span>
      ${history.length > 0 ? `
        <button class="history-toggle ${isHistoryOpen ? 'expanded' : ''}" data-action="toggle-history">
          수정 ${history.length}<span class="chevron">▾</span>
        </button>
      ` : ''}
    </div>
    ${isHistoryOpen ? renderHistoryPanel(history) : ''}
  `;

  attachNoteHandlers(el, note, isSequence);
  return el;
}

function renderCGSection(note, cgIdeas, isInputOpen) {
  if (cgIdeas.length === 0 && !isInputOpen) {
    return `<button class="cg-add-btn-empty" data-cg-action="open-input" data-note-id="${note.id}">+ CG 아이디어 추가</button>`;
  }

  const itemsHtml = cgIdeas.map(idea => `
    <div class="note-cg-item" data-idea-id="${idea.id}">
      <span class="bullet">•</span>
      <span class="text">${escapeHtml(idea.text)}</span>
      <button class="promote-cgl" data-cg-action="promote" data-note-id="${note.id}" data-idea-id="${idea.id}" title="CG 리스트로 채택">→</button>
      <button class="remove" data-cg-action="remove" data-note-id="${note.id}" data-idea-id="${idea.id}">×</button>
    </div>
  `).join('');

  const inputHtml = isInputOpen ? `
    <div class="cg-input-row">
      <input type="text" class="cg-input" placeholder="CG 아이디어 입력 후 Enter..." maxlength="80">
    </div>
  ` : `
    <button class="cg-add-link" data-cg-action="open-input" data-note-id="${note.id}">+ 아이디어 더 추가</button>
  `;

  return `
    <div class="note-cg-section">
      <div class="note-cg-header">
        <span class="cg-dot"></span>
        <span>CG IDEAS</span>
      </div>
      <div class="note-cg-list">${itemsHtml}</div>
      ${inputHtml}
    </div>
  `;
}

function renderCommentsSection(note, comments, isInputOpen) {
  if (comments.length === 0 && !isInputOpen) {
    return `<button class="com-add-btn-empty" data-com-action="open-input" data-note-id="${note.id}">+ 코멘트 추가</button>`;
  }

  const itemsHtml = comments.map(c => `
    <div class="note-comment-item" data-comment-id="${c.id}">
      <span class="author">${escapeHtml(c.createdBy || '익명')}</span>
      <span class="body">${escapeHtml(c.text)}<span class="when">${formatTime(c.createdAt)}</span></span>
      <button class="remove" data-com-action="remove" data-note-id="${note.id}" data-comment-id="${c.id}">×</button>
    </div>
  `).join('');

  const inputHtml = isInputOpen ? `
    <div class="com-input-row">
      <input type="text" class="com-input" placeholder="코멘트 입력 후 Enter..." maxlength="200">
    </div>
  ` : `
    <button class="com-add-link" data-com-action="open-input" data-note-id="${note.id}">+ 코멘트 더 추가</button>
  `;

  return `
    <div class="note-comments-section">
      <div class="note-comments-header">
        <span class="com-dot"></span>
        <span>COMMENTS</span>
      </div>
      <div class="note-comments-list">${itemsHtml}</div>
      ${inputHtml}
    </div>
  `;
}

function renderHistoryPanel(history) {
  // Show most recent first
  const reversed = [...history].reverse();
  const itemsHtml = reversed.map(h => `
    <div class="history-item">
      <span class="when">${formatTime(h.at)}</span>
      <span class="who">${escapeHtml(h.by || '익명')}</span>
      <span class="what">${escapeHtml(h.summary || h.action || '')}</span>
    </div>
  `).join('');

  return `
    <div class="note-history-panel">
      <div class="note-history-header">수정 기록</div>
      <div class="note-history-list">${itemsHtml}</div>
    </div>
  `;
}

// ============================================================
// Note interaction handlers
// ============================================================
function attachNoteHandlers(el, note, isSequence = false) {
  // Header buttons (confirm, delete, move-up, move-down, set-order, history toggle)
  el.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === 'delete') {
        if (confirm(`이 메모를 삭제할까요?`)) {
          notes = notes.filter(n => n.id !== note.id);
          renderBoard();
          socket.emit('delete_note', note.id);
        }
      } else if (action === 'confirm') {
        toggleFlag(note, 'confirmed');
      } else if (action === 'toggle-history') {
        toggleHistory(note.id);
      } else if (action === 'move-up') {
        moveOrderUp(note.id);
      } else if (action === 'move-down') {
        moveOrderDown(note.id);
      } else if (action === 'set-order') {
        const input = prompt(
          `질문 순서를 입력하세요\n` +
          `예) 1, 2, 3 또는 2-1, 2-2 (서브질문)\n` +
          `현재: Q${note.questionOrder}`,
          note.questionOrder
        );
        if (input == null) return;
        const trimmed = input.trim();
        if (!trimmed) return;
        if (isValidOrderString(trimmed)) {
          setQuestionOrder(note.id, trimmed);
        } else {
          alert('형식이 올바르지 않아요.\n숫자 또는 1-2, 3-1 형태로 입력해주세요.');
        }
      }
    });
  });

  // CG actions
  el.querySelectorAll('[data-cg-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cgAction = btn.dataset.cgAction;
      if (cgAction === 'open-input') startCGInput(note.id);
      else if (cgAction === 'remove') removeCGIdea(note.id, btn.dataset.ideaId);
      else if (cgAction === 'promote') promoteCGIdeaToList(note.id, btn.dataset.ideaId);
    });
  });

  // Comment actions
  el.querySelectorAll('[data-com-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const comAction = btn.dataset.comAction;
      if (comAction === 'open-input') startCommentInput(note.id);
      else if (comAction === 'remove') removeComment(note.id, btn.dataset.commentId);
    });
  });

  // CG input wiring
  const cgInput = el.querySelector('.cg-input');
  if (cgInput && cgInputState && cgInputState.noteId === note.id) {
    cgInput.value = cgInputState.value || '';
    setTimeout(() => cgInput.focus(), 30);
    cgInput.addEventListener('input', (e) => { cgInputState.value = e.target.value; });
    cgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); endCGInput(true); }
      else if (e.key === 'Escape') { e.preventDefault(); endCGInput(false); }
    });
    cgInput.addEventListener('blur', () => {
      setTimeout(() => {
        if (cgInputState && cgInputState.noteId === note.id) endCGInput(true);
      }, 150);
    });
    cgInput.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // Comment input wiring
  const comInput = el.querySelector('.com-input');
  if (comInput && commentInputState && commentInputState.noteId === note.id) {
    comInput.value = commentInputState.value || '';
    setTimeout(() => comInput.focus(), 30);
    comInput.addEventListener('input', (e) => { commentInputState.value = e.target.value; });
    comInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); endCommentInput(true); }
      else if (e.key === 'Escape') { e.preventDefault(); endCommentInput(false); }
    });
    comInput.addEventListener('blur', () => {
      setTimeout(() => {
        if (commentInputState && commentInputState.noteId === note.id) endCommentInput(true);
      }, 150);
    });
    comInput.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // ===== Unified pointer interaction (drag + tap-to-edit) =====
  const body = el.querySelector('[data-role="body"]');

  // In sequence mode, we don't drag the card around (only ↑↓ buttons reorder).
  // Body click still opens the editor.
  if (isSequence) {
    if (body) {
      body.addEventListener('click', (e) => {
        e.stopPropagation();
        if (editingId === note.id) return;
        startEdit(el, body, note);
      });
    }
    return;
  }

  el.addEventListener('pointerdown', (e) => {
    // Skip if interacting with buttons / inputs / contenteditable / cg / comments / history
    if (e.target.tagName === 'BUTTON') return;
    if (e.target.tagName === 'INPUT') return;
    if (e.target.closest('[contenteditable="true"]')) return;
    if (e.target.closest('.note-cg-section')) return;
    if (e.target.closest('.cg-add-btn-empty')) return;
    if (e.target.closest('.note-comments-section')) return;
    if (e.target.closest('.com-add-btn-empty')) return;
    if (e.target.closest('.note-history-panel')) return;
    if (e.target.closest('.history-toggle')) return;
    if (editingId === note.id) return;

    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const isOnBody = body && (e.target === body || body.contains(e.target));

    const elRect = el.getBoundingClientRect();
    const offset = { x: startX - elRect.left, y: startY - elRect.top };
    let moved = false;

    try { el.setPointerCapture(e.pointerId); } catch (err) {}

    const boardRect = board.getBoundingClientRect();

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        moved = true;
        draggingId = note.id;
        el.classList.add('dragging');
      }
      if (moved) {
        ev.preventDefault();
        const x = Math.max(0, ev.clientX - boardRect.left - offset.x + board.scrollLeft);
        const y = Math.max(0, ev.clientY - boardRect.top - offset.y + board.scrollTop);
        el.style.left = x + 'px';
        el.style.top = y + 'px';

        // Grow board live in either direction if dragging near or past edges
        const noteW = el.offsetWidth;
        const noteH = el.offsetHeight;
        if (x + noteW + 200 > board.scrollWidth) {
          board.style.minWidth = (x + noteW + 600) + 'px';
        }
        if (y + noteH + 200 > board.scrollHeight) {
          board.style.minHeight = (y + noteH + 600) + 'px';
        }
      }
    };

    const onUp = (ev) => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}

      if (moved) {
        el.classList.remove('dragging');
        const x = parseInt(el.style.left) || 0;
        const y = parseInt(el.style.top) || 0;
        draggingId = null;
        if (x !== note.x || y !== note.y) {
          // Drag = position only. NEVER touch createdBy / lastEditedBy / history.
          const updated = { ...note, x, y };
          const idx = notes.findIndex(n => n.id === note.id);
          if (idx !== -1) notes[idx] = updated;
          socket.emit('update_note', updated);
        }
      } else if (isOnBody && body) {
        startEdit(el, body, note);
      }
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
}

function toggleFlag(note, key) {
  // Special handling for confirmed → manage questionOrder
  if (key === 'confirmed') {
    if (note.confirmed) {
      // Unconfirming: just clear order. No auto-shift (hierarchical numbering — let user re-arrange manually).
      const updated = {
        ...note,
        confirmed: false,
        questionOrder: null,
        history: appendHistory(note, makeHistoryEntry('unconfirm', '확정 해제')),
        lastEditedBy: userName,
        lastEditedAt: new Date().toISOString(),
      };
      const idx = notes.findIndex(n => n.id === note.id);
      if (idx !== -1) notes[idx] = updated;
      socket.emit('update_note', updated);
    } else {
      // Confirming: assign next top-level number as string
      const nextOrder = String(maxTopLevelOrder() + 1);
      const updated = {
        ...note,
        confirmed: true,
        questionOrder: nextOrder,
        history: appendHistory(note, makeHistoryEntry('confirm', `확정 (Q${nextOrder})`)),
        lastEditedBy: userName,
        lastEditedAt: new Date().toISOString(),
      };
      const idx = notes.findIndex(n => n.id === note.id);
      if (idx !== -1) notes[idx] = updated;
      socket.emit('update_note', updated);
    }
    renderBoard();
    return;
  }

  // Other flags: simple toggle
  const wasOn = !!note[key];
  const summary = `${key} ${wasOn ? '해제' : '표시'}`;
  const updated = {
    ...note,
    [key]: !note[key],
    history: appendHistory(note, makeHistoryEntry(key, summary)),
    lastEditedBy: userName,
    lastEditedAt: new Date().toISOString(),
  };
  const idx = notes.findIndex(n => n.id === note.id);
  if (idx !== -1) notes[idx] = updated;
  socket.emit('update_note', updated);
  renderBoard();
}

// ============================================================
// CG ideas
// ============================================================
function startCGInput(noteId) {
  cgInputState = { noteId, value: '' };
  renderBoard();
}

function endCGInput(commit) {
  if (!cgInputState) return;
  const { noteId, value } = cgInputState;
  cgInputState = null;
  const trimmed = (value || '').trim();
  if (commit && trimmed) addCGIdea(noteId, trimmed);
  else renderBoard();
}

function addCGIdea(noteId, text) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  const newIdea = {
    id: 'cg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    text,
    createdBy: userName,
    createdAt: new Date().toISOString(),
  };
  const updated = {
    ...note,
    cgIdeas: [...(note.cgIdeas || []), newIdea],
    history: appendHistory(note, makeHistoryEntry('cg_add', `CG 추가: "${text.length > 20 ? text.slice(0, 20) + '…' : text}"`)),
    lastEditedBy: userName,
    lastEditedAt: new Date().toISOString(),
  };
  const idx = notes.findIndex(n => n.id === noteId);
  if (idx !== -1) notes[idx] = updated;
  socket.emit('update_note', updated);
  renderBoard();
}

function removeCGIdea(noteId, ideaId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  const updated = {
    ...note,
    cgIdeas: (note.cgIdeas || []).filter(i => i.id !== ideaId),
    lastEditedBy: userName,
    lastEditedAt: new Date().toISOString(),
  };
  const idx = notes.findIndex(n => n.id === noteId);
  if (idx !== -1) notes[idx] = updated;
  socket.emit('update_note', updated);
  renderBoard();
}

// ============================================================
// Promote a CG idea (from a memo) to a CG list card
// Default target is list A (first card). Removes idea from memo, adds to list.
// ============================================================
function promoteCGIdeaToList(noteId, ideaId, targetListId = 'A') {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  const idea = (note.cgIdeas || []).find(i => i.id === ideaId);
  if (!idea) return;

  const snippet = (note.text || '').slice(0, 30).trim() || '(빈 메모)';
  addCGListItem(targetListId, idea.text, {
    noteId: note.id,
    snippet,
    category: note.category,
  });

  const updated = {
    ...note,
    cgIdeas: (note.cgIdeas || []).filter(i => i.id !== ideaId),
    history: appendHistory(note, makeHistoryEntry('cgl_promote', `CG 채택: "${idea.text.length > 20 ? idea.text.slice(0, 20) + '…' : idea.text}"`)),
    lastEditedBy: userName,
    lastEditedAt: new Date().toISOString(),
  };
  const idx = notes.findIndex(n => n.id === noteId);
  if (idx !== -1) notes[idx] = updated;
  socket.emit('update_note', updated);
  renderBoard();
}

// ============================================================
// Comments
// ============================================================
function startCommentInput(noteId) {
  commentInputState = { noteId, value: '' };
  renderBoard();
}

function endCommentInput(commit) {
  if (!commentInputState) return;
  const { noteId, value } = commentInputState;
  commentInputState = null;
  const trimmed = (value || '').trim();
  if (commit && trimmed) addComment(noteId, trimmed);
  else renderBoard();
}

function addComment(noteId, text) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  const newComment = {
    id: 'cm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    text,
    createdBy: userName,
    createdAt: new Date().toISOString(),
  };
  const updated = {
    ...note,
    comments: [...(note.comments || []), newComment],
    history: appendHistory(note, makeHistoryEntry('comment_add', `코멘트: "${text.length > 20 ? text.slice(0, 20) + '…' : text}"`)),
    lastEditedBy: userName,
    lastEditedAt: new Date().toISOString(),
  };
  const idx = notes.findIndex(n => n.id === noteId);
  if (idx !== -1) notes[idx] = updated;
  socket.emit('update_note', updated);
  renderBoard();
}

function removeComment(noteId, commentId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  const updated = {
    ...note,
    comments: (note.comments || []).filter(c => c.id !== commentId),
    lastEditedBy: userName,
    lastEditedAt: new Date().toISOString(),
  };
  const idx = notes.findIndex(n => n.id === noteId);
  if (idx !== -1) notes[idx] = updated;
  socket.emit('update_note', updated);
  renderBoard();
}

function toggleHistory(noteId) {
  if (expandedHistory.has(noteId)) expandedHistory.delete(noteId);
  else expandedHistory.add(noteId);
  renderBoard();
}

// ============================================================
// Edit memo body
// ============================================================
function startEdit(el, body, note) {
  editingId = note.id;
  body.classList.remove('placeholder');
  body.contentEditable = 'true';
  body.textContent = note.text || '';
  body.focus();

  // Place cursor at end
  try {
    const range = document.createRange();
    range.selectNodeContents(body);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) {}

  const finish = () => {
    body.contentEditable = 'false';
    body.removeEventListener('blur', finish);
    body.removeEventListener('keydown', keyHandler);
    const newText = body.textContent.trim();
    editingId = null;

    if (newText !== (note.text || '').trim()) {
      const entry = makeHistoryEntry('edit_text', '본문 수정');
      const updated = {
        ...note,
        text: newText,
        history: appendHistory(note, entry),
        lastEditedBy: userName,
        lastEditedAt: new Date().toISOString(),
      };
      const idx = notes.findIndex(n => n.id === note.id);
      if (idx !== -1) notes[idx] = updated;
      socket.emit('update_note', updated);
    }
    renderBoard();
  };

  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      body.textContent = note.text || '';
      body.blur();
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      body.blur();
    }
  };

  body.addEventListener('blur', finish);
  body.addEventListener('keydown', keyHandler);
}

// ============================================================
// Add note
// ============================================================
document.getElementById('btn-add').addEventListener('click', () => {
  if (!userName) { showNameModal(); return; }
  showCategoryModal();
});

function showCategoryModal() {
  const modal = document.getElementById('category-modal');
  modal.classList.remove('hidden');
  modal.querySelectorAll('.category-option').forEach(opt => {
    opt.onclick = () => {
      const cat = opt.dataset.category;
      modal.classList.add('hidden');
      addNote(cat);
    };
  });
  modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };
}

function addNote(category) {
  if (activeFilter !== 'all') {
    activeFilter = 'all';
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.toggle('active', p.dataset.filter === 'all'));
  }
  const noteWidth = window.innerWidth <= 380 ? 220 : (window.innerWidth <= 768 ? 240 : 270);

  // Place new note inside the currently-visible portion of the board's scroll area.
  const visW = board.clientWidth;
  const visH = board.clientHeight;
  const xRange = Math.max(60, visW - noteWidth - 60);
  const yRange = Math.max(60, visH * 0.4);
  const xInBoard = board.scrollLeft + 30 + Math.random() * xRange;
  const yInBoard = board.scrollTop + 40 + Math.random() * yRange;

  const note = {
    id: 'n_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    x: xInBoard,
    y: yInBoard,
    text: '',
    category,
    confirmed: false,
    questionOrder: null,
    cgIdeas: [],
    comments: [],
    history: [makeHistoryEntry('create', '메모 생성')],
    createdBy: userName,
    createdAt: new Date().toISOString(),
    lastEditedBy: userName,
    lastEditedAt: new Date().toISOString(),
  };
  notes.push(note);
  socket.emit('add_note', note);
  renderBoard();
  setTimeout(() => {
    const newEl = board.querySelector(`[data-id="${note.id}"]`);
    if (newEl) {
      const body = newEl.querySelector('[data-role="body"]');
      startEdit(newEl, body, note);
    }
  }, 80);
}

// ============================================================
// Name modal
// ============================================================
function showNameModal() {
  const modal = document.getElementById('name-modal');
  const input = document.getElementById('name-input');
  const saveBtn = document.getElementById('name-save');
  modal.classList.remove('hidden');
  input.value = userName || '';
  setTimeout(() => input.focus(), 100);

  const save = () => {
    const v = input.value.trim();
    if (!v) return;
    userName = v;
    localStorage.setItem('mp_user_name', v);
    userNameEl.textContent = v;
    modal.classList.add('hidden');
  };

  saveBtn.onclick = save;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape' && userName) modal.classList.add('hidden');
  };
  modal.onclick = (e) => { if (e.target === modal && userName) modal.classList.add('hidden'); };
}

document.getElementById('btn-change-name').addEventListener('click', (e) => {
  e.stopPropagation();
  showNameModal();
});

// On mobile, tapping the user pill itself opens the rename modal (since the '변경' link is hidden)
userPillEl.addEventListener('click', (e) => {
  if (e.target.id === 'btn-change-name') return; // already handled
  if (window.matchMedia('(max-width: 768px)').matches) showNameModal();
});

// ============================================================
// Kebab menu + Reset
// ============================================================
const kebabBtn = document.getElementById('btn-menu');
const kebabMenu = document.getElementById('kebab-menu');

kebabBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  kebabMenu.classList.toggle('hidden');
});

document.addEventListener('click', () => {
  kebabMenu.classList.add('hidden');
});

document.querySelector('.kebab-item[data-action="reset"]').addEventListener('click', () => {
  kebabMenu.classList.add('hidden');
  document.getElementById('reset-modal').classList.remove('hidden');
});

document.getElementById('reset-cancel').addEventListener('click', () => {
  document.getElementById('reset-modal').classList.add('hidden');
});

document.getElementById('reset-confirm').addEventListener('click', () => {
  socket.emit('reset_all');
  document.getElementById('reset-modal').classList.add('hidden');
});

document.getElementById('reset-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('reset-modal')) {
    document.getElementById('reset-modal').classList.add('hidden');
  }
});

// ============================================================
// Helpers
// ============================================================
function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '방금';
  if (diff < 3600) return Math.floor(diff / 60) + '분 전';
  if (diff < 86400) return Math.floor(diff / 3600) + '시간 전';
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = String(s ?? '');
  return div.innerHTML;
}

let tickerTimer;
function setTicker(msg) {
  tickerEl.textContent = msg;
  clearTimeout(tickerTimer);
  tickerTimer = setTimeout(() => {
    tickerEl.textContent = '실시간 협업 보드 · 메모를 추가하면 다른 접속자에게 즉시 반영됩니다';
  }, 6000);
}

setInterval(() => {
  if (!editingId && !draggingId && !cgInputState && !commentInputState) renderBoard();
}, 60000);

init();
