const express   = require('express');
const http      = require('http');
const socketIo  = require('socket.io');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(cors());
app.use(express.static('public'));

// ─── Config ───────────────────────────────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHAT_FILE  = path.join(DATA_DIR, 'chat.json');
const ADMIN_NAME = 'Admin';
const ADMIN_PASS = 'YoMarcSoyAdmin';
const NAME_REGEX = /^[a-zA-Z0-9_-]{3,20}$/;
const MAX_MSGS   = 50;
const SPAM_LIMIT = 5;
const SPAM_WIN   = 3000;
const MUTE_TIME  = 30000;

// ─── Persistence ──────────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file) {
  try   { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}
function saveJSON(file, data) {
  try   { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('[save]', file, e.message); }
}

// ─── State ────────────────────────────────────────────────────────────────────
let onlineUsers  = [];
let persistUsers = loadJSON(USERS_FILE);
let messages     = loadJSON(CHAT_FILE).slice(-MAX_MSGS);
let isFrozen     = false;
let isPanic      = false;
let isReversa    = false;
let reversaTimer = null;
let cinemaActive = null;
let saveTimer    = null;

const spamMap         = new Map();  // socketId → timestamp[]
const typingTimers    = new Map();  // socketId → timeout
const inspectRequests = new Map();  // targetSocketId → { requesterSocketId, serverInfo }

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sanitize    = t => String(t).replace(/[&<>"']/g, '').trim();
const getBySocket = id   => onlineUsers.find(u => u.socketId === id);
const getByName   = name => onlineUsers.find(u => u.name.toLowerCase() === name.toLowerCase());
const getPersist  = name => persistUsers.find(p => p.name.toLowerCase() === name.toLowerCase());

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const snap = onlineUsers.map(({ name, color, isAdmin, bannedUntil, mutedUntil }) =>
      ({ name, color, isAdmin, bannedUntil, mutedUntil })
    );
    for (const p of persistUsers) {
      if (!snap.find(u => u.name.toLowerCase() === p.name.toLowerCase())) snap.push(p);
    }
    persistUsers = snap;
    saveJSON(USERS_FILE, snap);
    saveJSON(CHAT_FILE, messages);
  }, 1000);
}

function syncUser(user) {
  const i = onlineUsers.findIndex(u => u.socketId === user.socketId);
  if (i > -1) onlineUsers[i] = user; else onlineUsers.push(user);
  scheduleSave();
  io.emit('usersUpdate', onlineUsers);
}
function removeUser(socketId) {
  onlineUsers = onlineUsers.filter(u => u.socketId !== socketId);
  scheduleSave();
  io.emit('usersUpdate', onlineUsers);
}
function getBanSecs(user) {
  if (user.bannedUntil && Date.now() < user.bannedUntil)
    return Math.ceil((user.bannedUntil - Date.now()) / 1000);
  if (user.bannedUntil) { user.bannedUntil = 0; syncUser(user); }
  return 0;
}
function isMuted(user) {
  if (user.mutedUntil && Date.now() < user.mutedUntil) return true;
  if (user.mutedUntil) { user.mutedUntil = 0; syncUser(user); }
  return false;
}
function isSpam(user) {
  const now  = Date.now();
  const prev = (spamMap.get(user.socketId) || []).filter(t => now - t < SPAM_WIN);
  if (prev.length >= SPAM_LIMIT) {
    user.mutedUntil = now + MUTE_TIME; syncUser(user); return true;
  }
  spamMap.set(user.socketId, [...prev, now]);
  return false;
}
function pushMsg(msg) {
  const full = { ...msg, timestamp: Date.now() };
  messages.push(full);
  if (messages.length > MAX_MSGS) messages = messages.slice(-MAX_MSGS);
  scheduleSave();
  io.emit('message', full);
}
function sysTo(socket, text, color = '#888') {
  socket.emit('message', { sender: 'Sistema', text, color, timestamp: Date.now() });
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[+]', socket.id);

  // JOIN ─────────────────────────────────────────────────────────────────────
  socket.on('join', data => {
    try {
      const name = sanitize(data?.name || '');
      if (!NAME_REGEX.test(name)) {
        socket.emit('invalidName', 'Nombre inválido: 3-20 chars, solo letras/números/_ -');
        socket.disconnect(); return;
      }
      const dup = getByName(name);
      if (dup) { io.to(dup.socketId).emit('duplicateName'); removeUser(dup.socketId); }

      const saved = getPersist(name);
      const user = {
        socketId:    socket.id,
        name,
        color:       saved?.color       || '#' + Math.floor(Math.random()*0xFFFFFF).toString(16).padStart(6,'0'),
        isAdmin:     saved?.isAdmin     || name === ADMIN_NAME,
        bannedUntil: saved?.bannedUntil || 0,
        mutedUntil:  saved?.mutedUntil  || 0,
        activity:    'online',
      };

      const banSecs = getBanSecs(user);
      if (banSecs > 0) { socket.emit('banned', { secondsLeft: banSecs }); socket.disconnect(); return; }

      syncUser(user);
      socket.emit('userData', user);
      // Admin ve historial completo; usuarios normales no ven /burn ya expirados
      const history = user.isAdmin ? messages : messages.filter(m => m.msgType !== 'burn');
      socket.emit('messages', history);
      socket.broadcast.emit('userJoined', { name: user.name, color: user.color });

      // Sync global states for late joiners
      if (isFrozen)    socket.emit('freeze');
      if (isPanic)     socket.emit('panic');
      if (cinemaActive) socket.emit('cinema', cinemaActive);
    } catch(e) { console.error('[join]', e.message); }
  });

  // MESSAGE ──────────────────────────────────────────────────────────────────
  socket.on('message', raw => {
    try {
      const user = getBySocket(socket.id);
      if (!user) return;
      if (isFrozen && !user.isAdmin) return;
      const bans = getBanSecs(user);
      if (bans > 0) { socket.emit('banned', { secondsLeft: bans }); return; }
      if (isMuted(user)) { socket.emit('muted'); return; }
      if (isSpam(user))  { socket.emit('muted'); return; }

      const text = sanitize(String(raw)).slice(0, 500);
      if (!text) return;

      if (text.startsWith('/')) handleCommand(socket, text, user);
      else pushMsg({ sender: user.name, text: isReversa ? text.split('').reverse().join('') : text, color: user.color });
    } catch(e) { console.error('[msg]', e.message); }
  });

  // ACTIVITY ─────────────────────────────────────────────────────────────────
  socket.on('typing', () => {
    try {
      const user = getBySocket(socket.id); if (!user) return;
      user.activity = 'typing';
      io.emit('activityUpdate', { name: user.name, activity: 'typing' });
      clearTimeout(typingTimers.get(socket.id));
      typingTimers.set(socket.id, setTimeout(() => {
        const u = getBySocket(socket.id); if (!u) return;
        u.activity = 'online'; io.emit('activityUpdate', { name: u.name, activity: 'online' });
      }, 2500));
    } catch(e) {}
  });

  socket.on('visibilityChange', ({ hidden }) => {
    try {
      const user = getBySocket(socket.id); if (!user) return;
      user.activity = hidden ? 'away' : 'online';
      io.emit('activityUpdate', { name: user.name, activity: user.activity });
    } catch(e) {}
  });

  // CINEMA SYNC ──────────────────────────────────────────────────────────────
  socket.on('cinemaControl', ({ action, time }) => {
    try {
      const user = getBySocket(socket.id);
      if (user?.isAdmin) socket.broadcast.emit('cinemaControl', { action, time });
    } catch(e) {}
  });

  // INSPECT REPORT ───────────────────────────────────────────────────────────
  socket.on('infoReport', ({ data }) => {
    try {
      const req = inspectRequests.get(socket.id); if (!req) return;
      inspectRequests.delete(socket.id);
      io.to(req.requesterSocketId).emit('infoDownload', { ...req.serverInfo, ...data });
    } catch(e) {}
  });

  // DISCONNECT ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    try {
      const user = getBySocket(socket.id);
      if (user) { removeUser(socket.id); socket.broadcast.emit('userLeft', user.name); }
      spamMap.delete(socket.id);
      typingTimers.delete(socket.id);
      inspectRequests.delete(socket.id);
    } catch(e) {}
  });
});

// ─── Commands ─────────────────────────────────────────────────────────────────
function handleCommand(socket, cmd, user) {
  const parts   = cmd.slice(1).trim().split(/\s+/);
  const command = parts[0].toLowerCase();

  switch (command) {

    case 'help':
      sysTo(socket, user.isAdmin
        ? 'Usuario: /anon /color /burn /rainbow /matrix /glitch\nAdmin: /ban /mute /nick /clear /freeze /unfreeze /anuncio /meme /flashbang /cinema [url] /reversa <s> /fakemsg /inspect /panic /unpanic /exec [css|js] [user] <código>'
        : 'Comandos: /anon <msg>  /color #hex  /burn <msg>  /rainbow <msg>  /matrix <msg>  /glitch <msg>');
      break;

    case 'anon': {
      const t = parts.slice(1).join(' '); if (!t) break;
      const msg = { sender: 'Anónimo', text: sanitize(t).slice(0,500), color: '#888', timestamp: Date.now(), realSender: user.name };
      messages.push(msg); if (messages.length > MAX_MSGS) messages = messages.slice(-MAX_MSGS);
      scheduleSave(); io.emit('message', msg);
      break;
    }

    case 'color': {
      const hex = parts[1];
      if (hex && /^#[0-9a-fA-F]{6}$/.test(hex)) {
        user.color = hex; syncUser(user); socket.emit('userData', user);
        sysTo(socket, `Color → ${hex}`, hex);
      }
      break;
    }

    case 'admin':
      if (parts[1] === ADMIN_PASS) {
        user.isAdmin = true; syncUser(user); socket.emit('userData', user);
        sysTo(socket, '👑 Admin activado', '#00ff00');
      } else sysTo(socket, '❌ Contraseña incorrecta', '#ff4444');
      break;

    // Effect messages (todos los usuarios)
    case 'burn': case 'rainbow': case 'matrix': case 'glitch': {
      const t = parts.slice(1).join(' '); if (!t) break;
      const out = isReversa ? t.split('').reverse().join('') : t;
      pushMsg({ sender: user.name, text: sanitize(out).slice(0,300), color: user.color, msgType: command });
      break;
    }

    // Moderación
    case 'ban':
      if (!user.isAdmin) break;
      if (!parts[1] || isNaN(parseInt(parts[2]))) { sysTo(socket,'Uso: /ban <user> <segs>','#ff4444'); break; }
      { const t = getByName(parts[1]);
        if (!t) { sysTo(socket,'No encontrado','#ff4444'); break; }
        if (t.isAdmin) { sysTo(socket,'No puedes banear admins','#ff4444'); break; }
        const s = Math.min(parseInt(parts[2]), 86400);
        t.bannedUntil = Date.now() + s*1000; syncUser(t);
        io.to(t.socketId).emit('banned', { secondsLeft: s });
        pushMsg({ sender:'Admin', text:`🚫 ${t.name} baneado ${s}s`, color:'#ff4444' });
      } break;

    case 'mute':
      if (!user.isAdmin) break;
      if (!parts[1] || isNaN(parseInt(parts[2]))) { sysTo(socket,'Uso: /mute <user> <segs>','#ff4444'); break; }
      { const t = getByName(parts[1]); if (!t) break;
        const s = Math.min(parseInt(parts[2]), 3600);
        t.mutedUntil = Date.now() + s*1000; syncUser(t);
        io.to(t.socketId).emit('muted');
        pushMsg({ sender:'Admin', text:`🔇 ${t.name} muteado ${s}s`, color:'#faa61a' });
      } break;

    case 'nick':
      if (!user.isAdmin || !parts[1] || !parts[2]) break;
      if (!NAME_REGEX.test(parts[2])) { sysTo(socket,'Nombre inválido','#ff4444'); break; }
      { const t = getByName(parts[1]); if (!t) break;
        const old = t.name; t.name = sanitize(parts[2]); syncUser(t);
        // Emitir al target para que actualice su localStorage
        io.to(t.socketId).emit('nickChanged', { newName: t.name, newColor: t.color, isAdmin: t.isAdmin });
        io.emit('userRenamed', { old, new: t.name });
      } break;

    case 'clear':
      if (!user.isAdmin) break;
      messages = []; saveJSON(CHAT_FILE, messages); io.emit('clear'); break;

    case 'freeze':  if (!user.isAdmin) break; isFrozen = true;  io.emit('freeze');   break;
    case 'unfreeze': if (!user.isAdmin) break; isFrozen = false; io.emit('unfreeze'); break;

    case 'anuncio':
      if (!user.isAdmin) break;
      { const t = parts.slice(1).join(' '); if (!t) break;
        io.emit('announcement', { text: sanitize(t), from: user.name });
      } break;

    case 'meme': {
      if (!user.isAdmin) break;
      let tSock = null, urlArg = '';
      if (parts.length >= 3) {
        const mu = getByName(parts[1]);
        if (mu) { tSock = mu.socketId; urlArg = parts.slice(2).join(' '); }
        else urlArg = parts.slice(1).join(' ');
      } else urlArg = parts[1] || '';
      if (!urlArg || !/^https?:\/\/.+/i.test(urlArg)) { sysTo(socket,'❌ URL inválida','#ff4444'); break; }
      if (tSock) io.to(tSock).emit('meme', urlArg); else socket.broadcast.emit('meme', urlArg);
      break;
    }

    case 'flashbang': {
      if (!user.isAdmin) break;
      const t = parts[1] ? getByName(parts[1]) : null;
      if (parts[1] && !t) { sysTo(socket,'No encontrado','#ff4444'); break; }
      // Sin target → afecta a todos (incluido admin para poder probarlo)
      if (t) io.to(t.socketId).emit('flashbang'); else io.emit('flashbang');
      break;
    }

    case 'cinema': {
      if (!user.isAdmin) break;
      const url = parts.slice(1).join(' ');
      if (!url) { cinemaActive = null; io.emit('cinemaClose'); break; }
      if (!/^https?:\/\/.+/i.test(url)) { sysTo(socket,'❌ URL inválida','#ff4444'); break; }
      cinemaActive = { url }; io.emit('cinema', cinemaActive);
      break;
    }

    case 'reversa': {
      if (!user.isAdmin) break;
      const s = Math.min(parseInt(parts[1]) || 30, 300);
      isReversa = true; clearTimeout(reversaTimer);
      pushMsg({ sender:'Sistema', text:`🔄 Modo reversa activado (${s}s)`, color:'#a855f7' });
      reversaTimer = setTimeout(() => {
        isReversa = false;
        pushMsg({ sender:'Sistema', text:'🔄 Reversa desactivado', color:'#a855f7' });
      }, s * 1000);
      break;
    }

    case 'fakemsg': {
      if (!user.isAdmin || !parts[1]) break;
      const t = getByName(parts[1]);
      if (!t) { sysTo(socket,'No encontrado','#ff4444'); break; }
      const txt = parts.slice(2).join(' '); if (!txt) break;
      pushMsg({ sender: t.name, text: sanitize(txt).slice(0,500), color: t.color });
      break;
    }

    case 'inspect': {
      if (!user.isAdmin || !parts[1]) break;
      const t = getByName(parts[1]);
      if (!t) { sysTo(socket,'No encontrado','#ff4444'); break; }
      const ts = io.sockets.sockets.get(t.socketId);
      inspectRequests.set(t.socketId, {
        requesterSocketId: socket.id,
        serverInfo: {
          nombre:    t.name,
          socketId:  t.socketId,
          isAdmin:   t.isAdmin,
          ip:        (ts?.handshake?.headers['x-forwarded-for']?.split(',')[0] || ts?.handshake?.address || 'N/A').trim(),
          userAgent: ts?.handshake?.headers?.['user-agent'] || 'N/A',
          transport: ts?.conn?.transport?.name || 'N/A',
        }
      });
      io.to(t.socketId).emit('collectInfo');
      sysTo(socket, `📡 Recopilando datos de ${t.name}...`, '#888');
      break;
    }

    case 'panic':   if (!user.isAdmin) break; isPanic = true;  io.emit('panic');   break;
    case 'unpanic': if (!user.isAdmin) break; isPanic = false; io.emit('unpanic'); break;

case 'exec': {
      if (!user.isAdmin) { sysTo(socket, '❌ Solo admin', '#ff4444'); break; }
      // /exec css <código>  →  inyecta <style>
      // /exec js <código>   →  eval() en target o broadcast
      const subtype = (parts[1] || '').toLowerCase();
      if (subtype !== 'css' && subtype !== 'js') {
        sysTo(socket, 'Uso: /exec css <estilos>  |  /exec js <código>', '#888'); break;
      }
      // Target opcional: /exec js <user> <código>  →  solo si hay usuario conocido como parts[2]
      let targetSock = null;
      let codeStart  = 2;
      const maybeUser = parts[2] ? getByName(parts[2]) : null;
      if (maybeUser) { targetSock = maybeUser.socketId; codeStart = 3; }

      const code = cmd.split(parts[codeStart - 1])[1]?.trim() || parts.slice(codeStart).join(' ');
      if (!code) { sysTo(socket, '❌ Código vacío', '#ff4444'); break; }

      const event = subtype === 'css' ? 'execCSS' : 'execJS';
      if (targetSock) io.to(targetSock).emit(event, { code });
      else            io.emit(event, { code });

      sysTo(socket, `✅ /exec ${subtype} enviado${targetSock ? ` → ${parts[2]}` : ' → todos'}`, '#00ff00');
      break;
    }

    default:
      sysTo(socket, `Comando desconocido: /${command}`, '#ff4444');
  }
}
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Chat en puerto ${PORT}`));