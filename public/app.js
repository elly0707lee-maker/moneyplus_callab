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
// Question Order helpers
// ============================================================
function maxConfirmedOrder(excludeId) {
  let max = 0;
  for (const n of notes) {
    if (excludeId && n.id === excludeId) continue;
    if (n.confirmed && n.questionOrder) {
      if (n.questionOrder > max) max = n.questionOrder;
    }
  }
  return max;
}

// Ensure all confirmed notes have a questionOrder. Assigns missing ones in array order.
function ensureOrders() {
  const confirmed = notes.filter(n => n.confirmed);
  const withoutOrder = confirmed.filter(n => !n.questionOrder);
  if (withoutOrder.length === 0) return;

  let next = maxConfirmedOrder() + 1;
  for (const n of withoutOrder) {
    const updated = { ...n, questionOrder: next++ };
    const idx = notes.findIndex(x => x.id === n.id);
    if (idx !== -1) notes[idx] = updated;
    socket.emit('update_note', updated);
  }
}

// Set a confirmed note to a specific order, shifting others as needed.
function setQuestionOrder(noteId, newOrder) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !note.confirmed) return;

  const max = maxConfirmedOrder();
  newOrder = Math.max(1, Math.min(max, newOrder));
  const oldOrder = note.questionOrder || max + 1;
  if (newOrder === oldOrder) return;

  const updates = [];
  for (const n of notes) {
    if (n.id === note.id) continue;
    if (!n.confirmed || !n.questionOrder) continue;

    let newOrd = n.questionOrder;
    if (newOrder > oldOrder && n.questionOrder > oldOrder && n.questionOrder <= newOrder) {
      newOrd = n.questionOrder - 1;
    } else if (newOrder < oldOrder && n.questionOrder >= newOrder && n.questionOrder < oldOrder) {
      newOrd = n.questionOrder + 1;
    }
    if (newOrd !== n.questionOrder) {
      const updated = { ...n, questionOrder: newOrd };
      const idx = notes.findIndex(x => x.id === n.id);
      if (idx !== -1) notes[idx] = updated;
      updates.push(updated);
    }
  }

  const updatedSelf = { ...note, questionOrder: newOrder };
  const selfIdx = notes.findIndex(x => x.id === note.id);
  if (selfIdx !== -1) notes[selfIdx] = updatedSelf;
  updates.push(updatedSelf);

  for (const u of updates) socket.emit('update_note', u);
  renderBoard();
}

function moveOrderUp(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !note.questionOrder || note.questionOrder <= 1) return;
  setQuestionOrder(noteId, note.questionOrder - 1);
}

function moveOrderDown(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !note.questionOrder) return;
  const max = maxConfirmedOrder();
  if (note.questionOrder >= max) return;
  setQuestionOrder(noteId, note.questionOrder + 1);
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
  meta = newMeta;
  renderMeta();
  if (newMeta.broadcastDate) {
    setTicker(`방송일이 ${formatBroadcastDate(newMeta.broadcastDate)}로 설정되었습니다`);
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
      .sort((a, b) => (a.questionOrder || 999) - (b.questionOrder || 999));
  }
  return notes;
}

function updateCounts() {
  document.getElementById('count-all').textContent = notes.length;
  document.getElementById('count-confirmed').textContent = notes.filter(n => n.confirmed).length;
  document.getElementById('count-cg').textContent = notes.filter(n => (n.cgIdeas || []).length > 0).length;
  const seqEl = document.getElementById('count-sequence');
  if (seqEl) seqEl.textContent = notes.filter(n => n.confirmed).length;
}

// ============================================================
// Render
// ============================================================
function renderBoard() {
  const isSequence = activeFilter === 'sequence';
  board.classList.toggle('is-sequence', isSequence);
  if (isSequence) ensureOrders();

  updateCounts();
  board.innerHTML = '';

  const visible = getVisibleNotes();

  if (visible.length === 0) {
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
      const filterName = activeFilter === 'confirmed' ? '확정된' : 'CG 아이디어가 있는';
      empty.innerHTML = `
        <div class="empty-state-title">${filterName} 메모가 없어요</div>
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
    help.innerHTML = `질문 순서 — <b>↑↓ 버튼</b>으로 한 칸씩 이동, <b>Q 칩 탭</b>하면 원하는 위치로 한번에 이동`;
    wrap.appendChild(help);

    for (const note of visible) {
      wrap.appendChild(createNoteEl(note, true));
    }
    board.appendChild(wrap);
  } else {
    for (const note of visible) {
      board.appendChild(createNoteEl(note, false));
    }
  }
  recomputeBoardSize();
}

// Grow board to fit notes (both directions) + buffer space.
function recomputeBoardSize() {
  if (activeFilter === 'sequence') {
    // Sequence is a normal vertical list — let it size itself naturally.
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
    <button class="note-action-btn move-up" data-action="move-up" title="위로 (Q${qOrder ? qOrder - 1 : ''})">↑</button>
    <button class="note-action-btn move-down" data-action="move-down" title="아래로 (Q${qOrder ? qOrder + 1 : ''})">↓</button>
    <button class="note-action-btn is-delete" data-action="delete" title="삭제">×</button>
  ` : `
    <button class="note-action-btn is-confirm ${note.confirmed ? 'active' : ''}" data-action="confirm" title="확정 ${note.confirmed ? '해제' : '표시'}">✓</button>
    <button class="note-action-btn is-delete" data-action="delete" title="삭제">×</button>
  `;

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
        const max = maxConfirmedOrder();
        const input = prompt(`질문 순서를 입력하세요 (1 ~ ${max})\n현재: Q${note.questionOrder}`, note.questionOrder);
        if (input == null) return;
        const newOrder = parseInt(input);
        if (Number.isFinite(newOrder) && newOrder >= 1 && newOrder <= max) {
          setQuestionOrder(note.id, newOrder);
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
      // Unconfirming: clear order, shift others down
      const removedOrder = note.questionOrder;
      if (removedOrder) {
        for (const n of notes) {
          if (n.id === note.id) continue;
          if (n.confirmed && n.questionOrder && n.questionOrder > removedOrder) {
            const shifted = { ...n, questionOrder: n.questionOrder - 1 };
            const idx = notes.findIndex(x => x.id === n.id);
            if (idx !== -1) notes[idx] = shifted;
            socket.emit('update_note', shifted);
          }
        }
      }
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
      // Confirming: assign next available order
      const nextOrder = maxConfirmedOrder() + 1;
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
