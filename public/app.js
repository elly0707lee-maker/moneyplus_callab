// ===== Money Plus Board · 4자토크 연구실 =====
const socket = io();
let userName = localStorage.getItem('mp_user_name') || null;
let notes = [];
let meta = {};
let editingId = null;
let draggingId = null;
let dragOffset = { x: 0, y: 0 };
let activeFilter = 'all';
let cgInputState = null; // { noteId, value }

const board = document.getElementById('board');
const userNameEl = document.getElementById('user-name');
const connectedCountEl = document.getElementById('connected-count');
const tickerEl = document.getElementById('ticker');
const dateDisplayEl = document.getElementById('date-display');
const dateInputEl = document.getElementById('date-input');

const CATEGORY_LABELS = {
  index:   { ko: '지수',          en: 'INDEX',    color: '#5290cf' },
  sector:  { ko: '섹터',          en: 'SECTOR',   color: '#5fa885' },
  stocks:  { ko: '종목',          en: 'STOCKS',   color: '#d27a5a' },
  supply:  { ko: '수급',          en: 'SUPPLY',   color: '#8e74bb' },
  us:      { ko: '미증시',        en: 'US',       color: '#3a5a82' },
  news:    { ko: '뉴스',          en: 'NEWS',     color: '#b89e44' },
  caster:  { ko: '캐스터 브리핑', en: 'CASTER',   color: '#b66890' },
};

const KOREAN_DAYS = ['일', '월', '화', '수', '목', '금', '토'];

function getCat(key) {
  return CATEGORY_LABELS[key] || { ko: '기타', en: 'OTHER', color: '#8a96a8' };
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
  notes[idx] = note;
  if (editingId === note.id || draggingId === note.id) return;
  renderBoard();
  setTicker(`${note.lastEditedBy}님이 메모를 수정했습니다`);
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
  if (dateInputEl.showPicker) dateInputEl.showPicker();
  else dateInputEl.click();
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
  return notes;
}

function updateCounts() {
  document.getElementById('count-all').textContent = notes.length;
  document.getElementById('count-confirmed').textContent = notes.filter(n => n.confirmed).length;
  document.getElementById('count-cg').textContent = notes.filter(n => (n.cgIdeas || []).length > 0).length;
}

// ============================================================
// Render
// ============================================================
function renderBoard() {
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

  for (const note of visible) {
    board.appendChild(createNoteEl(note));
  }
}

function createNoteEl(note) {
  const el = document.createElement('div');
  el.className = 'note';
  if (note.confirmed) el.classList.add('confirmed');
  el.dataset.id = note.id;
  el.dataset.category = note.category || 'memo';
  el.style.left = note.x + 'px';
  el.style.top = note.y + 'px';

  const cat = getCat(note.category);
  const text = note.text || '';
  const isEmpty = !text.trim();
  const cgIdeas = note.cgIdeas || [];
  const isCgInputOpen = cgInputState && cgInputState.noteId === note.id;

  el.innerHTML = `
    <div class="note-head">
      <span class="chip chip-cat">
        <span class="cat-dot" style="background:${cat.color};"></span>
        <span>${cat.ko}</span>
      </span>
      ${note.confirmed ? '<span class="chip chip-confirmed">✓ 확정</span>' : ''}
      ${cgIdeas.length > 0 ? `<span class="chip chip-cg">● CG ${cgIdeas.length}</span>` : ''}
      <div class="note-actions">
        <button class="note-action-btn is-confirm ${note.confirmed ? 'active' : ''}" data-action="confirm" title="확정 ${note.confirmed ? '해제' : '표시'}">✓</button>
        <button class="note-action-btn is-delete" data-action="delete" title="삭제">×</button>
      </div>
    </div>
    <div class="note-body ${isEmpty ? 'placeholder' : ''}" data-action="edit">${
      isEmpty ? '클릭하여 메모 입력...' : escapeHtml(text)
    }</div>
    ${renderCGSection(note, cgIdeas, isCgInputOpen)}
    <div class="note-foot">
      <span>${escapeHtml(note.lastEditedBy || note.createdBy || '익명')}</span>
      <span>${formatTime(note.lastEditedAt)}</span>
    </div>
  `;

  attachNoteHandlers(el, note);
  return el;
}

function renderCGSection(note, cgIdeas, isInputOpen) {
  // No CG ideas and no open input → show subtle "+ CG 아이디어" button
  if (cgIdeas.length === 0 && !isInputOpen) {
    return `<button class="cg-add-btn-empty" data-cg-action="open-input" data-note-id="${note.id}">+ CG 아이디어 추가</button>`;
  }

  // Has CG ideas or input is open → show full section
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

function attachNoteHandlers(el, note) {
  // Header action buttons (confirm, delete)
  el.querySelectorAll('.note-head [data-action]').forEach(btn => {
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
      }
    });
  });

  // CG actions
  el.querySelectorAll('[data-cg-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cgAction = btn.dataset.cgAction;
      if (cgAction === 'open-input') {
        startCGInput(note.id);
      } else if (cgAction === 'remove') {
        removeCGIdea(note.id, btn.dataset.ideaId);
      }
    });
  });

  // CG input event handlers
  const cgInput = el.querySelector('.cg-input');
  if (cgInput && cgInputState && cgInputState.noteId === note.id) {
    cgInput.value = cgInputState.value || '';
    setTimeout(() => cgInput.focus(), 0);
    cgInput.addEventListener('input', (e) => {
      cgInputState.value = e.target.value;
    });
    cgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        endCGInput(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        endCGInput(false);
      }
    });
    cgInput.addEventListener('blur', () => {
      // Slight delay to allow other clicks to fire first
      setTimeout(() => {
        if (cgInputState && cgInputState.noteId === note.id) endCGInput(true);
      }, 150);
    });
    // Prevent drag/edit from input
    cgInput.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  // Body click → edit
  const body = el.querySelector('.note-body');
  body.addEventListener('click', (e) => {
    e.stopPropagation();
    if (draggingId) return;
    startEdit(el, body, note);
  });

  // Drag (only from non-interactive areas)
  el.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    if (e.target.tagName === 'INPUT') return;
    if (e.target.closest('[contenteditable="true"]')) return;
    if (e.target.closest('.note-cg-section')) return;
    if (e.target.closest('.cg-add-btn-empty')) return;
    if (editingId === note.id) return;
    startDrag(el, note, e);
  });
}

function toggleFlag(note, key) {
  const updated = {
    ...note,
    [key]: !note[key],
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
  if (commit && trimmed) {
    addCGIdea(noteId, trimmed);
  } else {
    renderBoard();
  }
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
// Edit memo body
// ============================================================
function startEdit(el, body, note) {
  editingId = note.id;
  body.classList.remove('placeholder');
  body.contentEditable = 'true';
  body.textContent = note.text || '';
  body.focus();

  const range = document.createRange();
  range.selectNodeContents(body);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = () => {
    body.contentEditable = 'false';
    body.removeEventListener('blur', finish);
    body.removeEventListener('keydown', keyHandler);
    const newText = body.textContent.trim();
    editingId = null;

    if (newText !== (note.text || '').trim()) {
      const updated = {
        ...note,
        text: newText,
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
// Drag
// ============================================================
function startDrag(el, note, e) {
  draggingId = note.id;
  const rect = el.getBoundingClientRect();
  const boardRect = board.getBoundingClientRect();
  dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  el.classList.add('dragging');

  const move = (ev) => {
    const x = ev.clientX - boardRect.left - dragOffset.x;
    const y = ev.clientY - boardRect.top - dragOffset.y;
    el.style.left = Math.max(0, x) + 'px';
    el.style.top = Math.max(0, y) + 'px';
  };

  const up = () => {
    el.classList.remove('dragging');
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    const x = parseInt(el.style.left) || 0;
    const y = parseInt(el.style.top) || 0;
    const id = note.id;
    draggingId = null;
    if (x !== note.x || y !== note.y) {
      const updated = { ...note, x, y, lastEditedBy: userName, lastEditedAt: new Date().toISOString() };
      const idx = notes.findIndex(n => n.id === id);
      if (idx !== -1) notes[idx] = updated;
      socket.emit('update_note', updated);
    }
  };

  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
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
  const boardRect = board.getBoundingClientRect();
  const note = {
    id: 'n_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    x: Math.max(40, Math.random() * Math.max(100, boardRect.width - 320) + 20),
    y: Math.max(40, Math.random() * Math.max(100, boardRect.height - 280) + 20),
    text: '',
    category,
    confirmed: false,
    cgIdeas: [],
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
      const body = newEl.querySelector('.note-body');
      startEdit(newEl, body, note);
    }
  }, 60);
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
  setTimeout(() => input.focus(), 50);

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

document.getElementById('btn-change-name').addEventListener('click', showNameModal);

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
  if (!editingId && !draggingId && !cgInputState) renderBoard();
}, 60000);

init();
