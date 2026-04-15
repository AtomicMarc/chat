// ─── Init ─────────────────────────────────────────────────────────────────────
const socket = io();
const $      = id => document.getElementById(id);

let currentUser  = null;
let cinemaVideo  = null;
let banInterval  = null;

const messageInput    = $('messageInput');
const sendBtn         = $('sendBtn');
const messagesEl      = $('messages');
const usersListEl     = $('users-list');
const joinModal       = $('joinModal');
const statusEl        = $('status');
const onlineCountEl   = $('onlineCount');
const banOverlay      = $('banOverlay');
const banTimerEl      = $('banTimer');
const announceOverlay = $('announcementOverlay');
const flashOverlay    = $('flashbangOverlay');
const panicOverlay    = $('panicOverlay');
const cinemaContainer = $('cinemaContainer');
const cinemaPlayer    = $('cinemaPlayer');

const activityMap = new Map(); // name → 'online'|'typing'|'away'

// ─── Auto-join desde localStorage ────────────────────────────────────────────
const savedName  = localStorage.getItem('chatUsername') || '';
const savedColor = localStorage.getItem('chatColor')    || '';

$('usernameInput').value = savedName;
if (savedName) joinChat();

$('joinBtn').addEventListener('click', joinChat);
$('usernameInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinChat(); });

function joinChat() {
  const name = $('usernameInput').value.trim();
  if (!name) { showJoinError('Escribe un nombre'); return; }
  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(name)) {
    showJoinError('3-20 caracteres: letras, números, _ o -'); return;
  }
  $('joinError').classList.add('hidden');
  localStorage.setItem('chatUsername', name);
  socket.emit('join', { name });
}
function showJoinError(msg) {
  const el = $('joinError');
  el.textContent = msg; el.classList.remove('hidden');
}

// ─── Send ─────────────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !currentUser) return;
  socket.emit('message', text);
  messageInput.value = '';
}

// ─── Typing detection ─────────────────────────────────────────────────────────
messageInput.addEventListener('input', () => socket.emit('typing'));

// ─── Visibility detection ─────────────────────────────────────────────────────
document.addEventListener('visibilitychange', () =>
  socket.emit('visibilityChange', { hidden: document.hidden })
);

// ─── Render helpers ───────────────────────────────────────────────────────────
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = String(text);
  return d.innerHTML;
}
function formatTime(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── addMessage ───────────────────────────────────────────────────────────────
function addMessage(msg) {
  if (!msg) return;
  const isAdmin  = currentUser?.isAdmin;
  const showReal = isAdmin && msg.realSender && msg.sender === 'Anónimo';
  const type     = msg.msgType || '';

  // Build text content (rainbow needs special span)
  let textContent = escapeHtml(msg.text);
  if (type === 'rainbow') textContent = `<span class="rainbow-text">${textContent}</span>`;

  const burnBar  = type === 'burn' ? '<div class="burn-bar"></div>' : '';

  const div = document.createElement('div');
  div.className = `message${type ? ` msg-${type}` : ''}`;
  div.innerHTML = `
    <div class="message-content">
      <div class="message-author">
        <div class="author-dot" style="background:${escapeHtml(msg.color||'#888')}"></div>
        <span style="color:${escapeHtml(msg.color||'#888')}">${escapeHtml(msg.sender)}</span>
        ${showReal ? `<span class="real-sender">(real: ${escapeHtml(msg.realSender)})</span>` : ''}
      </div>
      <div class="message-text">${textContent}</div>
      ${burnBar}
      <div class="message-time">${formatTime(msg.timestamp)}</div>
    </div>
  `;

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  // Burn: auto-destruir a los 10s
  if (type === 'burn') {
    setTimeout(() => {
      div.classList.add('burnt-out');
      setTimeout(() => { if (div.parentNode) div.remove(); }, 850);
    }, 10000);
  }
}

function sysMsg(text, color = '#888') {
  addMessage({ sender: 'Sistema', text, color, timestamp: Date.now() });
}

// ─── Users list ───────────────────────────────────────────────────────────────
function renderUsers(users) {
  if (!Array.isArray(users)) return;
  onlineCountEl.textContent = users.length;
  usersListEl.innerHTML = '';
  users.forEach(user => {
    const now    = Date.now();
    const banned = user.bannedUntil && now < user.bannedUntil;
    const muted  = user.mutedUntil  && now < user.mutedUntil;
    const act    = activityMap.get(user.name) || user.activity || 'online';
    const badge  = user.isAdmin ? '👑 Admin' : muted ? '🔇 Muteado' : banned ? '🚫 Baneado' : '';

    const div = document.createElement('div');
    div.className = 'user' + (user.isAdmin ? ' admin' : '') + (muted ? ' muted' : '') + (banned ? ' banned' : '');
    div.setAttribute('data-username', user.name);
    div.innerHTML = `
      <div class="activity-led ${act}"></div>
      <div class="user-dot" style="background:${escapeHtml(user.color||'#888')}"></div>
      <div class="user-info">
        <div class="user-name">${escapeHtml(user.name)}</div>
        ${badge ? `<div class="user-badge">${badge}</div>` : ''}
      </div>
    `;
    usersListEl.appendChild(div);
  });
}

// ─── Activity LED update (sin re-render completo) ─────────────────────────────
function updateLed(name, activity) {
  activityMap.set(name, activity);
  document.querySelectorAll(`[data-username="${CSS.escape(name)}"] .activity-led`).forEach(led => {
    led.className = `activity-led ${activity}`;
  });
}

// ─── Ban overlay ──────────────────────────────────────────────────────────────
function showBanOverlay(secondsLeft) {
  clearInterval(banInterval);
  banOverlay.classList.remove('hidden');
  let t = secondsLeft;
  banTimerEl.textContent = `${t}s`;
  banInterval = setInterval(() => {
    t--;
    if (t <= 0) { clearInterval(banInterval); banTimerEl.textContent = '0s'; setTimeout(() => location.reload(), 600); }
    else banTimerEl.textContent = `${t}s`;
  }, 1000);
}

// ─── Flashbang ────────────────────────────────────────────────────────────────
function triggerFlashbang() {
  flashOverlay.classList.remove('hidden');
  flashOverlay.style.opacity = '1';
  flashOverlay.style.transition = '';

  // Pitido con Web Audio API
  try {
    const ctx  = new AudioContext();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 4200; osc.type = 'sine';
    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.8);
    osc.start(); osc.stop(ctx.currentTime + 1.8);
  } catch(e) {}

  setTimeout(() => {
    flashOverlay.style.transition = 'opacity 2.2s ease-out';
    flashOverlay.style.opacity = '0';
    setTimeout(() => {
      flashOverlay.classList.add('hidden');
      flashOverlay.style.opacity = '1';
      flashOverlay.style.transition = '';
    }, 2300);
  }, 150);
}

// ─── Cinema ───────────────────────────────────────────────────────────────────
function extractYoutubeId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function openCinema({ url }) {
  cinemaContainer.classList.remove('hidden');
  cinemaVideo = null;

  const isAdmin   = currentUser?.isAdmin;
  const ytId      = extractYoutubeId(url);

  // Admin controls
  if (isAdmin) {
    $('cinemaCloseAll').classList.remove('hidden');
    if (!ytId) {
      $('cinemaPlay').classList.remove('hidden');
      $('cinemaPause').classList.remove('hidden');
    }
  }

  if (ytId) {
    cinemaPlayer.innerHTML =
      `<iframe src="https://www.youtube.com/embed/${ytId}?enablejsapi=1&autoplay=1" allowfullscreen allow="autoplay"></iframe>`;
  } else {
    cinemaPlayer.innerHTML = `<video id="cinemaVideoEl" src="${encodeURI(url)}" ${isAdmin ? 'controls' : ''}></video>`;
    cinemaVideo = $('cinemaVideoEl');

    if (isAdmin) {
      cinemaVideo.addEventListener('play',   () => socket.emit('cinemaControl', { action: 'play',  time: cinemaVideo.currentTime }));
      cinemaVideo.addEventListener('pause',  () => socket.emit('cinemaControl', { action: 'pause', time: cinemaVideo.currentTime }));
      cinemaVideo.addEventListener('seeked', () => socket.emit('cinemaControl', { action: 'seek',  time: cinemaVideo.currentTime }));
    }
  }
}

function closeCinema() {
  cinemaContainer.classList.add('hidden');
  cinemaPlayer.innerHTML = '';
  cinemaVideo = null;
  ['cinemaPlay','cinemaPause','cinemaCloseAll'].forEach(id => $(id).classList.add('hidden'));
}

$('cinemaCloseMe').addEventListener('click', () => cinemaContainer.classList.add('hidden'));
$('cinemaCloseAll').addEventListener('click', () => socket.emit('message', '/cinema'));
$('cinemaPlay').addEventListener('click',  () => { if (cinemaVideo) cinemaVideo.play(); });
$('cinemaPause').addEventListener('click', () => { if (cinemaVideo) cinemaVideo.pause(); });

// ─── Inspect / infoDownload ───────────────────────────────────────────────────
socket.on('collectInfo', async () => {
  const info = {
    plataforma:   navigator.platform,
    idioma:       navigator.language,
    zonaHoraria:  Intl.DateTimeFormat().resolvedOptions().timeZone,
    pantalla:     `${screen.width}x${screen.height}`,
    ventana:      `${window.innerWidth}x${window.innerHeight}`,
    pixelRatio:   window.devicePixelRatio,
    touchSupport: 'ontouchstart' in window,
    online:       navigator.onLine,
    cookies:      navigator.cookieEnabled,
    colorDepth:   screen.colorDepth + 'bit',
  };
  try {
    const bat = await navigator.getBattery();
    info.bateria = `${Math.round(bat.level * 100)}% (${bat.charging ? 'cargando' : 'descargando'})`;
  } catch { info.bateria = 'No disponible'; }
  socket.emit('infoReport', { data: info });
});

socket.on('infoDownload', data => {
  const lines  = Object.entries(data).map(([k, v]) => `${k.padEnd(18)}: ${v}`).join('\n');
  const blob   = new Blob([`=== INSPECT REPORT ===\nFecha: ${new Date().toISOString()}\n\n${lines}\n`], { type: 'text/plain' });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement('a');
  a.href = url; a.download = `inspect_${data.nombre || 'user'}_${Date.now()}.txt`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
});

// ─── Socket Events ────────────────────────────────────────────────────────────

socket.on('userData', user => {
  currentUser = user;
  // Guardar en localStorage para persistencia de admin, color y nick
  localStorage.setItem('chatUsername', user.name);
  localStorage.setItem('chatColor',    user.color);
  localStorage.setItem('chatIsAdmin',  user.isAdmin);
  joinModal.style.display = 'none';
  messageInput.disabled = false;
  sendBtn.disabled = false;
  statusEl.textContent = `✅ ${user.name}${user.isAdmin ? ' 👑' : ''}`;
  statusEl.className = 'status';
});

// Nick cambiado por admin
socket.on('nickChanged', ({ newName, newColor, isAdmin }) => {
  localStorage.setItem('chatUsername', newName);
  if (newColor) localStorage.setItem('chatColor', newColor);
  localStorage.setItem('chatIsAdmin', isAdmin);
  if (currentUser) { currentUser.name = newName; currentUser.color = newColor; currentUser.isAdmin = isAdmin; }
  statusEl.textContent = `✅ ${newName}${isAdmin ? ' 👑' : ''} (nick actualizado)`;
  sysMsg(`Tu nombre fue cambiado a ${newName}`, '#7289da');
});

socket.on('messages',     msgs    => { messagesEl.innerHTML = ''; if (Array.isArray(msgs)) msgs.forEach(addMessage); });
socket.on('message',      addMessage);
socket.on('usersUpdate',  renderUsers);
socket.on('activityUpdate', ({ name, activity }) => updateLed(name, activity));

socket.on('userJoined',   ({ name, color }) => sysMsg(`${name} se unió al chat`, '#43b581'));
socket.on('userLeft',     name             => sysMsg(`${name} abandonó el chat`, '#faa61a'));
socket.on('userRenamed',  ({ old: o, new: n }) => sysMsg(`${o} ahora se llama ${n}`, '#7289da'));

socket.on('clear', () => { messagesEl.innerHTML = ''; });

socket.on('freeze', () => {
  statusEl.textContent = '🧊 Chat congelado'; statusEl.className = 'status frozen';
  messageInput.disabled = true; sendBtn.disabled = true;
});
socket.on('unfreeze', () => {
  if (!currentUser) return;
  statusEl.textContent = `✅ ${currentUser.name}${currentUser.isAdmin ? ' 👑' : ''}`;
  statusEl.className = 'status';
  messageInput.disabled = false; sendBtn.disabled = false;
});

// Announcement neon overlay
socket.on('announcement', ({ text, from }) => {
  $('announceFrom').textContent = `📢 Anuncio de ${from}`;
  $('announceText').textContent = text;
  // Reset animación
  const box = document.querySelector('.announce-box');
  box.style.animation = 'none';
  void box.offsetWidth;
  box.style.animation = '';
  announceOverlay.classList.remove('hidden');
});
$('announceClose').addEventListener('click', () => announceOverlay.classList.add('hidden'));

socket.on('muted', () => {
  statusEl.textContent = '🔇 Muteado temporalmente'; statusEl.className = 'status muted';
  clearTimeout(statusEl._muteTimer);
  statusEl._muteTimer = setTimeout(() => {
    if (!currentUser) return;
    statusEl.textContent = `✅ ${currentUser.name}${currentUser.isAdmin ? ' 👑' : ''}`;
    statusEl.className = 'status';
  }, 3500);
});

socket.on('banned', ({ secondsLeft }) => {
  localStorage.removeItem('chatUsername'); // evitar reconexión automática al recargar
  showBanOverlay(secondsLeft);
});

socket.on('invalidName', msg => {
  localStorage.removeItem('chatUsername');
  showJoinError(msg);
});
socket.on('duplicateName', () => {
  localStorage.removeItem('chatUsername');
  showJoinError('Nombre en uso. Recargando...');
  setTimeout(() => location.reload(), 1500);
});

// Meme → window.open (nunca redirigir)
socket.on('meme', url => { if (/^https?:\/\/.+/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer'); });

socket.on('flashbang', triggerFlashbang);

socket.on('cinema',      data => openCinema(data));
socket.on('cinemaClose', ()   => closeCinema());
socket.on('cinemaControl', ({ action, time }) => {
  if (!cinemaVideo) return;
  if (action === 'play')  { cinemaVideo.currentTime = time; cinemaVideo.play().catch(()=>{}); }
  if (action === 'pause') { cinemaVideo.currentTime = time; cinemaVideo.pause(); }
  if (action === 'seek')  { cinemaVideo.currentTime = time; }
});

socket.on('panic', () => {
  panicOverlay.classList.remove('hidden');
  panicOverlay.classList.add('active');
  document.querySelector('.chat-container').classList.add('panic-active') ||
  document.body.classList.add('panic-active');
});
socket.on('unpanic', () => {
  panicOverlay.classList.add('hidden');
  panicOverlay.classList.remove('active');
  document.body.classList.remove('panic-active');
});

socket.on('disconnect', () => {
  statusEl.textContent = '⚠️ Desconectado'; statusEl.className = 'status offline';
  messageInput.disabled = true; sendBtn.disabled = true;
});
socket.on('connect', () => {
  if (currentUser) {
    statusEl.textContent = `✅ ${currentUser.name}`; statusEl.className = 'status';
    messageInput.disabled = false; sendBtn.disabled = false;
  }
});

// ─── /exec CSS ────────────────────────────────────────────────────────────────
socket.on('execCSS', payload => {
  try {
    // Sacamos el código del objeto payload que envía el nuevo server.js
    const css = (payload && payload.code) ? payload.code : payload;
    if (!css) return;

    let el = document.getElementById('admin-styles');
    if (!el) {
      el = document.createElement('style');
      el.id = 'admin-styles';
      document.head.appendChild(el);
    }
    el.textContent = css;
    console.log('🎨 CSS Inyectado');
  } catch(e) { console.error('[execCSS]', e); }
});

// ─── /exec JS ─────────────────────────────────────────────────────────────────
socket.on('execJS', payload => {
  try {
    // 1. Extraer el código del objeto del servidor
    let code = (payload && payload.code) ? payload.code : payload;
    if (!code) return;

    // 2. Limpieza de caracteres invisibles y normalización
    code = code.replace(/^\uFEFF/, '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    code = code.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

    // 3. FIX DE SEGURIDAD PARA COMILLAS (Estilos y Audios)
    // Si pones: .style.color=red  -> lo convierte en .style.color='red'
    code = code.replace(
      /(\.\s*style\s*\.\s*\w+\s*=\s*)([^'"`;\n][^;\n]*)/g,
      (_, prefix, val) => {
        const v = val.trim();
        if (/^['"`]/.test(v) || /^(true|false|\d)/.test(v)) return prefix + v;
        return `${prefix}'${v.replace(/'/g, "\\'")}'`;
      }
    );

    // 4. EJECUCIÓN
    console.log('⚡ Ejecutando JS:', code);
    
    // Usamos una función anónima para que el código tenga su propio espacio
    const execute = new Function(code);
    execute();

  } catch(e) {
    console.error('[execJS] Fallo:', e.message);
    if (typeof sysMsg === 'function') sysMsg(`⚠️ Error JS: ${e.message}`, '#ff4444');
  }
});
