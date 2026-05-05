const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'notes.json');

// ===== Storage =====
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ notes: [], meta: {} }, null, 2));
}

const readData = () => {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(data.notes)) data.notes = [];
    if (!data.meta || typeof data.meta !== 'object') data.meta = {};
    return data;
  } catch (e) {
    console.error('Failed to read data:', e);
    return { notes: [], meta: {} };
  }
};

const writeData = (data) => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to write data:', e);
    return false;
  }
};

// ===== Routes =====
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/api/notes', (_req, res) => res.json(readData()));

// ===== Real-time sync =====
const connected = new Set();

io.on('connection', (socket) => {
  connected.add(socket.id);
  console.log(`[connect] ${socket.id} (total: ${connected.size})`);
  io.emit('users_count', connected.size);

  // Send current state to new client
  socket.emit('state', readData());

  socket.on('add_note', (note) => {
    if (!note || !note.id) return;
    const data = readData();
    if (data.notes.find(n => n.id === note.id)) return;
    data.notes.push(note);
    writeData(data);
    io.emit('note_added', note);
  });

  socket.on('update_note', (note) => {
    if (!note || !note.id) return;
    const data = readData();
    const idx = data.notes.findIndex(n => n.id === note.id);
    if (idx === -1) return;
    data.notes[idx] = note;
    writeData(data);
    socket.broadcast.emit('note_updated', note);
  });

  socket.on('delete_note', (id) => {
    if (!id) return;
    const data = readData();
    data.notes = data.notes.filter(n => n.id !== id);
    writeData(data);
    io.emit('note_deleted', id);
  });

  socket.on('set_meta', (meta) => {
    if (!meta || typeof meta !== 'object') return;
    const data = readData();
    data.meta = { ...data.meta, ...meta };
    writeData(data);
    io.emit('meta_updated', data.meta);
  });

  socket.on('reset_all', () => {
    const data = readData();
    data.notes = [];
    writeData(data);
    io.emit('state', data);
    io.emit('reset_done');
  });

  socket.on('cursor_move', (payload) => {
    socket.broadcast.emit('cursor_update', { id: socket.id, ...payload });
  });

  socket.on('disconnect', () => {
    connected.delete(socket.id);
    console.log(`[disconnect] ${socket.id} (total: ${connected.size})`);
    io.emit('users_count', connected.size);
    io.emit('cursor_remove', socket.id);
  });
});

// ===== Start =====
server.listen(PORT, () => {
  console.log(`📺 Money Plus Board running on port ${PORT}`);
  console.log(`📁 Data: ${DATA_FILE}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => process.exit(0));
});
