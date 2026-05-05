// ===== Money Plus Board · Frontend =====
const socket = io();
let userName = localStorage.getItem('mp_user_name') || null;
let notes = [];
let editingId = null;
let draggingId = null;
let dragOffset = { x: 0, y: 0 };

const board = document.getElementById('board');
const userNameEl = document.getElementById('user-name');
const connectedCountEl = document.getElementById('connected-count');
const tickerEl = document.getElementById('ticker');

const CATEGORY_LABELS = {
  market:   { ko: '시황',  en: 'MARKET'   },
  stocks:   { ko: '종목',  en: 'STOCKS'   },
  schedule: { ko: '일정',  en: 'SCHEDULE' },
  alert:    { ko: '이슈',  en: 'ALERT'    },
  memo:     { ko: '메모',  en: 'MEMO'     },
};

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
socket.on('connect', () => {
  console.log('🟢 connected:', socket.id);
});

socket.on('state', (data) => {
  notes = (data && data.notes) || [];
  renderBoard();
});

socket.on('note_added', (note) => {
  if (notes.find(n => n.id === note.id)) return;
  notes.push(note);
  renderBoard();
  setTicker(`${note.createdBy}님이 "${CATEGORY_LABELS[note.category]?.ko || '메모'}" 카드를 추가했습니다`);
});

socket.on('note_updated', (note) => {
  const idx = notes.findIndex(n => n.id === note.id);
  if (idx === -1) return;
  notes[idx] = note;
  // 편집 중이거나 드래그 중인 노트는 다시 그리지 않음
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

socket.on('disconnect', () => {
  setTicker('연결이 끊겼습니다. 다시 연결을 시도합니다...');
});

// ============================================================
// Render
// ============================================================
function renderBoard() {
  board.innerHTML = '';

  if (notes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="empty-state-tag">ON AIR</div>
      <div class="empty-state-title">아직 메모가 없습니다</div>
      <div class="empty-state-desc">우측 상단 ＋ 버튼으로 첫 메모를 추가하세요</div>
    `;
    board.appendChild(empty);
    return;
  }

  for (const note of notes) {
    board.appendChild(createNoteEl(note));
  }
}

function createNoteEl(note) {
  const el = document.createElement('div');
  el.className = 'note';
  el.dataset.id = note.id;
  el.dataset.category = note.category || 'memo';
  el.style.left = note.x + 'px';
  el.style.top = note.y + 'px';

  const cat = CATEGORY_LABELS[note.category] || CATEGORY_LABELS.memo;
  const text = note.text || '';
  const isEmpty = !text.trim();

  el.innerHTML = `
    <div class="note-banner">
      <span class="label">
        <span>${cat.ko}</span>
        <span class="label-en">${cat.en}</span>
      </span>
      <button class="delete-btn" data-action="delete" title="삭제">×</button>
    </div>
    <div class="note-source">출처: ${escapeHtml(note.createdBy || '익명')} · 작성 ${formatTime(note.createdAt)}</div>
    <div class="note-body ${isEmpty ? 'placeholder' : ''}" data-action="edit">${
      isEmpty ? '클릭하여 메모 입력...' : escapeHtml(text)
    }</div>
    <div class="note-footer">
      <span><span class="author-mark">●</span>EDIT · ${escapeHtml(note.lastEditedBy || note.createdBy || '익명')}</span>
      <span>${formatTime(note.lastEditedAt)}</span>
    </div>
  `;

  attachNoteHandlers(el, note);
  return el;
}

function attachNoteHandlers(el, note) {
  el.querySelector('.delete-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm(`이 ${CATEGORY_LABELS[note.category]?.ko || '메모'} 카드를 삭제할까요?`)) {
      notes = notes.filter(n => n.id !== note.id);
      renderBoard();
      socket.emit('delete_note', note.id);
    }
  });

  const body = el.querySelector('.note-body');
  body.addEventListener('click', (e) => {
    e.stopPropagation();
    if (draggingId) return;
    startEdit(el, body, note);
  });

  el.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    if (e.target.closest('[contenteditable="true"]')) return;
    if (editingId === note.id) return;
    startDrag(el, note, e);
  });
}

// ============================================================
// Edit
// ============================================================
function startEdit(el, body, note) {
  editingId = note.id;
  body.classList.remove('placeholder');
  body.contentEditable = 'true';
  body.textContent = note.text || '';
  body.focus();

  // place cursor at end
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
  dragOffset = {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
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
      const updated = {
        ...note,
        x, y,
        lastEditedBy: userName,
        lastEditedAt: new Date().toISOString(),
      };
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

  modal.onclick = (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  };
}

function addNote(category) {
  const boardRect = board.getBoundingClientRect();
  const note = {
    id: 'n_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    x: Math.max(40, Math.random() * (boardRect.width - 320) + 20),
    y: Math.max(40, Math.random() * (boardRect.height - 280) + 20),
    text: '',
    category,
    createdBy: userName,
    createdAt: new Date().toISOString(),
    lastEditedBy: userName,
    lastEditedAt: new Date().toISOString(),
  };
  notes.push(note);
  socket.emit('add_note', note);
  renderBoard();

  // auto-focus
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

  modal.onclick = (e) => {
    if (e.target === modal && userName) modal.classList.add('hidden');
  };
}

document.getElementById('btn-change-name').addEventListener('click', showNameModal);

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

// 1분마다 시간 표시 갱신
setInterval(() => {
  if (!editingId && !draggingId) renderBoard();
}, 60000);

init();
