const express  = require('express');
const http     = require('http');
const socketIo = require('socket.io');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');

// ─── Crash guard (Render free tier puede recibir basura al despertar) ─────────
process.on('uncaughtException',  err  => console.error('[uncaughtException]',  err.message));
process.on('unhandledRejection', err  => console.error('[unhandledRejection]', err?.message ?? err));

// ─── App setup ────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Render cierra idle connections; esto mantiene el socket vivo
  pingInterval: 25000,
  pingTimeout:  60000,
});

app.use(cors());
app.use(express.static('public'));

// Keep-alive endpoint para evitar el apagado por inactividad en Render free
app.get('/ping', (_req, res) => res.send('pong'));

// ─── Config ───────────────────────────────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHAT_FILE  = path.join(DATA_DIR, 'chat.json');
const ADMIN_NAME = 'Admin';
const ADMIN_PASS = 'YoMarcSoyAdmin';
const NAME_REGEX = /^[a-zA-Z0-9_-]{3,20}$/;
const MAX_MSGS   = 50;
const SPAM_LIMIT = 5;
const SPAM_WIN   = 3000;   // ms
const MUTE_TIME  = 30000;  // ms
const RULETA_CD  = 10 * 60 * 1000; // 10 min en ms

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

// ─── State ─────────────────────────────────────────────────────────────────────
// Al arrancar: onlineUsers SIEMPRE vacío (limpieza de IDs fantasma en Render)
let onlineUsers  = [];
let persistUsers = loadJSON(USERS_FILE);
let messages     = loadJSON(CHAT_FILE).slice(-MAX_MSGS);
let isFrozen     = false;
let isPanic      = false;
let isReversa    = false;
let reversaTimer = null;
let cinemaActive = null;
let saveTimer    = null;
let ruletaLastUsed = 0; // timestamp última ruleta

const spamMap         = new Map(); // socketId → timestamp[]
const typingTimers    = new Map(); // socketId → timeout
const inspectRequests = new Map(); // targetSocketId → { requesterSocketId, serverInfo }

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sanitize    = t    => String(t).replace(/[&<>"']/g, '').trim();
const getBySocket = id   => onlineUsers.find(u => u.socketId === id);
const getByName   = name => onlineUsers.find(u => u.name.toLowerCase() === name.toLowerCase());
const getPersist  = name => persistUsers.find(p => p.name.toLowerCase() === name.toLowerCase());

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const snap = onlineUsers.map(({ name, color, isAdmin, bannedUntil, mutedUntil }) =>
        ({ name, color, isAdmin, bannedUntil, mutedUntil })
      );
      // Merge con offline para no perder perfiles
      for (const p of persistUsers) {
        if (!snap.find(u => u.name.toLowerCase() === p.name.toLowerCase())) snap.push(p);
      }
      persistUsers = snap;
      saveJSON(USERS_FILE, snap);
      saveJSON(CHAT_FILE, messages);
    } catch(e) { console.error('[scheduleSave]', e.message); }
  }, 1000);
}

function syncUser(user) {
  try {
    const i = onlineUsers.findIndex(u => u.socketId === user.socketId);
    if (i > -1) onlineUsers[i] = user; else onlineUsers.push(user);
    scheduleSave();
    io.emit('usersUpdate', onlineUsers);
  } catch(e) { console.error('[syncUser]', e.message); }
}

function removeUser(socketId) {
  try {
    onlineUsers = onlineUsers.filter(u => u.socketId !== socketId);
    scheduleSave();
    io.emit('usersUpdate', onlineUsers);
  } catch(e) { console.error('[removeUser]', e.message); }
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
  try {
    const full = { ...msg, timestamp: Date.now() };
    messages.push(full);
    if (messages.length > MAX_MSGS) messages = messages.slice(-MAX_MSGS);
    scheduleSave();
    io.emit('message', full);
  } catch(e) { console.error('[pushMsg]', e.message); }
}

function sysTo(socket, text, color = '#888') {
  try { socket.emit('message', { sender: 'Sistema', text, color, timestamp: Date.now() }); }
  catch(e) {}
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[+]', socket.id);

  // ── JOIN ────────────────────────────────────────────────────────────────────
  socket.on('join', data => {
    try {
      const name = sanitize(data?.name || '');
      if (!NAME_REGEX.test(name)) {
        socket.emit('invalidName', 'Nombre inválido: 3-20 chars, solo letras/números/_ -');
        socket.disconnect(); return;
      }

      // Expulsar sesión duplicada (IDs fantasma de reconexión)
      const dup = getByName(name);
      if (dup) {
        io.to(dup.socketId).emit('duplicateName');
        removeUser(dup.socketId);
      }

      const saved = getPersist(name);
      const user  = {
        socketId:    socket.id,
        name,
        color:       saved?.color       || '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0'),
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

      // Sincronizar estados globales para quien entra tarde
      if (isFrozen)    socket.emit('freeze');
      if (isPanic)     socket.emit('panic');
      if (cinemaActive) socket.emit('cinema', cinemaActive);

    } catch(e) { console.error('[join]', e.message); }
  });

  // ── MESSAGE ─────────────────────────────────────────────────────────────────
  socket.on('message', raw => {
    try {
      const user = getBySocket(socket.id);
      if (!user) return;
      if (isFrozen && !user.isAdmin) return;

      const banSecs = getBanSecs(user);
      if (banSecs > 0) { socket.emit('banned', { secondsLeft: banSecs }); return; }
      if (isMuted(user)) { socket.emit('muted'); return; }
      if (isSpam(user))  { socket.emit('muted'); return; }

      const text = sanitize(String(raw)).slice(0, 500);
      if (!text) return;

      if (text.startsWith('/') || text.startsWith('!')) {
        handleCommand(socket, text, user);
      } else {
        pushMsg({ sender: user.name, text: isReversa ? text.split('').reverse().join('') : text, color: user.color });
      }
    } catch(e) { console.error('[message]', e.message); }
  });

  // ── ACTIVITY ────────────────────────────────────────────────────────────────
  socket.on('typing', () => {
    try {
      const user = getBySocket(socket.id); if (!user) return;
      user.activity = 'typing';
      io.emit('activityUpdate', { name: user.name, activity: 'typing' });
      clearTimeout(typingTimers.get(socket.id));
      typingTimers.set(socket.id, setTimeout(() => {
        const u = getBySocket(socket.id); if (!u) return;
        u.activity = 'online';
        io.emit('activityUpdate', { name: u.name, activity: 'online' });
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

  // ── CINEMA SYNC ─────────────────────────────────────────────────────────────
  socket.on('cinemaControl', ({ action, time }) => {
    try {
      const user = getBySocket(socket.id);
      if (user?.isAdmin) socket.broadcast.emit('cinemaControl', { action, time });
    } catch(e) {}
  });

  // ── INSPECT REPORT ──────────────────────────────────────────────────────────
  socket.on('infoReport', ({ data }) => {
    try {
      const req = inspectRequests.get(socket.id); if (!req) return;
      inspectRequests.delete(socket.id);
      io.to(req.requesterSocketId).emit('infoDownload', { ...req.serverInfo, ...data });
    } catch(e) {}
  });

  // ── DISCONNECT ──────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    try {
      const user = getBySocket(socket.id);
      if (user) { removeUser(socket.id); socket.broadcast.emit('userLeft', user.name); }
      spamMap.delete(socket.id);
      typingTimers.delete(socket.id);
      inspectRequests.delete(socket.id);
      console.log('[-]', socket.id);
    } catch(e) {}
  });
});

// ─── Commands ─────────────────────────────────────────────────────────────────
function handleCommand(socket, cmd, user) {
  try {
    // Separar solo el primer token para identificar el comando;
    // el resto del string se pasa crudo para no romper código con espacios/comillas
    const firstSpace = cmd.indexOf(' ');
    const command    = cmd.slice(1, firstSpace > -1 ? firstSpace : undefined).toLowerCase().trim();
    const rest       = firstSpace > -1 ? cmd.slice(firstSpace + 1).trim() : ''; // todo después del comando

    // Para comandos clásicos con argumentos posicionales (ban, mute, etc.)
    const parts = rest.split(/\s+/);

    switch (command) {

      case 'help':
        sysTo(socket, user.isAdmin
          ? 'Usuario: /anon /color /burn /rainbow /matrix /glitch  !ruleta\nAdmin: /ban /mute /nick /clear /freeze /unfreeze /anuncio /meme /flashbang /cinema [url] /reversa <s> /fakemsg /inspect /panic /unpanic /exec [css|js] [user] <código>'
          : 'Comandos: /anon <msg>  /color #hex  /burn <msg>  /rainbow <msg>  /matrix <msg>  /glitch <msg>  !ruleta');
        break;

      case 'anon': {
        if (!rest) break;
        const msg = { sender: 'Anónimo', text: sanitize(rest).slice(0, 500), color: '#888', timestamp: Date.now(), realSender: user.name };
        messages.push(msg); if (messages.length > MAX_MSGS) messages = messages.slice(-MAX_MSGS);
        scheduleSave(); io.emit('message', msg);
        break;
      }

      case 'color': {
        const hex = parts[0];
        if (hex && /^#[0-9a-fA-F]{6}$/.test(hex)) {
          user.color = hex; syncUser(user); socket.emit('userData', user);
          sysTo(socket, `Color → ${hex}`, hex);
        }
        break;
      }

      case 'admin':
        if (parts[0] === ADMIN_PASS) {
          user.isAdmin = true; syncUser(user); socket.emit('userData', user);
          sysTo(socket, '👑 Admin activado', '#00ff00');
        } else sysTo(socket, '❌ Contraseña incorrecta', '#ff4444');
        break;

      // Effect messages
      case 'burn': case 'rainbow': case 'matrix': case 'glitch': {
        if (!rest) break;
        const out = isReversa ? rest.split('').reverse().join('') : rest;
        pushMsg({ sender: user.name, text: sanitize(out).slice(0, 300), color: user.color, msgType: command });
        break;
      }

      // Moderación
      case 'ban':
        if (!user.isAdmin) break;
        if (!parts[0] || isNaN(parseInt(parts[1]))) { sysTo(socket, 'Uso: /ban <user> <segs>', '#ff4444'); break; }
        {
          const t = getByName(parts[0]);
          if (!t) { sysTo(socket, 'No encontrado', '#ff4444'); break; }
          if (t.isAdmin) { sysTo(socket, 'No puedes banear admins', '#ff4444'); break; }
          const s = Math.min(parseInt(parts[1]), 86400);
          t.bannedUntil = Date.now() + s * 1000; syncUser(t);
          io.to(t.socketId).emit('banned', { secondsLeft: s });
          pushMsg({ sender: 'Admin', text: `🚫 ${t.name} baneado ${s}s`, color: '#ff4444' });
        }
        break;

      case 'mute':
        if (!user.isAdmin) break;
        if (!parts[0] || isNaN(parseInt(parts[1]))) { sysTo(socket, 'Uso: /mute <user> <segs>', '#ff4444'); break; }
        {
          const t = getByName(parts[0]); if (!t) break;
          const s = Math.min(parseInt(parts[1]), 3600);
          t.mutedUntil = Date.now() + s * 1000; syncUser(t);
          io.to(t.socketId).emit('muted');
          pushMsg({ sender: 'Admin', text: `🔇 ${t.name} muteado ${s}s`, color: '#faa61a' });
        }
        break;

      case 'nick':
        if (!user.isAdmin || !parts[0] || !parts[1]) break;
        if (!NAME_REGEX.test(parts[1])) { sysTo(socket, 'Nombre inválido', '#ff4444'); break; }
        {
          const t = getByName(parts[0]); if (!t) break;
          const old = t.name; t.name = sanitize(parts[1]); syncUser(t);
          io.to(t.socketId).emit('nickChanged', { newName: t.name, newColor: t.color, isAdmin: t.isAdmin });
          io.emit('userRenamed', { old, new: t.name });
        }
        break;

      case 'clear':
        if (!user.isAdmin) break;
        messages = []; saveJSON(CHAT_FILE, messages); io.emit('clear');
        break;

      case 'freeze':   if (!user.isAdmin) break; isFrozen = true;  io.emit('freeze');   break;
      case 'unfreeze': if (!user.isAdmin) break; isFrozen = false; io.emit('unfreeze'); break;

      case 'anuncio':
        if (!user.isAdmin || !rest) break;
        io.emit('announcement', { text: sanitize(rest), from: user.name });
        break;

      case 'meme': {
        if (!user.isAdmin) break;
        let tSock = null, urlArg = rest;
        // Detectar target opcional: /meme Usuario https://...
        if (parts.length >= 2 && /^https?:\/\//i.test(parts[1])) {
          const mu = getByName(parts[0]);
          if (mu) { tSock = mu.socketId; urlArg = parts.slice(1).join(' '); }
        }
        if (!urlArg || !/^https?:\/\/.+/i.test(urlArg)) { sysTo(socket, '❌ URL inválida', '#ff4444'); break; }
        if (tSock) io.to(tSock).emit('meme', urlArg); else socket.broadcast.emit('meme', urlArg);
        break;
      }

      case 'flashbang': {
        if (!user.isAdmin) break;
        const t = rest ? getByName(parts[0]) : null;
        if (rest && !t) { sysTo(socket, 'No encontrado', '#ff4444'); break; }
        if (t) io.to(t.socketId).emit('flashbang'); else io.emit('flashbang');
        break;
      }

      case 'cinema': {
        if (!user.isAdmin) break;
        if (!rest) { cinemaActive = null; io.emit('cinemaClose'); break; }
        if (!/^https?:\/\/.+/i.test(rest)) { sysTo(socket, '❌ URL inválida', '#ff4444'); break; }
        cinemaActive = { url: rest }; io.emit('cinema', cinemaActive);
        break;
      }

      case 'reversa': {
        if (!user.isAdmin) break;
        const s = Math.min(parseInt(parts[0]) || 30, 300);
        isReversa = true; clearTimeout(reversaTimer);
        pushMsg({ sender: 'Sistema', text: `🔄 Modo reversa activado (${s}s)`, color: '#a855f7' });
        reversaTimer = setTimeout(() => {
          isReversa = false;
          pushMsg({ sender: 'Sistema', text: '🔄 Reversa desactivado', color: '#a855f7' });
        }, s * 1000);
        break;
      }

      case 'fakemsg': {
        if (!user.isAdmin || !parts[0]) break;
        const t = getByName(parts[0]);
        if (!t) { sysTo(socket, 'No encontrado', '#ff4444'); break; }
        const txt = parts.slice(1).join(' '); if (!txt) break;
        pushMsg({ sender: t.name, text: sanitize(txt).slice(0, 500), color: t.color });
        break;
      }

      case 'inspect': {
        if (!user.isAdmin || !parts[0]) break;
        const t = getByName(parts[0]);
        if (!t) { sysTo(socket, 'No encontrado', '#ff4444'); break; }
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

      // ── /exec css|js [user] <código crudo> ──────────────────────────────────
      // FIX CRÍTICO: se usa `rest` directamente en vez de parts.join() para
      // preservar comillas, paréntesis y espacios del código original
      case 'exec': {
        if (!user.isAdmin) { sysTo(socket, '❌ Solo admin', '#ff4444'); break; }

        const subtype = (parts[0] || '').toLowerCase();
        if (subtype !== 'css' && subtype !== 'js') {
          sysTo(socket, 'Uso: /exec css <estilos>  |  /exec js [user] <código>', '#888'); break;
        }

        // rest sin el primer token (subtype)
        const afterSubtype = rest.slice(subtype.length).trim();

        // Detectar target opcional solo para js: segundo token podría ser un username
        let targetSock = null;
        let code       = afterSubtype;

        if (subtype === 'js') {
          const nextSpace = afterSubtype.indexOf(' ');
          if (nextSpace > -1) {
            const maybeUser = getByName(afterSubtype.slice(0, nextSpace));
            if (maybeUser) {
              targetSock = maybeUser.socketId;
              code       = afterSubtype.slice(nextSpace + 1).trim();
            }
          }
        }

        if (!code) { sysTo(socket, '❌ Código vacío', '#ff4444'); break; }

        const event = subtype === 'css' ? 'execCSS' : 'execJS';
        // Emitir como objeto { code } para que el cliente lo reciba íntegro
        if (targetSock) io.to(targetSock).emit(event, { code });
        else            io.emit(event, { code });

        sysTo(socket, `✅ /exec ${subtype} enviado${targetSock ? ` → ${afterSubtype.split(' ')[0]}` : ' → todos'}`, '#00ff00');
        break;
      }

      // ── !ruleta ─────────────────────────────────────────────────────────────
      case 'ruleta': {
        const now     = Date.now();
        const elapsed = now - ruletaLastUsed;

        if (elapsed < RULETA_CD) {
          const secsLeft = Math.ceil((RULETA_CD - elapsed) / 1000);
          const mins     = Math.floor(secsLeft / 60);
          const secs     = secsLeft % 60;
          sysTo(socket, `🎰 Ruleta en cooldown — ${mins}m ${secs}s restantes`, '#faa61a');
          break;
        }

        // Candidatos: usuarios online, no admin, no ya muteados
        const candidates = onlineUsers.filter(u =>
          !u.isAdmin && !(u.mutedUntil && now < u.mutedUntil)
        );

        if (candidates.length === 0) {
          sysTo(socket, '🎰 No hay usuarios elegibles para la ruleta', '#888');
          break;
        }

        const victim = candidates[Math.floor(Math.random() * candidates.length)];
        victim.mutedUntil = now + 60000; // 60 segundos
        syncUser(victim);
        io.to(victim.socketId).emit('muted');
        ruletaLastUsed = now;

        pushMsg({
          sender: '🎰 Ruleta',
          text:   `La ruleta giró y cayó en... ¡${victim.name}! 🔇 Muteado 60s`,
          color:  '#a855f7',
        });
        break;
      }

      default:
        sysTo(socket, `Comando desconocido: ${cmd.slice(0, 1)}${command}`, '#ff4444');
    }
  } catch(e) { console.error('[handleCommand]', e.message); }
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Chat en puerto ${PORT}`);
  console.log(`   onlineUsers limpiados al arrancar (Render restart-safe)`);
});

// Graceful shutdown: guardar datos antes de apagarse
function gracefulShutdown(signal) {
  console.log(`[${signal}] Guardando datos...`);
  clearTimeout(saveTimer);
  try {
    const snap = onlineUsers.map(({ name, color, isAdmin, bannedUntil, mutedUntil }) =>
      ({ name, color, isAdmin, bannedUntil, mutedUntil })
    );
    for (const p of persistUsers) {
      if (!snap.find(u => u.name.toLowerCase() === p.name.toLowerCase())) snap.push(p);
    }
    saveJSON(USERS_FILE, snap);
    saveJSON(CHAT_FILE, messages);
    console.log('[shutdown] Datos guardados correctamente');
  } catch(e) { console.error('[shutdown] Error guardando:', e.message); }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // señal de Render al apagar
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));  // Ctrl+C en Termux
