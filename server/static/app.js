'use strict';

/* ================================================================ helpers */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const view = $('#view');

const api = {
  async get(p) {
    const r = await fetch('/api/' + p);
    return r.json();
  },
  async post(p, body) {
    const r = await fetch('/api/' + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  },
};

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('basecamp.' + k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('basecamp.' + k, JSON.stringify(v));
      return true;
    } catch {
      return false;
    }
  },
};
// chats and settings saved under the old pre-release prefix keep working
try {
  const OLD = /^(?!basecamp\.)[a-z]+\.(chats|codeAuto|kb|langFilter|libCat|mapView|model|onlyInstalled|panelW|readerPrefs|recent|sidebar|think)$/;
  for (const k of Object.keys(localStorage)) {
    const m = k.match(OLD);
    if (!m) continue;
    if (localStorage.getItem('basecamp.' + m[1]) === null) localStorage.setItem('basecamp.' + m[1], localStorage.getItem(k));
    localStorage.removeItem(k);
  }
} catch {}

const fmtSize = b => {
  if (!b) return '0 MB';
  if (b >= 1e9) return (b / 1e9).toFixed(b >= 1e10 ? 0 : 1).replace('.', ',') + ' GB';
  return Math.max(1, Math.round(b / 1e6)) + ' MB';
};
const fmtGb = gb => (gb >= 1 ? (gb >= 10 ? Math.round(gb) : gb.toFixed(1).replace('.', ',')) + ' GB' : Math.max(1, Math.round(gb * 1000)) + ' MB');
const fmtNum = n => Number(n || 0).toLocaleString('de-DE');
const encPath = p => p.split('/').map(encodeURIComponent).join('/');
const readHref = (book, path) => `#/read/${encodeURIComponent(book)}/${encPath(path || '')}`;
// pages from ZIM files and the user's files are served from a second origin, see ContentHandler in app.py
const CONTENT = `${location.protocol}//${location.hostname.includes(':') && !location.hostname.startsWith('[') ? `[${location.hostname}]` : location.hostname}:${(+location.port || 80) + 1}`;
const zimSrc = (book, path) => `${CONTENT}/zim/${encodeURIComponent(book)}/${encPath(path || '')}`;
const fileSrc = path => `${CONTENT}/files/${encPath(path)}`;
const pct = t => (t.total ? Math.floor((t.done / t.total) * 100) : 0);
const initial = s => (String(s || '?').replace(/[^\p{L}\p{N}]/gu, '')[0] || '?').toUpperCase();
const snippetHtml = s => esc(s).replace(/&lt;(\/?)b&gt;/g, '<$1b>');

// Live timers: elements with data-since show the time since then. Re-rendering does not reset them.
const fmtSecs = ms => {
  const t = Math.max(0, Math.floor(ms / 1000));
  return t < 60 ? `${t} s` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} min`;
};
setInterval(() => $$('[data-since]').forEach(el => (el.textContent = fmtSecs(Date.now() - +el.dataset.since))), 250);
const since = t => `<span class="secs" data-since="${t}">${fmtSecs(Date.now() - t)}</span>`;
// the text shine restarts whenever the element is rebuilt; a negative delay keeps it in step with the clock
const shimmer = text => `<span class="shimmer" style="animation-delay:-${((performance.now() % 1600) / 1000).toFixed(2)}s">${text}</span>`;
// thinking, Grok style: header with timer, the newest lines fading in below, full text on click
function thoughtHtml(m, live) {
  const label = live ? `${shimmer('Denkt nach')}${since(m.thinkStart || Date.now())}`
    : `Nachgedacht${m.thinkSecs ? ' · ' + fmtSecs(m.thinkSecs * 1000) : ''}`;
  const tail = live && !m._open ? `<div class="th-tail"><div>${esc(m.thinking.slice(-700))}</div></div>` : '';
  return `<details class="thought ${live ? 'live' : ''}" ${m._open ? 'open' : ''}><summary>${label}${ic('chevRight', 14)}</summary><div class="body">${esc(m.thinking)}</div></details>${tail}`;
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Kopiert');
}

/* ================================================================ icons */

const ICONS = {
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9.5 4v16"/>',
  edit: '<path d="M12 20h8"/><path d="M16.4 3.6a2 2 0 0 1 2.9 2.9L7.5 18.3l-3.9 1.1 1.1-3.9z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.2-4.2"/>',
  library: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  arrowUp: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  clip: '<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  book: '<path d="M2 4.5h6a4 4 0 0 1 4 4V21a3 3 0 0 0-3-3H2z"/><path d="M22 4.5h-6a4 4 0 0 0-4 4V21a3 3 0 0 1 3-3h7z"/>',
  bulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.1 14c.2-1 .7-1.7 1.4-2.5A6 6 0 1 0 7.5 11.5c.7.8 1.2 1.5 1.4 2.5"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  chevRight: '<path d="m9 6 6 6-6 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  external: '<path d="M15 3h6v6M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15h-.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  sparkle: '<path d="M12 3c.4 3.8 2.2 5.6 6 6-3.8.4-5.6 2.2-6 6-.4-3.8-2.2-5.6-6-6 3.8-.4 5.6-2.2 6-6z"/><path d="M19 15c.2 1.6.9 2.3 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.6-.9-2.3-2.5-2.5 1.6-.2 2.3-.9 2.5-2.5z"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8.5 8.5h.01M15.5 15.5h.01M15.5 8.5h.01M8.5 15.5h.01M12 12h.01" stroke-width="3"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2.5"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0"/><path d="M12 19.5h.01" stroke-width="3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  message: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  map: '<path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="2.6"/>',
  type: '<path d="M4 7V5h11v2"/><path d="M9.5 5v14"/><path d="M7.5 19h4"/><path d="M14 13v-1.5h6V13"/><path d="M17 11.5V19"/><path d="M15.8 19h2.4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>',
};
const LOGO = (size = 22) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M12 2.5 22.5 21h-21Z M12 11l4.6 10H7.4Z"/><circle cx="18.5" cy="5.5" r="1.6"/></svg>`;
const wordmark = tag => `<div class="wordmark">${LOGO(50)}<span>Basecamp</span>${tag ? `<em class="tag">${tag}</em>` : ''}</div>`;
const ic = (name, size = 18, sw = 1.8) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

function hydrateIcons(root = document) {
  $$('[data-logo]', root).forEach(el => (el.innerHTML = LOGO(22)));
  $$('[data-icon]', root).forEach(el => {
    if (el.dataset.done) return;
    el.insertAdjacentHTML('afterbegin', ic(el.dataset.icon));
    el.dataset.done = '1';
  });
}

const srcIco = (id, title, cls = '') =>
  `<span class="src-ico ${cls}"><img src="/api/icon/${encodeURIComponent(id)}" alt="" loading="lazy" onerror="this.replaceWith('${initial(title)}')"></span>`;

/* ================================================================ state */

const state = {
  books: [],
  categories: [],
  models: null,
  tasks: [],
  status: null,
  view: '',
  chat: null, // current chat controller
};
const live = new Map(); // chat id -> controller, while an answer streams
const deleted = new Set(); // chats removed while they were still streaming

async function loadBooks() {
  const r = await api.get('books');
  state.books = r.books;
  state.categories = r.categories;
  return r;
}
async function loadModels() {
  state.models = await api.get('models');
  return state.models;
}
const bookById = id => state.books.find(b => b.id === id);

/* ================================================================ shell */

const appEl = $('#app');

function setSidebar(open) {
  appEl.classList.toggle('sb-collapsed', !open);
  if (innerWidth > 900) store.set('sidebar', open);
}
setSidebar(innerWidth > 900 ? store.get('sidebar', true) : false);
$('#sbClose').onclick = () => setSidebar(false);
$('#sbOpen').onclick = () => setSidebar(true);
$('#sbExpand').onclick = () => setSidebar(true);
$('#scrim').onclick = () => setSidebar(false);
$('#openSearch').onclick = () => openPalette();

function onKey(e) {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'k') {
    e.preventDefault();
    $('#palette').hidden ? openPalette() : closePalette();
  } else if (mod && e.shiftKey && k === 'o') {
    e.preventDefault();
    location.hash = '#/';
  } else if (e.key === 'Escape') {
    if (!$('#palette').hidden) closePalette();
    else if ($('.menu')) closeMenus();
    else if (!$('#panel').hidden) closePanel();
  }
}
document.addEventListener('keydown', onKey);

function closeMenus() {
  $$('.menu').forEach(m => m.remove());
}
// .view clips anything above it, so an upward menu only gets the room over its anchor and scrolls inside
function fitMenuUp(menu, anchor) {
  const room = anchor.getBoundingClientRect().top - $('#view').getBoundingClientRect().top - 16;
  menu.style.maxHeight = `min(70vh, ${room}px)`;
}
document.addEventListener('mousedown', e => {
  if (!e.target.closest('.menu, .picker-btn, .opts-btn')) closeMenus();
});

/* ---------------------------------------------------------------- chat history */

const Chats = {
  all: () => store.get('chats', []),
  get: id => Chats.all().find(c => c.id === id),
  save(chat) {
    const slim = {
      ...chat,
      updated: Date.now(),
      messages: chat.messages.map(m => {
        const { images, _el, ...rest } = m;
        return images ? { ...rest, hadImage: true } : rest;
      }),
    };
    const list = Chats.all().filter(c => c.id !== chat.id);
    list.unshift(slim);
    if (store.set('chats', list.slice(0, 100))) return;
    // storage full (code chats keep whole files): shorten tool output, then drop the oldest chats
    const cut = t => (typeof t === 'string' && t.length > 1500 ? t.slice(0, 1500) + ' …' : t);
    for (const c of list) for (const m of c.messages) for (const k of m.calls || []) {
      if (k.result) k.result.output = cut(k.result.output);
      if (k.args?.content) k.args.content = cut(k.args.content);
    }
    for (let n = list.length; n > 1; n = Math.floor(n * 0.7)) if (store.set('chats', list.slice(0, n))) return;
    toast('Speicher voll: alte Chats wurden nicht gespeichert.');
  },
  remove(id) {
    deleted.add(id);
    live.get(id)?.stop?.();
    store.set('chats', Chats.all().filter(c => c.id !== id));
  },
};

function renderChatList() {
  const list = Chats.all();
  const el = $('#chatList');
  if (!list.length) {
    el.innerHTML = '<div class="sb-empty">Deine Chats erscheinen hier.</div>';
    return;
  }
  const day = 864e5;
  const today = new Date().setHours(0, 0, 0, 0);
  const groups = [['Heute', []], ['Gestern', []], ['Letzte 7 Tage', []], ['Älter', []]];
  for (const c of list) {
    const t = c.updated || c.created;
    groups[t >= today ? 0 : t >= today - day ? 1 : t >= today - 7 * day ? 2 : 3][1].push(c);
  }
  const active = ['', 'c', 'code'].includes(state.view) ? state.chat?.chat.id : null;
  el.innerHTML = groups.filter(g => g[1].length).map(([label, items]) => `
    <div class="sb-group">${label}</div>
    ${items.map(c => `
      <a class="sb-chat ${c.id === active ? 'active' : ''}" href="#/${c.kind === 'code' ? 'code' : 'c'}/${c.id}">
        ${c.kind === 'code' ? `<i class="sb-kind" title="Basecamp Code">${ic('terminal', 14)}</i>` : ''}<span>${esc(c.title || 'Neuer Chat')}</span>
        <button data-del="${c.id}" title="Löschen">${ic('trash', 15)}</button>
      </a>`).join('')}`).join('');
  $$('[data-del]', el).forEach(b => (b.onclick = e => {
    e.preventDefault();
    e.stopPropagation();
    Chats.remove(b.dataset.del);
    if (b.dataset.del === active) location.hash = state.view === 'code' ? '#/code' : '#/';
    else renderChatList();
  }));
}

/* ================================================================ router */

function route() {
  const hash = location.hash.slice(1) || '/';
  const [path, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  const page = parts[0] || '';
  state.view = page;
  if (page !== 'map' && mapState.map) {
    mapState.map.remove();
    mapState.map = null;
    mapState.observer?.disconnect();
  }
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === page));
  $('#topLeft').innerHTML = '';
  $('#topRight').innerHTML = '';
  closeMenus();
  renderChatList();
  if (innerWidth <= 900) setSidebar(false);
  if (page === 'read') return showReader(decodeURIComponent(parts[1] || ''), parts.slice(2).map(decodeURIComponent).join('/'));
  if (page === 'library') return showLibrary();
  if (page === 'map') return showMap(params);
  if (page === 'code') return showCode(parts[1]);
  if (page === 'settings') return showSettings(params.get('tab') || 'content');
  if (page === 'c') return showChat(parts[1]);
  return showChat(null, params.get('q'), params.get('article'));
}
window.addEventListener('hashchange', route);

/* ================================================================ article panel & reader */

const panel = { el: $('#panel'), frame: $('#panelFrame'), book: null, path: null, title: '' };

// ZIM pages run on their own origin (port + 1) and cannot touch the app. reader.js inside them
// reports what they show via postMessage; we answer with the reader settings.
const readerPrefs = () => ({ size: 1, wide: false, ...store.get('readerPrefs', {}) });

class FrameNav {
  constructor(frame, onPage) {
    this.frame = frame;
    this.onPage = onPage;
    this.stack = [];
    this.i = -1;
    this.pending = null;
    this.page = null;
    FrameNav.all.add(this);
  }
  seen(d) {
    const key = d.book + '/' + d.path;
    if (this.pending !== null) {
      this.i = this.pending;
      this.pending = null;
    } else if (this.stack[this.i] !== key) {
      this.stack.splice(this.i + 1);
      this.stack.push(key);
      this.i = this.stack.length - 1;
    }
    this.page = d;
    this.onPage(d);
  }
  go(step) {
    const j = this.i + step;
    if (j < 0 || j >= this.stack.length) return;
    this.pending = j;
    const [book, ...rest] = this.stack[j].split('/');
    this.frame.contentWindow.location.replace(zimSrc(book, rest.join('/')));
  }
  canGo(step) { return this.i + step >= 0 && this.i + step < this.stack.length; }
  post(msg) { this.frame.contentWindow?.postMessage({ bc: 1, ...msg }, CONTENT); }
  drop() { FrameNav.all.delete(this); }
}
FrameNav.all = new Set();

window.addEventListener('message', e => {
  if (e.origin !== CONTENT || !e.data || !e.data.bc) return;
  const d = e.data;
  if (d.type === 'key') return onKey({ key: d.key, metaKey: d.mod, ctrlKey: false, shiftKey: d.shift, preventDefault() {} });
  if (d.type !== 'page') return;
  const nav = [...FrameNav.all].find(n => n.frame.contentWindow === e.source);
  if (!nav) return;
  e.source.postMessage({ bc: 1, type: 'prefs', ...readerPrefs() }, CONTENT);
  const recent = store.get('recent', []).filter(r => !(r.book === d.book && r.path === d.path));
  recent.unshift({ book: d.book, path: d.path, title: d.title });
  store.set('recent', recent.slice(0, 12));
  nav.seen(d);
});

function openArticle(book, path) {
  if (innerWidth > 900 && state.view !== 'read') openPanel(book, path);
  else location.hash = readHref(book, path);
}

const panelNav = new FrameNav(panel.frame, d => {
  panel.book = d.book;
  panel.path = d.path;
  panel.title = d.title;
  $('#panelTitle').textContent = d.title;
  $('#panelFull').href = readHref(d.book, d.path);
  $('#panelBack').hidden = !panelNav.canGo(-1);
});

function openPanel(book, path) {
  const b = bookById(book);
  panel.el.hidden = false;
  panel.book = book;
  panel.path = path;
  panel.el.style.width = store.get('panelW', null) ? store.get('panelW') + 'px' : '';
  $('#panelIco').innerHTML = `<img src="/api/icon/${encodeURIComponent(book)}" alt="" onerror="this.replaceWith('${initial(b?.title)}')">`;
  $('#panelTitle').textContent = path.split('/').pop().replace(/_/g, ' ');
  $('#panelSource').textContent = b?.title || book;
  $('#panelFull').href = readHref(book, path);
  panel.frame.src = zimSrc(book, path);
}

function closePanel() {
  panel.el.hidden = true;
  panel.frame.src = 'about:blank';
  panel.book = null;
  panelNav.stack = [];
  panelNav.i = -1;
}

$('#panelBack').onclick = () => panelNav.go(-1);
$('#panelClose').onclick = closePanel;
$('#panelFull').onclick = () => setTimeout(closePanel, 0);
$('#panelAsk').onclick = () => {
  const art = { book: panel.book, path: panel.path, title: panel.title || $('#panelTitle').textContent };
  if ((state.view === '' || state.view === 'c') && state.chat) state.chat.attachArticle(art);
  else {
    pendingArticle = art;
    location.hash = '#/';
  }
};

// resize the panel by dragging its left edge
$('#panelGrip').addEventListener('pointerdown', e => {
  e.preventDefault();
  const grip = e.currentTarget;
  grip.classList.add('drag');
  appEl.classList.add('dragging');
  const move = ev => {
    const w = Math.min(Math.max(innerWidth - ev.clientX, 360), innerWidth * 0.7);
    panel.el.style.width = w + 'px';
  };
  const up = () => {
    grip.classList.remove('drag');
    appEl.classList.remove('dragging');
    store.set('panelW', parseInt(panel.el.style.width, 10));
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});

let pendingArticle = null;
let readerNav = null;

function showReader(book, path) {
  if (panel.book) closePanel();
  readerNav?.drop();
  const b = bookById(book);
  view.innerHTML = `<div class="reader"><iframe id="readerFrame" title="Artikel" src="${zimSrc(book, path)}"></iframe></div>`;
  const frame = $('#readerFrame');
  const setCrumb = (title, bk) => {
    const bb = bookById(bk) || b;
    $('#topLeft').innerHTML = `
      <button class="icon-btn" id="rBack" title="Zurück" ${readerNav?.canGo(-1) ? '' : 'disabled'}>${ic('arrowLeft')}</button>
      <button class="icon-btn" id="rFwd" title="Vor" ${readerNav?.canGo(1) ? '' : 'disabled'}>${ic('arrowRight')}</button>
      <a class="crumb" href="${readHref(bk, bb?.main || '')}" title="Startseite von ${esc(bb?.title || bk)}">${srcIco(bk, bb?.title)}<span class="t">${esc(title)}</span><span class="s">${esc(bb?.title || bk)}</span></a>`;
    $('#rBack').onclick = () => readerNav.go(-1);
    $('#rFwd').onclick = () => readerNav.go(1);
  };
  const tools = page => {
    const toc = page?.toc || [];
    $('#topRight').innerHTML = `
      <div class="picker" id="rTocWrap" ${toc.length && !(page.sidebar && frame.clientWidth >= 1180) ? '' : 'hidden'}><button class="btn sm ghost picker-btn" id="rToc">${ic('list', 16)}<span>Inhalt</span></button></div>
      <div class="picker"><button class="icon-btn picker-btn" id="rText" title="Text und Breite">${ic('type', 18)}</button></div>
      <button class="icon-btn" id="rSearch" title="In ${esc(bookById(page?.book || book)?.title || 'dieser Quelle')} suchen">${ic('search')}</button>
      <a class="icon-btn" id="rNew" title="In neuem Tab öffnen" target="_blank" rel="noopener" href="${zimSrc(page?.book || book, page?.path || path)}">${ic('external')}</a>
      <button class="btn sm primary" id="rAsk">${ic('sparkle', 15)} Fragen</button>`;
    $('#rAsk').onclick = () => {
      const p = readerNav.page || { book, path, title: path };
      pendingArticle = { book: p.book, path: p.path, title: p.title };
      location.hash = '#/';
    };
    $('#rSearch').onclick = () => openPalette('', page?.book || book);
    $('#rToc').onclick = e => {
      e.stopPropagation();
      const wrap = $('#rTocWrap');
      if ($('.menu', wrap)) return closeMenus();
      const menu = document.createElement('div');
      menu.className = 'menu right toc-menu';
      menu.innerHTML = `<button class="menu-item" data-top>Zum Anfang</button>` +
        toc.map(t => `<button class="menu-item l${t.level}" data-id="${esc(t.id)}">${esc(t.text)}</button>`).join('');
      wrap.appendChild(menu);
      $$('[data-id], [data-top]', menu).forEach(x => (x.onclick = () => {
        readerNav.post(x.dataset.id ? { type: 'goto', id: x.dataset.id } : { type: 'top' });
        closeMenus();
      }));
    };
    $('#rText').onclick = e => {
      e.stopPropagation();
      const wrap = $('#rText').parentElement;
      if ($('.menu', wrap)) return closeMenus();
      const menu = document.createElement('div');
      menu.className = 'menu right text-menu';
      const draw = () => {
        const p = readerPrefs();
        menu.innerHTML = `
          <div class="menu-label">Textgröße</div>
          <div class="seg-row">${['Klein', 'Normal', 'Groß'].map((l, i) => `<button class="${p.size === i ? 'on' : ''}" data-size="${i}">${l}</button>`).join('')}</div>
          <div class="menu-label">Breite</div>
          <div class="seg-row">${['Standard', 'Breit'].map((l, i) => `<button class="${+p.wide === i ? 'on' : ''}" data-wide="${i}">${l}</button>`).join('')}</div>`;
        $$('button', menu).forEach(x => (x.onclick = ev => {
          ev.stopPropagation();
          const next = { ...readerPrefs() };
          if (x.dataset.size) next.size = +x.dataset.size;
          if (x.dataset.wide) next.wide = x.dataset.wide === '1';
          store.set('readerPrefs', next);
          FrameNav.all.forEach(n => n.post({ type: 'prefs', ...next }));
          draw();
        }));
      };
      draw();
      wrap.appendChild(menu);
    };
  };
  readerNav = new FrameNav(frame, d => {
    if (state.view !== 'read') return;
    setCrumb(d.title, d.book);
    tools(d);
    history.replaceState(null, '', readHref(d.book, d.path));
  });
  setCrumb(path.split('/').pop().replace(/_/g, ' ') || b?.title || '', book);
  tools(null);
}

/* ================================================================ command palette */

const pal = { wrap: $('#palette'), input: $('#palInput'), res: $('#palResults'), items: [], sel: 0, seq: 0, timer: 0, book: null };

function setPaletteScope(book) {
  pal.book = book && bookById(book) ? book : null;
  const chip = $('#palScope');
  chip.hidden = !pal.book;
  if (pal.book) chip.innerHTML = `${srcIco(pal.book, bookById(pal.book).title)}<span>${esc(bookById(pal.book).title)}</span>${ic('x', 13, 2.2)}`;
  pal.input.placeholder = pal.book ? `In ${bookById(pal.book).title} suchen …` : 'Wikipedia, iFixit, Orte … durchsuchen';
}
$('#palScope').onclick = () => { setPaletteScope(null); pal.input.focus(); searchPalette(pal.input.value); };

function openPalette(q = '', book = null) {
  pal.wrap.hidden = false;
  setPaletteScope(book);
  pal.input.value = q;
  pal.input.focus();
  pal.input.select();
  searchPalette(q);
}
function closePalette() {
  pal.wrap.hidden = true;
}
pal.wrap.addEventListener('mousedown', e => {
  if (e.target === pal.wrap) closePalette();
});
pal.input.addEventListener('input', () => {
  clearTimeout(pal.timer);
  pal.timer = setTimeout(() => searchPalette(pal.input.value), 90);
});
pal.input.addEventListener('keydown', e => {
  if (e.key === 'Backspace' && pal.book && !pal.input.value) {
    setPaletteScope(null);
    searchPalette('');
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!pal.items.length) return;
    pal.sel = (pal.sel + (e.key === 'ArrowDown' ? 1 : -1) + pal.items.length) % pal.items.length;
    markPalette(true);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pal.items[pal.sel]?.run();
  }
});

function markPalette(scroll) {
  $$('.pal-item', pal.res).forEach((el, i) => {
    el.classList.toggle('sel', i === pal.sel);
    if (i === pal.sel && scroll) el.scrollIntoView({ block: 'nearest' });
  });
}

function drawPalette(sections) {
  pal.items = [];
  let html = '';
  for (const s of sections) {
    if (!s.items.length) continue;
    if (s.label) html += `<div class="pal-label">${s.label}</div>`;
    for (const it of s.items) {
      html += `<div class="pal-item" data-i="${pal.items.length}">${it.html}</div>`;
      pal.items.push(it);
    }
  }
  pal.res.innerHTML = html || '<div class="pal-empty">Nichts gefunden.</div>';
  pal.sel = Math.min(pal.sel, Math.max(pal.items.length - 1, 0));
  $$('.pal-item', pal.res).forEach(el => {
    el.onmousemove = () => {
      if (pal.sel !== +el.dataset.i) {
        pal.sel = +el.dataset.i;
        markPalette(false);
      }
    };
    el.onclick = () => pal.items[+el.dataset.i].run();
  });
  markPalette(false);
}

const palArticle = (book, path, title, sub) => ({
  html: `${srcIco(book, bookById(book)?.title, 'md')}<div class="grow"><b>${esc(title)}</b><small>${sub}</small></div><span class="hint">Öffnen ↵</span>`,
  run: () => {
    closePalette();
    openArticle(book, path);
  },
});

async function searchPalette(q) {
  const my = ++pal.seq;
  q = q.trim();
  pal.sel = 0;
  if (!state.books.length) await loadBooks();
  if (!q && pal.book) {
    const b = bookById(pal.book);
    drawPalette([{ items: [
      { html: `${srcIco(b.id, b.title, 'md')}<div class="grow"><b>Startseite</b><small>${esc(b.title)}</small></div><span class="hint">Öffnen ↵</span>`, run: () => { closePalette(); openArticle(b.id, b.main); } },
      { html: `<span class="lead">${ic('dice', 16)}</span><div class="grow"><b>Zufälliger Artikel</b><small>${esc(b.title)}</small></div>`, run: async () => { closePalette(); const r = await api.get('random?book=' + encodeURIComponent(b.id)); if (r.book) openArticle(r.book, r.path); } },
    ] }]);
    return;
  }
  if (!q) {
    const recent = store.get('recent', []).filter(r => bookById(r.book)).slice(0, 5);
    drawPalette([
      { label: 'Aktionen', items: [
        { html: `<span class="lead">${ic('edit', 16)}</span><div class="grow"><b>Neuer Chat</b></div><span class="hint">⇧⌘O</span>`, run: () => { closePalette(); location.hash = '#/'; } },
        { html: `<span class="lead">${ic('library', 16)}</span><div class="grow"><b>Bibliothek öffnen</b></div>`, run: () => { closePalette(); location.hash = '#/library'; } },
        { html: `<span class="lead">${ic('map', 16)}</span><div class="grow"><b>Karte öffnen</b></div>`, run: () => { closePalette(); location.hash = '#/map'; } },
        { html: `<span class="lead">${ic('terminal', 16)}</span><div class="grow"><b>Basecamp Code</b><small>Skripte bauen lassen</small></div>`, run: () => { closePalette(); location.hash = '#/code'; } },
        { html: `<span class="lead">${ic('dice', 16)}</span><div class="grow"><b>Zufälliger Artikel</b></div>`, run: async () => { closePalette(); const r = await api.get('random'); if (r.book) openArticle(r.book, r.path); } },
      ] },
      { label: 'Zuletzt gelesen', items: recent.map(r => palArticle(r.book, r.path, r.title, esc(bookById(r.book)?.title || ''))) },
    ]);
    return;
  }
  const ask = {
    html: `<span class="lead ask">${ic('sparkle', 16)}</span><div class="grow"><b>Basecamp fragen: „${esc(q)}“</b><small>Antwort mit Quellen aus deiner Bibliothek</small></div><span class="hint">↵</span>`,
    run: () => {
      closePalette();
      location.hash = '#/?q=' + encodeURIComponent(q);
    },
  };
  const scope = pal.book ? '&books=' + encodeURIComponent(pal.book) : '';
  const [sug, pl] = await Promise.all([
    api.get('suggest?q=' + encodeURIComponent(q) + scope),
    pal.book ? { results: [] } : api.get('places?limit=3&q=' + encodeURIComponent(q)).catch(() => ({ results: [] })),
  ]);
  if (my !== pal.seq) return;
  const titles = sug.results.slice(0, 6).map(s => palArticle(s.book, s.path, s.title, esc(s.source)));
  const places = pl.results.map(r => ({
    html: `<span class="lead">${ic('pin', 16)}</span><div class="grow"><b>${esc(r.name)}</b><small>${esc([r.kind, countryName(r.cc), r.official].filter(Boolean).join(' · '))}</small></div><span class="hint">Karte ↵</span>`,
    run: () => { closePalette(); location.hash = mapHref(r); },
  }));
  drawPalette([{ items: [ask] }, { label: 'Artikel', items: titles }, { label: 'Orte', items: places }]);

  await sleep(180);
  if (my !== pal.seq) return;
  const r = await api.get(`search?limit=${pal.book ? 12 : 4}&q=${encodeURIComponent(q)}${scope}`);
  if (my !== pal.seq) return;
  const seen = new Set(sug.results.slice(0, 6).map(s => s.book + '/' + s.path));
  const full = [];
  for (const g of r.groups) {
    for (const x of g.results) {
      if (seen.has(g.book + '/' + x.path)) continue;
      seen.add(g.book + '/' + x.path);
      full.push(palArticle(g.book, x.path, x.title, `${esc(g.title)}${x.snippet ? ' · ' + snippetHtml(x.snippet) : ''}`));
    }
  }
  const files = r.files.map(f => ({
    html: `<span class="lead">${ic('file', 16)}</span><div class="grow"><b>${esc(f.name)}</b><small>${esc(f.ext.toUpperCase())} · ${fmtSize(f.size)}</small></div><span class="hint">Öffnen ↵</span>`,
    run: () => { closePalette(); window.open(fileSrc(f.path), '_blank'); },
  }));
  const keepSel = pal.sel;
  drawPalette([{ items: [ask] }, { label: 'Artikel', items: titles }, { label: 'Orte', items: places }, { label: 'Im Text gefunden', items: full.slice(0, 14) }, { label: 'Eigene Dateien', items: files }]);
  pal.sel = keepSel;
  markPalette(false);
}

/* ================================================================ markdown */

function md(src) {
  const codes = [];
  src = src.replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, (_, code) => {
    codes.push(code);
    return `\n\u0000${codes.length - 1}\u0000\n`;
  });
  const inline = s =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\[(\d+(?:\s*[,;]\s*\d+)*)\]/g, (_, ns) =>
        ns.split(/[,;]/).map(n => `<a class="cite" data-n="${n.trim()}">${n.trim()}</a>`).join(''));
  const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const isSep = l => /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/.test(l);
  const out = [];
  let para = [], list = null, table = [];
  const flushPara = () => {
    if (para.length) out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.type}>` + list.items.map(it => `<li${it.sub ? ' class="sub"' : ''}>${inline(it.text)}</li>`).join('') + `</${list.type}>`);
    list = null;
  };
  const flushTable = () => {
    if (table.length) {
      const head = table.length > 1 && isSep(table[1]) ? cells(table[0]) : null;
      const rows = table.filter((l, i) => !(head && i <= 1) && !isSep(l)).map(cells);
      out.push('<table>' + (head ? '<tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr>' : '') +
        rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</table>');
    }
    table = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushTable(); };
  for (const line of src.split('\n')) {
    let m;
    if ((m = line.match(/^\u0000(\d+)\u0000$/))) { flushAll(); out.push(`<pre><code>${esc(codes[+m[1]])}</code></pre>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); flushList(); table.push(line); continue; }
    flushTable();
    if ((m = line.match(/^(#{1,6})\s+(.*)/))) { flushAll(); const t = m[1].length <= 2 ? 'h3' : 'h4'; out.push(`<${t}>${inline(m[2])}</${t}>`); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
    if ((m = line.match(/^(\s*)([-*•+]|\d+[.)])\s+(.*)/))) {
      flushPara();
      const type = /\d/.test(m[2]) ? 'ol' : 'ul';
      const sub = m[1].length >= 2;
      if (!list || (list.type !== type && !sub)) { flushList(); list = { type, items: [] }; }
      list.items.push({ text: m[3], sub });
      continue;
    }
    if ((m = line.match(/^>\s?(.*)/))) { flushAll(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (!line.trim()) { flushAll(); continue; }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1].text += ' ' + line.trim(); continue; }
    flushList();
    para.push(line);
  }
  flushAll();
  return out.join('');
}

/* ================================================================ chat */

const STARTERS = [
  'Woran erkenne ich einen Herzinfarkt?',
  'Wie mache ich Wasser trinkbar?',
  'Wie wechsle ich einen Fahrradschlauch?',
  'Erkläre Photosynthese einfach',
];

function chatModels(code = false) {
  return (state.models?.installed || []).filter(m => {
    const caps = m.caps || [];
    return (caps.includes('completion') || !caps.length) && (!code || caps.includes('tools'));
  });
}
function currentModel(code = false) {
  const names = chatModels(code).map(m => m.name);
  const want = store.get(code ? 'codeModel' : 'model');
  if (names.includes(want)) return want;
  const def = code ? state.models?.code_default : state.models?.default;
  return names.includes(def) ? def : names[0];
}
function modelMeta(name) {
  return (state.models?.catalog || []).find(m => m.name === name);
}

async function mountModelPicker(code = false) {
  const m = state.models || (await loadModels());
  if (!(code ? ['code'] : ['', 'c']).includes(state.view)) return;
  const slot = state.chat && $('.model-slot', state.chat.root);
  if (!slot) return;
  const cur = currentModel(code);
  const meta = modelMeta(cur);
  const [main, sub] = meta ? meta.title.split(' · ') : [cur || 'Kein Modell', ''];
  slot.innerHTML = `<button type="button" class="picker-btn" title="Modell wählen">
    <span>${esc(m.ollama ? main : 'KI aus')}</span>${sub && m.ollama ? `<span class="sub">${esc(sub)}</span>` : ''}${ic('chevDown', 15)}</button>`;
  $('.picker-btn', slot).onclick = e => {
    e.stopPropagation();
    if ($('.menu', slot)) return closeMenus();
    closeMenus();
    const items = chatModels(code);
    const menu = document.createElement('div');
    menu.className = 'menu up right';
    menu.innerHTML = `
      ${!m.ollama ? '<div class="menu-label">Ollama läuft nicht. Starte mit ./basecamp start</div>' : ''}
      ${items.length ? `<div class="menu-label">${code ? 'Modell für Code (mit Werkzeugen)' : 'Modell'}</div>` : ''}
      ${items.map(x => {
        const mm = modelMeta(x.name);
        return `<button type="button" class="menu-item ${x.name === cur ? 'on' : ''}" data-model="${esc(x.name)}">
          <div class="grow"><b>${esc(mm?.title || x.name)}</b><small>${esc(mm?.desc || [x.params, x.quant].filter(Boolean).join(' · '))}</small></div>
          <span class="check">${ic('check', 16)}</span></button>`;
      }).join('')}
      ${items.length ? '<div class="menu-sep"></div>' : ''}
      <a class="menu-item" href="#/settings?tab=models"><div class="grow"><b>${items.length ? 'Modelle verwalten' : 'Modell laden'}</b><small>Empfehlungen für deinen Mac</small></div>${ic('chevRight', 16)}</a>`;
    slot.appendChild(menu);
    fitMenuUp(menu, slot);
    $$('[data-model]', menu).forEach(b => (b.onclick = () => {
      store.set(code ? 'codeModel' : 'model', b.dataset.model);
      closeMenus();
      mountModelPicker(code);
      state.chat?.applyCaps();
    }));
  };
}

// Composer options live behind one button, so the bar stays calm.
// A dot on the button shows that something differs from its default,
// unless the option already shows itself in the bar (`shown`).
const thinkOption = key => ({ key, def: true, icon: 'bulb', title: 'Nachdenken', desc: 'Besser, aber langsamer' });

function composerOptions(slot, options, onChange) {
  slot.innerHTML = `<button type="button" class="tool round opts-btn" title="Optionen" aria-label="Optionen" aria-haspopup="true">${ic('settings', 17)}</button>`;
  const btn = $('.opts-btn', slot);
  const find = key => options.find(o => o.key === key);
  const stored = o => store.get(o.key, o.def);
  const refresh = () => {
    btn.hidden = options.every(o => o.hidden);
    btn.classList.toggle('changed', options.some(o => !o.hidden && !o.shown && stored(o) !== o.def));
    onChange?.();
  };
  btn.onclick = () => {
    if ($('.menu', slot)) return closeMenus();
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'menu up opts-menu';
    menu.innerHTML = options.filter(o => !o.hidden).map(o => `
      <button type="button" class="menu-item" role="switch" aria-checked="${stored(o)}" data-opt="${o.key}">
        ${ic(o.icon, 17)}
        <div class="grow"><b>${o.title}</b><small>${o.desc}</small></div>
        <span class="switch"></span></button>`).join('');
    slot.appendChild(menu);
    fitMenuUp(menu, slot);
    $$('[data-opt]', menu).forEach(b => (b.onclick = () => {
      const o = find(b.dataset.opt);
      store.set(o.key, !stored(o));
      b.setAttribute('aria-checked', stored(o));
      refresh();
    }));
  };
  refresh();
  return {
    on: key => !find(key).hidden && stored(find(key)),
    hide(key, hidden) { find(key).hidden = hidden; refresh(); },
    refresh,
  };
}

function createChat(saved) {
  const chat = saved
    ? { ...saved, messages: saved.messages.map(m => ({ ...m })) }
    : { id: crypto.randomUUID(), title: '', created: Date.now(), messages: [], article: null };
  const root = document.createElement('div');
  root.className = 'chat';
  root.innerHTML = `
    <div class="thread"><div class="thread-inner"></div></div>
    <div class="composer-wrap">
      <form class="composer">
        <div class="attachments"></div>
        <textarea rows="1" placeholder="Was willst du wissen?" aria-label="Nachricht"></textarea>
        <div class="cbar">
          <button type="button" class="tool round" data-a="attach" title="Bild anhängen">${ic('clip', 17)}</button>
          <div class="picker opts-slot"></div>
          <span class="spacer"></span>
          <div class="picker model-slot"></div>
          <button class="send" type="submit" disabled title="Senden">${ic('arrowUp', 18, 2.2)}</button>
        </div>
        <input type="file" accept="image/*" multiple hidden>
      </form>
      <div class="disclaimer">Läuft komplett offline. Die KI kann sich irren, prüf Wichtiges in den Quellen.</div>
    </div>
    <div class="starters"></div>`;

  const inner = $('.thread-inner', root);
  const thread = $('.thread', root);
  const ta = $('textarea', root);
  const form = $('form', root);
  const sendBtn = $('.send', root);
  const attachments = $('.attachments', root);
  const fileInput = $('input[type=file]', root);
  let images = [];
  let ctrl = null;

  const opts = composerOptions($('.opts-slot', root), [
    { key: 'kb', def: true, icon: 'book', title: 'Bibliothek', desc: 'Antworten mit Quellen aus deiner Bibliothek' },
    thinkOption('think'),
  ]);
  $('[data-a=attach]', root).onclick = () => fileInput.click();

  function applyCaps() {
    const caps = chatModels().find(m => m.name === currentModel())?.caps || [];
    opts.hide('think', !caps.includes('thinking'));
    $('[data-a=attach]', root).hidden = !caps.includes('vision');
  }

  // ---- composer
  const canSend = () => (ta.value.trim().length > 0 || ctrl) && !!currentModel();
  const autosize = () => {
    sendBtn.disabled = !canSend();
    if (!ta.isConnected) return; // not mounted yet, height would be 0
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  };
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    if (ctrl) return ctrl.abort();
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    autosize();
    send(text);
  });
  fileInput.onchange = async () => {
    for (const f of fileInput.files) {
      images.push(await new Promise(res => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.readAsDataURL(f);
      }));
    }
    fileInput.value = '';
    renderAttachments();
  };

  function renderAttachments() {
    const art = chat.article;
    attachments.innerHTML =
      (art ? `<div class="att-card">${srcIco(art.book, bookById(art.book)?.title, 'md')}
        <div class="meta"><b>${esc(art.title)}</b><small>Artikel · ${esc(bookById(art.book)?.title || art.book)}</small></div>
        <button type="button" class="x" data-x="art" title="Entfernen">${ic('x', 15)}</button></div>` : '') +
      images.map((src, i) => `<div class="att-img"><img src="${src}" alt=""><button type="button" class="x" data-x="${i}">${ic('x', 12, 2.4)}</button></div>`).join('');
    $$('[data-x]', attachments).forEach(b => (b.onclick = () => {
      if (b.dataset.x === 'art') chat.article = null;
      else images.splice(+b.dataset.x, 1);
      renderAttachments();
    }));
    opts.hide('kb', !!art); // with an article attached only that article is used
  }

  function attachArticle(a) {
    chat.article = a;
    renderAttachments();
    ta.placeholder = 'Frag zu diesem Artikel …';
    ta.focus();
  }

  // ---- rendering
  function renderEmpty() {
    const empty = !chat.messages.length;
    root.classList.toggle('empty', empty);
    const starters = $('.starters', root);
    if (!empty) {
      starters.innerHTML = '';
      return;
    }
    const st = state.status;
    const total = state.books.reduce((n, b) => n + b.articles, 0);
    const warn = !state.books.length
      ? `<p>Noch keine Inhalte. <a href="#/settings?tab=content" style="text-decoration:underline">Wissen laden</a></p>`
      : st && !st.ollama
        ? '<p>Die KI ist aus. Starte sie mit <code class="path">./basecamp start</code>. Suchen geht trotzdem mit ⌘K.</p>'
        : `<p>${state.books.length} Quellen · ${fmtNum(total)} Artikel · alles offline</p>`;
    inner.innerHTML = `<div class="hero">${wordmark()}${warn}</div>`;
    const top = ['wikipedia_de_all_maxi', 'wikipedia_de_all_nopic', 'wikipedia_de_all_mini', 'wikipedia_en_medicine_maxi', 'ifixit_de_all']
      .map(bookById).filter(Boolean).slice(0, 3);
    starters.innerHTML =
      STARTERS.slice(0, state.books.length ? 3 : 4).map(s => `<button class="starter" data-q="${esc(s)}">${esc(s)}</button>`).join('') +
      top.map(b => `<a class="starter" href="${readHref(b.id, b.main)}">${srcIco(b.id, b.title)}${esc(b.title)}</a>`).join('');
    $$('[data-q]', starters).forEach(b => (b.onclick = () => send(b.dataset.q)));
  }

  function userEl(m) {
    const el = document.createElement('div');
    el.className = 'turn user';
    el.innerHTML = `${m.images?.length ? `<div class="att">${m.images.map(s => `<img src="${s}" alt="">`).join('')}</div>` : ''}
      <div class="bubble">${m.hadImage ? '<span class="faint">[Bild] </span>' : ''}${esc(m.content)}</div>`;
    return el;
  }

  function botEl(m) {
    const el = document.createElement('div');
    el.className = 'turn bot';
    m._el = el;
    paintBot(m, false);
    return el;
  }

  function paintBot(m, streaming) {
    const el = m._el;
    const src = m.sources || [];
    let html = '';
    if (m.status && !m.content && !m.thinking && !m.error) {
      html += `<div class="step">${shimmer(esc(m.status))}${since(m.statusSince || Date.now())}</div>`;
      if (m.statusLoad) html += '<div class="step-hint">Passiert einmal nach dem Start. Danach antwortet es sofort.</div>';
    } else if (m.mode === 'knowledge' && m.queries) {
      html += `<div class="step"><button data-act="q">${ic('search', 15)}<span>${src.length ? `${src.length} Quellen gelesen` : 'Keine passende Quelle gefunden'}</span>${ic(m._q ? 'chevDown' : 'chevRight', 14)}</button></div>`;
      if (m._q) {
        const qs = [...new Set(Object.values(m.queries).flat())];
        html += `<div class="queries">Gesucht: ${qs.map(q => `<span>${esc(q)}</span>`).join('')}</div>`;
      }
    }
    if (m.thinking) html += thoughtHtml(m, streaming && !m.content);
    if (src.length) {
      html += `<div class="sources">${src.map(s => `
        <a class="src-chip" data-n="${s.n}" href="${readHref(s.book, s.path)}" title="${esc(s.title)} · ${esc(s.source)}">
          ${srcIco(s.book, s.source)}<span class="t">${esc(s.title)}</span><span class="n">${s.n}</span></a>`).join('')}</div>`;
    }
    html += `<div class="md ${streaming && m.content ? 'caret' : ''}">${md(m.content || '')}</div>`;
    if (m.error) html += `<div class="err">${esc(m.error)}</div>`;
    if (!streaming && (m.content || m.error)) {
      const s = m.stats;
      html += `<div class="actions">
        <button class="icon-btn" data-act="copy" title="Kopieren">${ic('copy', 16)}</button>
        <button class="icon-btn" data-act="retry" title="Nochmal">${ic('refresh', 16)}</button>
        ${s ? `<span class="stats">${esc(modelMeta(s.model)?.title || s.model)} · ${s.tps} Token/s · ${s.seconds} s</span>` : ''}</div>`;
    }
    el.innerHTML = html;
    const caret = $('.md.caret', el);
    if (caret) {
      // put the blinking dot after the last text, not on its own line
      const last = caret.lastElementChild;
      if (last) { last.classList.add('caret'); caret.classList.remove('caret'); }
    }
    const openSrc = n => {
      const s = src.find(x => x.n === +n);
      if (s) openArticle(s.book, s.path);
    };
    $$('.cite', el).forEach(a => {
      const s = src.find(x => x.n === +a.dataset.n);
      if (s) a.title = `${s.title} · ${s.source}`;
      a.onclick = e => { e.preventDefault(); openSrc(a.dataset.n); };
    });
    $$('.src-chip', el).forEach(a => (a.onclick = e => { e.preventDefault(); openSrc(a.dataset.n); }));
    const det = $('details.thought', el);
    if (det) det.ontoggle = () => (m._open = det.open);
    const q = $('[data-act=q]', el);
    if (q) q.onclick = () => { m._q = !m._q; paintBot(m, streaming); };
    const cp = $('[data-act=copy]', el);
    if (cp) cp.onclick = () => copyText(m.content);
    const rt = $('[data-act=retry]', el);
    if (rt) rt.onclick = retry;
    $$('.turn.bot', inner).forEach(t => t.classList.toggle('last', t === inner.lastElementChild));
  }

  function renderAll() {
    renderEmpty();
    if (!chat.messages.length) return;
    inner.innerHTML = '';
    chat.messages.forEach(m => inner.appendChild(m.role === 'user' ? userEl(m) : botEl(m)));
    $$('.turn.bot', inner).forEach(t => t.classList.toggle('last', t === inner.lastElementChild));
    requestAnimationFrame(() => (thread.scrollTop = thread.scrollHeight));
  }

  function retry() {
    if (ctrl) return;
    const lastUser = [...chat.messages].reverse().find(m => m.role === 'user');
    if (!lastUser) return;
    while (chat.messages.length && chat.messages[chat.messages.length - 1] !== lastUser) chat.messages.pop();
    chat.messages.pop();
    renderAll();
    send(lastUser.content, lastUser.images);
  }

  // ---- sending
  async function send(text, reuseImages) {
    if (!state.models) await loadModels();
    const model = currentModel();
    if (!model) {
      location.hash = '#/settings?tab=models';
      return;
    }
    const first = !chat.messages.length;
    if (first) inner.innerHTML = '';
    const imgs = reuseImages || images;
    const user = { role: 'user', content: text, ...(imgs.length ? { images: [...imgs] } : {}) };
    images = [];
    renderAttachments();
    chat.messages.push(user);
    renderEmpty();
    inner.appendChild(userEl(user));
    const mode = chat.article ? 'article' : opts.on('kb') && state.books.length ? 'knowledge' : 'plain';
    const bot = { role: 'assistant', content: '', thinking: '', sources: [], status: 'Einen Moment …', statusSince: Date.now(), mode };
    chat.messages.push(bot);
    inner.appendChild(botEl(bot));
    paintBot(bot, true);
    thread.scrollTop = thread.scrollHeight;
    if (!chat.title) chat.title = text.slice(0, 70);
    Chats.save(chat);
    if (first) {
      history.replaceState(null, '', '#/c/' + chat.id);
      state.view = 'c';
    }
    renderChatList();
    live.set(chat.id, api_);

    const payload = {
      model,
      mode,
      article: chat.article ? { book: chat.article.book, path: chat.article.path } : null,
      think: opts.on('think'),
      messages: chat.messages.slice(0, -1).map(m => ({
        role: m.role,
        content: m.content,
        ...(m === user && imgs.length ? { images: imgs.map(d => d.split(',')[1]) } : {}),
      })),
    };
    ctrl = new AbortController();
    sendBtn.innerHTML = ic('stop', 18);
    sendBtn.disabled = false;
    sendBtn.title = 'Stoppen';

    let frame = 0;
    const repaint = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
        paintBot(bot, true);
        if (stick) thread.scrollTop = thread.scrollHeight;
      });
    };
    let t0 = 0;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.t === 'status') {
            if (ev.c !== bot.status) bot.statusSince = Date.now();
            bot.status = ev.c;
            bot.statusLoad = !!ev.load;
          }
          else if (ev.t === 'queries') bot.queries = ev.c;
          else if (ev.t === 'sources') bot.sources = ev.c;
          else if (ev.t === 'think') {
            if (!t0) t0 = bot.thinkStart = Date.now();
            bot.thinking += ev.c;
          } else if (ev.t === 'tok') {
            if (t0 && !bot.thinkSecs) bot.thinkSecs = Math.max(1, Math.round((Date.now() - t0) / 1000));
            bot.content += ev.c;
          } else if (ev.t === 'error') bot.error = ev.c;
          else if (ev.t === 'done') bot.stats = ev.c;
          repaint();
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') bot.error = 'Verbindung unterbrochen: ' + e.message;
      else if (!bot.content) bot.error = 'Gestoppt.';
    }
    if (frame) cancelAnimationFrame(frame);
    ctrl = null;
    delete bot.status;
    sendBtn.innerHTML = ic('arrowUp', 18, 2.2);
    sendBtn.title = 'Senden';
    autosize();
    paintBot(bot, false);
    if (!deleted.has(chat.id)) Chats.save(chat);
    live.delete(chat.id);
    if (state.chat === api_) renderChatList();
  }

  const api_ = {
    root,
    chat,
    send,
    applyCaps,
    attachArticle,
    stop: () => ctrl?.abort(),
    focus: () => setTimeout(() => { autosize(); ta.focus(); }, 0),
    streaming: () => !!ctrl,
  };
  renderAll();
  renderAttachments();
  applyCaps();
  autosize();
  return api_;
}

async function showChat(id, q, articleParam) {
  if (!state.books.length) await loadBooks();
  if (!state.status) state.status = await api.get('status').catch(() => null);
  let c = id && live.get(id);
  if (!c) {
    const saved = id ? Chats.get(id) : null;
    if (id && !saved) {
      location.hash = '#/';
      return;
    }
    c = createChat(saved);
  }
  state.chat = c;
  view.replaceChildren(c.root);
  renderChatList();
  await mountModelPicker();
  c.applyCaps();
  if (pendingArticle) {
    c.attachArticle(pendingArticle);
    if (!panel.book && innerWidth > 900) openPanel(pendingArticle.book, pendingArticle.path);
    pendingArticle = null;
  }
  if (q) {
    history.replaceState(null, '', '#/');
    c.send(q);
  } else c.focus();
}

/* ================================================================ library */

async function showLibrary() {
  await loadBooks();
  const [files, maps] = await Promise.all([api.get('files').then(r => r.files), api.get('maps').then(r => r.maps)]);
  const cat = store.get('libCat', 'all');
  const present = state.categories.filter(c => state.books.some(b => b.category === c.id));
  const total = state.books.reduce((n, b) => n + b.articles, 0);
  const card = b => `
    <a class="lib-card" href="${readHref(b.id, b.main)}">
      ${srcIco(b.id, b.title, 'lg')}
      <div class="grow"><b>${esc(b.title)}</b><p>${esc(b.description)}</p>
        <div class="meta"><span>${fmtNum(b.articles)} Artikel</span><span class="pill">${esc(b.lang)}</span></div></div>
    </a>`;
  const sections = (cat === 'all' ? present : present.filter(c => c.id === cat)).map(c => `
    ${cat === 'all' ? `<div class="section-h"><h2>${esc(c.title)}</h2><span>${state.books.filter(b => b.category === c.id).length}</span></div>` : ''}
    <div class="lib-grid">${state.books.filter(b => b.category === c.id).map(card).join('')}</div>`).join('');
  const others = state.books.filter(b => !state.categories.some(c => c.id === b.category));
  const recent = store.get('recent', []).filter(r => bookById(r.book) && r.path !== bookById(r.book).main).slice(0, 6);

  view.innerHTML = `<div class="page"><div class="page-inner">
    <div class="page-head">
      <div><h1>Bibliothek</h1><p>${state.books.length} Quellen · ${fmtNum(total)} Artikel · ${files.length} eigene Dateien</p></div>
      <span class="spacer"></span>
      <button class="btn" id="libSearch">${ic('search', 16)} Durchsuchen <kbd>⌘K</kbd></button>
      ${state.books.length ? `<button class="btn" id="libRandom">${ic('dice', 16)} Zufall</button>` : ''}
    </div>
    ${state.books.length ? `
      <div class="filters">
        <button class="filter ${cat === 'all' ? 'on' : ''}" data-cat="all">Alle</button>
        ${present.map(c => `<button class="filter ${cat === c.id ? 'on' : ''}" data-cat="${c.id}">${esc(c.title)}</button>`).join('')}
      </div>
      ${recent.length && cat === 'all' ? `<div class="section-h"><h2>Weiterlesen</h2></div>
        <div class="recent-grid">${recent.map(r => `<a class="recent" href="${readHref(r.book, r.path)}">${srcIco(r.book, bookById(r.book).title)}
          <span class="grow"><b>${esc(r.title)}</b><small>${esc(bookById(r.book).title)}</small></span></a>`).join('')}</div>` : ''}
      ${sections}
      ${others.length && cat === 'all' ? `<div class="section-h"><h2>Sonstiges</h2></div><div class="lib-grid">${others.map(card).join('')}</div>` : ''}`
    : `<div class="empty-state"><h3>Noch keine Inhalte</h3><p>Lade Wikipedia, iFixit und mehr. Einmal laden, danach geht alles ohne Internet.</p>
        <a class="btn primary" href="#/settings?tab=content">Inhalte laden</a></div>`}
    ${maps.length && cat === 'all' ? `<div class="section-h"><h2>Karten</h2><span>${maps.length}</span></div>
      <div class="lib-grid">${maps.map(m => `<a class="lib-card" href="#/map"><span class="src-ico lg map-ico">${ic('map', 22)}</span>
        <div class="grow"><b>${esc(m.title)}</b><p>Offline-Karte mit Ortssuche</p><div class="meta"><span>${fmtSize(m.size)}</span><span class="pill">OSM</span></div></div></a>`).join('')}</div>` : ''}
    <div class="section-h"><h2>Eigene Dateien</h2><span>PDFs, E-Books, Handbücher</span></div>
    ${files.length ? `<div class="files">${files.map(fileRow).join('')}</div>` : `
      <p class="muted sm">Leg eigene Dateien in <code class="path">data/library</code>. Sie erscheinen dann hier und in der Suche.</p>`}
  </div></div>`;
  $('#libSearch').onclick = () => openPalette();
  $('#libRandom')?.addEventListener('click', async () => {
    const r = await api.get('random');
    if (r.book) location.hash = readHref(r.book, r.path);
  });
  $$('[data-cat]').forEach(b => (b.onclick = () => { store.set('libCat', b.dataset.cat); showLibrary(); }));
}

function fileRow(f) {
  const inline = ['pdf', 'txt', 'md', 'html', 'htm', 'jpg', 'jpeg', 'png', 'mp4', 'mp3', 'm4a'].includes(f.ext);
  return `<a class="file" href="${fileSrc(f.path)}" target="_blank" rel="noopener" ${inline ? '' : 'download'}>
    <span class="ext">${esc(f.ext)}</span>
    <span class="grow"><b>${esc(f.name)}</b><small>${f.folder ? esc(f.folder) + ' · ' : ''}${fmtSize(f.size)}</small></span></a>`;
}

/* ================================================================ settings */

async function showSettings(tab) {
  if (panel.book) closePanel();
  view.innerHTML = `<div class="page"><div class="page-inner narrow">
    <div class="page-head"><div><h1>Einstellungen</h1></div></div>
    <div class="seg">
      <a href="#/settings?tab=content" class="${tab === 'content' ? 'on' : ''}">Inhalte</a>
      <a href="#/settings?tab=models" class="${tab === 'models' ? 'on' : ''}">KI-Modelle</a>
      <a href="#/settings?tab=system" class="${tab === 'system' ? 'on' : ''}">System</a>
    </div>
    <div id="tasksBox"></div>
    <div id="tabBody"><p class="faint">Lade …</p></div>
  </div></div>`;
  renderTasks();
  const body = $('#tabBody');
  if (tab === 'models') return renderModels(body);
  if (tab === 'system') return renderSystem(body);
  return renderContent(body);
}

function confirmClick(btn, fn) {
  btn.addEventListener('click', () => {
    if (btn.dataset.armed) return fn();
    const label = btn.innerHTML;
    btn.dataset.armed = '1';
    btn.textContent = 'Sicher?';
    setTimeout(() => {
      delete btn.dataset.armed;
      btn.innerHTML = label;
    }, 3000);
  });
}

const activeTask = (kind, ref) => state.tasks.find(t => (t.kind === kind || (kind === 'zim' && t.kind === 'map')) && t.ref === ref && ['queued', 'running'].includes(t.status));

async function renderContent(el) {
  const c = await api.get('catalog');
  if (!$('#tabBody') || el !== $('#tabBody')) return;
  const lang = store.get('langFilter', 'all');
  const onlyInstalled = store.get('onlyInstalled', false);
  const used = c.items.reduce((n, i) => n + (i.installed_size || 0), 0) + c.extra.reduce((n, b) => n + b.size, 0);
  const usedGb = used / 1e9;
  const otherGb = Math.max(c.disk_total_gb - c.disk_free_gb - usedGb, 0);
  const total = c.disk_total_gb || 1;

  const status = it => {
    const t = activeTask('zim', it.id);
    if (t) return `<span class="pill amber" data-task="${t.id}">${t.status === 'queued' ? 'Wartet' : pct(t) + ' %'}</span>`;
    if (it.covered) return '<span class="pill">In größerer Karte</span>';
    if (it.installed) {
      const upd = it.latest && it.latest > it.installed;
      return upd ? `<button class="btn sm" data-update="${esc(it.id)}">${ic('download', 14)} Update</button>`
        : `<span class="pill ok">${ic('check', 12, 2.6)}&nbsp;Installiert</span>`;
    }
    return '';
  };
  const action = it => (it.covered ? '' : it.installed
    ? `<button class="icon-btn" data-delete="${esc(it.id)}" title="Löschen">${ic('trash', 16)}</button>`
    : activeTask('zim', it.id) ? `<button class="icon-btn" data-cancelref="${esc(it.id)}" title="Abbrechen">${ic('x', 16)}</button>`
      : `<button class="btn sm" data-get="${esc(it.id)}">${ic('download', 14)} Laden</button>`);
  const items = c.items.filter(i => (lang === 'all' || i.lang === lang) && (!onlyInstalled || i.installed));

  el.innerHTML = `
    <div class="group storage">
      <div style="display:flex;align-items:baseline;gap:10px"><b>Speicher</b><span class="faint sm">${fmtGb(c.disk_free_gb)} frei von ${fmtGb(c.disk_total_gb)}</span></div>
      <div class="bar"><div class="used" style="width:${(usedGb / total) * 100}%"></div><div class="other" style="width:${(otherGb / total) * 100}%"></div></div>
      <div class="legend"><span><i style="background:var(--text)"></i>Basecamp ${fmtSize(used)}</span><span><i style="background:color-mix(in srgb, var(--text) 25%, transparent)"></i>Andere ${fmtGb(otherGb)}</span><span><i style="background:var(--surface-3)"></i>Frei ${fmtGb(c.disk_free_gb)}</span></div>
    </div>

    <div class="group-title">Pakete <span>Deutsch zuerst. Englisch nur als Ergänzung.</span></div>
    <div class="plans">${c.profiles.map(p => {
      const rec = p.id === c.recommended_profile;
      const done = p.missing_gb <= 0;
      return `<div class="plan ${rec ? 'rec' : ''}">
        <div class="name">${esc(p.title)}${rec ? '<span class="pill">Empfohlen</span>' : ''}</div>
        <div class="gb">${fmtGb(p.gb)}</div>
        <p>${esc(p.desc)}</p>
        ${done ? `<button class="btn" disabled>${ic('check', 14)} Komplett</button>`
          : `<button class="btn ${rec ? 'primary' : ''}" data-profile="${p.id}" ${p.fits ? '' : 'disabled title="Nicht genug Speicher"'}>
              ${p.missing_gb < p.gb ? `Rest laden · ${fmtGb(p.missing_gb)}` : 'Laden'}</button>`}
      </div>`;
    }).join('')}</div>

    <div style="display:flex;align-items:center;gap:8px;margin:0 0 10px">
      <div class="group-title" style="margin:0">Einzelne Quellen</div>
      <span class="spacer"></span>
      <select class="select" id="lang"><option value="all">Alle Sprachen</option><option value="de">Deutsch</option><option value="en">Englisch</option></select>
      <button class="filter ${onlyInstalled ? 'on' : ''}" id="only">Installiert</button>
      <button class="btn sm ghost" id="refresh" title="Prüft bei Kiwix, ob es neuere Versionen gibt">${ic('refresh', 14)} ${c.checked ? 'Erneut prüfen' : 'Updates prüfen'}</button>
    </div>
    ${c.categories.map(cat => {
      const rows = items.filter(i => i.cat === cat.id);
      if (!rows.length) return '';
      return `<div class="group-title" style="margin-top:18px">${esc(cat.title)}</div><div class="group">${rows.map(it => `
        <div class="row">
          <div class="grow"><b>${esc(it.title)}</b> ${it.kind === 'map' ? '' : `<span class="pill">${esc(it.lang)}</span>`}<small>${esc(it.desc)}</small></div>
          <span class="size">${fmtGb(it.gb)}</span>
          <div class="acts" data-status="${esc(it.id)}">${status(it)}${action(it)}</div>
        </div>`).join('')}</div>`;
    }).join('')}
    ${c.extra.length ? `<div class="group-title" style="margin-top:18px">Eigene ZIM-Dateien</div><div class="group">${c.extra.map(b => `
      <div class="row"><div class="grow"><b>${esc(b.title)}</b> <span class="pill">${esc(b.lang)}</span><small>${esc(b.description)}</small></div>
        <span class="size">${fmtSize(b.size)}</span>
        <div class="acts"><button class="icon-btn" data-delete="${esc(b.id)}" title="Löschen">${ic('trash', 16)}</button></div></div>`).join('')}</div>` : ''}
    <p class="faint sm" style="margin-top:18px">Ordner: <code class="path">${esc(c.zim_dir)}</code>. Eigene .zim-Dateien einfach hineinlegen.</p>`;

  const rerender = () => renderContent(el);
  $('#lang').value = lang;
  $('#lang').onchange = e => { store.set('langFilter', e.target.value); rerender(); };
  $('#only').onclick = () => { store.set('onlyInstalled', !onlyInstalled); rerender(); };
  $('#refresh').onclick = async e => {
    e.currentTarget.disabled = true;
    const r = await api.post('catalog/refresh');
    toast(r.ok ? 'Katalog aktualisiert' : 'Keine Verbindung zu Kiwix');
    rerender();
  };
  const after = async () => { await pollTasks(); rerender(); };
  $$('[data-profile]', el).forEach(b => (b.onclick = async () => { b.disabled = true; await api.post('content/download', { profile: b.dataset.profile }); toast('Download gestartet'); after(); }));
  $$('[data-get]', el).forEach(b => (b.onclick = async () => { b.disabled = true; await api.post('content/download', { ids: [b.dataset.get] }); after(); }));
  $$('[data-update]', el).forEach(b => (b.onclick = async () => { b.disabled = true; await api.post('content/download', { ids: [b.dataset.update], update: true }); after(); }));
  $$('[data-cancelref]', el).forEach(b => (b.onclick = async () => { const t = activeTask('zim', b.dataset.cancelref); if (t) await api.post('tasks/cancel', { id: t.id }); after(); }));
  $$('[data-delete]', el).forEach(b => confirmClick(b, async () => { await api.post('content/delete', { id: b.dataset.delete }); state.books = []; toast('Gelöscht'); rerender(); }));
}

function renderTasks() {
  const box = $('#tasksBox');
  if (!box) return;
  const shown = state.tasks.filter(t => ['queued', 'running', 'error'].includes(t.status));
  if (!shown.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `<div class="group-title">Downloads <span>laufen im Hintergrund weiter</span></div>
    <div class="group">${shown.map(t => `
      <div class="row">
        <div class="grow"><b>${esc(modelMeta(t.ref)?.title || t.title)}</b>
          <small>${t.status === 'error' ? `<span style="color:var(--danger)">${esc(t.error)}</span>`
            : t.status === 'queued' ? 'Wartet …'
            : `${fmtSize(t.done)} von ${fmtSize(t.total)}${t.speed ? ' · ' + fmtSize(t.speed) + '/s' : ''}`}</small>
          ${t.status === 'running' ? `<div class="progress"><div style="width:${t.total ? (t.done / t.total) * 100 : 2}%"></div></div>` : ''}</div>
        <span class="size">${t.status === 'running' ? pct(t) + ' %' : ''}</span>
        <div class="acts"><button class="icon-btn" data-cancel="${t.id}" title="${t.status === 'error' ? 'Ausblenden' : 'Abbrechen'}">${ic('x', 16)}</button></div>
      </div>`).join('')}</div>`;
  $$('[data-cancel]', box).forEach(b => (b.onclick = async () => {
    const t = state.tasks.find(x => x.id === b.dataset.cancel);
    await api.post(t?.status === 'error' ? 'tasks/clear' : 'tasks/cancel', { id: b.dataset.cancel });
    pollTasks();
  }));
}

async function renderModels(el) {
  const m = await loadModels();
  const st = await api.get('status');
  if (!$('#tabBody') || el !== $('#tabBody')) return;
  const cur = currentModel();
  const rec = m.tier.recommended.map(n => m.catalog.find(x => x.name === n)).filter(Boolean);
  const others = m.catalog.filter(x => !m.tier.recommended.includes(x.name) && !m.tier.code.includes(x.name) && !x.installed);
  const capName = { vision: 'Bilder', thinking: 'Denken', tools: 'Werkzeuge', embedding: 'Embedding' };
  const action = x => {
    const t = activeTask('model', x.name);
    if (t) return `<span class="pill amber">${t.status === 'queued' ? 'Wartet' : pct(t) + ' %'}</span>`;
    if (x.installed) return x.name === cur ? `<span class="pill ok">${ic('check', 12, 2.6)}&nbsp;Aktiv</span>` : `<button class="btn sm" data-use="${esc(x.name)}">Verwenden</button>`;
    if (!x.fits) return `<span class="faint sm">ab ${x.min_ram} GB RAM</span>`;
    return `<button class="btn sm ${x.tier_default ? 'primary' : ''}" data-pull="${esc(x.name)}" ${m.ollama ? '' : 'disabled'}>${ic('download', 14)} Laden</button>`;
  };
  const row = x => `
    <div class="row">
      <div class="grow"><b>${esc(x.title)}</b> ${x.tier_default ? '<span class="pill">Empfohlen</span>' : ''}<small>${esc(x.desc)} · <code class="path">${esc(x.name)}</code></small></div>
      <span class="size">${fmtGb(x.gb)}</span>
      <div class="acts">${action(x)}</div>
    </div>`;
  el.innerHTML = `
    <div class="group hwcard">
      <div class="chip">${ic('cpu', 24, 1.6)}</div>
      <div class="grow" style="flex:1"><b>${esc(st.chip)} · ${st.ram_gb} GB RAM</b><small class="faint" style="display:block">Stufe „${esc(m.tier.label)}“ · Kontext ${fmtNum(st.num_ctx)} Token</small></div>
      ${m.ollama ? '<span class="pill ok">Ollama läuft</span>' : '<span class="pill" style="color:var(--danger)">Ollama aus</span>'}
    </div>
    <div class="group-title">Empfohlen für deinen Mac <span>Laden braucht einmal Internet</span></div>
    <div class="group">${rec.map(row).join('')}</div>
    <div class="group-title">Für Basecamp Code <span>Modelle mit Werkzeugen, zum Programmieren</span></div>
    <div class="group">${m.tier.code.map(n => m.catalog.find(x => x.name === n)).filter(Boolean).map(row).join('')}</div>
    <div class="group-title">Installiert</div>
    <div class="group">${m.installed.length ? m.installed.map(x => {
      const meta = modelMeta(x.name);
      return `<div class="row">
        <div class="grow"><b>${esc(meta?.title || x.name)}</b><small>${esc([x.params, x.quant].filter(Boolean).join(' · '))}${(x.caps || []).filter(c => capName[c]).length ? ' · ' + (x.caps || []).filter(c => capName[c]).map(c => capName[c]).join(', ') : ''} · <code class="path">${esc(x.name)}</code></small></div>
        <span class="size">${fmtSize(x.size)}</span>
        <div class="acts">${x.name === cur ? `<span class="pill ok">${ic('check', 12, 2.6)}&nbsp;Aktiv</span>` : `<button class="btn sm" data-use="${esc(x.name)}">Verwenden</button>`}
          <button class="icon-btn" data-del="${esc(x.name)}" title="Löschen">${ic('trash', 16)}</button></div>
      </div>`;
    }).join('') : '<div class="row"><small>Noch keine Modelle installiert.</small></div>'}</div>
    <div class="group-title">Weitere Modelle</div>
    <div class="group">${others.map(row).join('')}</div>
    <div class="group-title">Anderes Modell <span>jeder Name aus der Ollama-Bibliothek</span></div>
    <div class="group"><form class="custom" id="custom"><input name="name" placeholder="z. B. llama3.3:70b" autocomplete="off"><button class="btn">Laden</button></form></div>`;

  const refresh = async () => { await pollTasks(); renderModels(el); };
  $$('[data-pull]', el).forEach(b => (b.onclick = async () => { b.disabled = true; await api.post('models/pull', { name: b.dataset.pull }); toast('Download gestartet'); refresh(); }));
  $$('[data-use]', el).forEach(b => (b.onclick = async () => {
    store.set('model', b.dataset.use);
    await api.post('settings', { default_model: b.dataset.use });
    toast('Modell gewechselt');
    renderModels(el);
  }));
  $$('[data-del]', el).forEach(b => confirmClick(b, async () => { await api.post('models/delete', { name: b.dataset.del }); toast('Gelöscht'); renderModels(el); }));
  $('#custom').onsubmit = async e => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (name) { await api.post('models/pull', { name }); refresh(); }
  };
}

async function renderSystem(el) {
  const st = await api.get('status');
  const files = await api.get('files');
  if (!$('#tabBody') || el !== $('#tabBody')) return;
  const kv = (k, v) => `<div class="row"><div class="grow"><b>${k}</b></div><span class="muted sm" style="text-align:right">${v}</span></div>`;
  el.innerHTML = `
    <div class="group">
      ${kv('Mac', `${esc(st.chip)} · ${st.ram_gb} GB RAM`)}
      ${kv('KI', st.ollama ? `Ollama läuft · ${esc(modelMeta(st.model)?.title || st.model)}` : 'Ollama aus')}
      ${kv('Quellen', `${st.books} Quellen · ${st.files} eigene Dateien`)}
      ${kv('Speicher', `${fmtGb(st.disk_free_gb)} frei`)}
      ${kv('Daten', `<code class="path">${esc(st.data_dir)}</code>`)}
    </div>
    <div class="group-title">Eigene Dateien</div>
    <div class="group"><div class="row">${ic('folder', 20)}<div class="grow"><b>PDFs, E-Books, Handbücher</b>
      <small>Leg Dateien in diesen Ordner. Unterordner sind erlaubt.</small><small><code class="path">${esc(files.dir)}</code></small></div></div></div>
    <div class="group-title">Handy und Tablet</div>
    <div class="group"><div class="row">${ic('wifi', 20)}<div class="grow">${st.lan
      ? `<b>Im WLAN erreichbar</b>${st.urls.map(u => `<small><code class="path">${esc(u)}</code></small>`).join('')}`
      : `<b>Nur auf diesem Mac</b><small>Starte mit <code class="path">./basecamp start --lan</code>, dann können alle Geräte im WLAN Basecamp nutzen.</small>`}</div></div></div>
    <div class="group-title">Befehle im Terminal</div>
    <div class="group">
      ${kv('<code class="path">./basecamp start</code>', 'Startet KI und Basecamp')}
      ${kv('<code class="path">./basecamp stop</code>', 'Stoppt alles')}
      ${kv('<code class="path">./basecamp status</code>', 'Zeigt den Zustand')}
      ${kv('<code class="path">./basecamp update</code>', 'Lädt neue Versionen der Inhalte')}
      ${kv('<code class="path">./basecamp code</code>', 'Claude Code mit lokalem Modell im Terminal')}
      ${kv('<code class="path">./basecamp code opencode</code>', 'Oder OpenCode, Codex, Qwen Code')}
      ${kv('<code class="path">./basecamp autostart on</code>', 'Startet beim Anmelden')}
    </div>`;
}

/* ================================================================ maps */

let mapLib = null;
const loadScript = src => new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = src;
  s.onload = res;
  s.onerror = () => rej(new Error('Konnte ' + src + ' nicht laden'));
  document.head.appendChild(s);
});

async function loadMapLib() {
  if (mapLib) return mapLib;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/static/vendor/maplibre-gl.css';
  document.head.appendChild(css);
  const [ml] = await Promise.all([
    import('/static/vendor/maplibre-gl.mjs'),
    loadScript('/static/vendor/pmtiles.js'),
    loadScript('/static/vendor/basemaps.js'),
  ]);
  ml.addProtocol('pmtiles', new pmtiles.Protocol().tile);
  mapLib = ml;
  return ml;
}

const countryName = cc => {
  try {
    return new Intl.DisplayNames(['de'], { type: 'region' }).of(cc) || cc;
  } catch {
    return cc;
  }
};
const schemeMQ = matchMedia('(prefers-color-scheme: dark)');
const darkMode = () => schemeMQ.matches;
schemeMQ.addEventListener('change', () => mapState.map?.setStyle(mapStyle(mapState.maps, schemeMQ.matches)));

/** World overview below zoom 6, the detailed region from zoom 6 on (no duplicate labels). */
function mapStyle(maps, dark) {
  const flavor = basemaps.namedFlavor(dark ? 'dark' : 'light');
  const world = maps.find(m => m.id === 'map_world');
  const region = maps.filter(m => m.id !== 'map_world').sort((a, b) => b.size - a.size)[0];
  const SPLIT = 6;
  const sources = {};
  const layers = [];
  const add = (m, key, { bg, labelsUntil, from }) => {
    sources[key] = {
      type: 'vector',
      url: 'pmtiles://' + location.origin + m.url,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> · <a href="https://protomaps.com" target="_blank">Protomaps</a>',
    };
    for (const l of basemaps.layers(key, flavor, { lang: 'de' })) {
      if (l.type === 'background') {
        if (bg) layers.push(l);
        continue;
      }
      const out = { ...l, id: key + ':' + l.id };
      if (labelsUntil != null && l.type === 'symbol') out.maxzoom = Math.min(l.maxzoom ?? 24, labelsUntil);
      if (from != null) out.minzoom = Math.max(l.minzoom ?? 0, from);
      layers.push(out);
    }
  };
  if (world) add(world, 'world', { bg: true, labelsUntil: region ? SPLIT : null });
  if (region) add(region, 'region', { bg: !world, from: world ? SPLIT : null });
  return {
    version: 8,
    glyphs: location.origin + '/static/vendor/map/fonts/{fontstack}/{range}.pbf',
    sprite: location.origin + '/static/vendor/map/sprites/v4/' + (dark ? 'dark' : 'light'),
    sources,
    layers,
  };
}

const FEATURE_KIND = {
  locality: 'Ort', neighbourhood: 'Stadtteil', country: 'Land', region: 'Region', peak: 'Gipfel', volcano: 'Vulkan',
  water: 'Gewässer', lake: 'See', river: 'Fluss', ocean: 'Meer', sea: 'Meer', bay: 'Bucht', park: 'Park',
  forest: 'Wald', national_park: 'Nationalpark', hospital: 'Krankenhaus', aerodrome: 'Flughafen', airport: 'Flughafen',
  station: 'Bahnhof', train_station: 'Bahnhof', museum: 'Museum', university: 'Universität', school: 'Schule',
  castle: 'Burg', attraction: 'Sehenswürdigkeit', zoo: 'Zoo', stadium: 'Stadion', pharmacy: 'Apotheke',
};

const mapState = { map: null, maps: [], marker: null, observer: null };

async function showMap(params) {
  if (!state.books.length) await loadBooks();
  const { maps } = await api.get('maps');
  if (state.view !== 'map') return;
  mapState.maps = maps;
  const region = maps.filter(m => m.id !== 'map_world').sort((a, b) => b.size - a.size)[0];
  $('#topLeft').innerHTML = `<div class="crumb"><span class="t">Karten</span><span class="s">${esc(maps.map(m => m.title.replace(/^Karte /, '')).join(' · ') || 'offline')}</span></div>`;
  if (!maps.length) {
    view.innerHTML = `<div class="page"><div class="page-inner"><div class="empty-state">
      <h3>Noch keine Karten</h3><p>Lade die Weltkarte (190 MB) und eine Region wie Deutschland. Danach geht alles ohne Internet, mit Ortssuche.</p>
      <a class="btn primary" href="#/settings?tab=content">Karten laden</a></div></div></div>`;
    return;
  }
  view.innerHTML = `
    <div class="map-view">
      <div class="map" id="map"></div>
      <div class="map-search">
        <div class="ms-input">${ic('search', 17)}<input id="msInput" placeholder="Ort suchen" autocomplete="off" spellcheck="false"><button class="icon-btn" id="msClear" hidden title="Leeren">${ic('x', 15)}</button></div>
        <div class="ms-results" id="msResults" hidden></div>
      </div>
      <div class="place-card" id="placeCard" hidden></div>
    </div>`;
  let ml;
  try {
    ml = await loadMapLib();
  } catch (e) {
    view.innerHTML = `<div class="page"><div class="page-inner"><div class="empty-state"><h3>Karte lädt nicht</h3><p>${esc(e.message)}</p></div></div></div>`;
    return;
  }
  if (state.view !== 'map') return;
  const saved = store.get('mapView', null);
  const lat = parseFloat(params.get('lat'));
  const lon = parseFloat(params.get('lon'));
  const start = !isNaN(lat) ? { center: [lon, lat], zoom: +params.get('z') || 12 }
    : saved || (region ? { bounds: region.bbox } : { center: [10.4, 51.1], zoom: 3 });
  const map = new ml.Map({
    container: 'map',
    style: mapStyle(maps, darkMode()),
    ...(start.bounds ? { bounds: start.bounds, fitBoundsOptions: { padding: 40 } } : { center: start.center, zoom: start.zoom }),
    attributionControl: { compact: true },
    maxPitch: 60,
  });
  mapState.map?.remove();
  mapState.map = map;
  map.addControl(new ml.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new ml.GeolocateControl({ positionOptions: { enableHighAccuracy: false } }), 'bottom-right');
  map.addControl(new ml.ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.on('moveend', () => {
    const c = map.getCenter();
    store.set('mapView', { center: [+c.lng.toFixed(5), +c.lat.toFixed(5)], zoom: +map.getZoom().toFixed(2) });
  });
  mapState.observer?.disconnect();
  mapState.observer = new ResizeObserver(() => map.resize());
  mapState.observer.observe($('#map'));

  // click on a label: show it as a place
  map.on('click', e => {
    const f = map.queryRenderedFeatures(e.point).find(x => x.layer.type === 'symbol' && (x.properties['name:de'] || x.properties.name));
    if (!f) return hidePlace();
    const p = f.properties;
    const pos = f.geometry.type === 'Point' ? f.geometry.coordinates : [e.lngLat.lng, e.lngLat.lat];
    showPlace({ name: p['name:de'] || p.name, official: p['name:de'] && p.name !== p['name:de'] ? p.name : '',
      kind: FEATURE_KIND[p.kind_detail] || FEATURE_KIND[p.kind] || '', lon: pos[0], lat: pos[1], pop: +p.population || 0 }, false);
  });

  if (!isNaN(lat)) {
    map.once('load', () => showPlace({ name: params.get('name') || '', kind: params.get('kind') || '', cc: params.get('cc') || '',
      pop: +params.get('pop') || 0, lat, lon }, false));
    history.replaceState(null, '', '#/map');
  }

  // search box
  const input = $('#msInput');
  const results = $('#msResults');
  let items = [], sel = 0, seq = 0;
  const draw = () => {
    results.hidden = !items.length && !input.value.trim();
    results.innerHTML = items.length ? items.map((r, i) => `
      <button class="ms-item ${i === sel ? 'sel' : ''}" data-i="${i}">${ic('pin', 16)}
        <span class="grow"><b>${esc(r.name)}</b><small>${esc([r.kind, r.cc && countryName(r.cc), r.official].filter(Boolean).join(' · '))}</small></span></button>`).join('')
      : `<div class="ms-empty">${input.value.trim().length < 2 ? 'Mindestens zwei Buchstaben' : 'Kein Ort gefunden'}</div>`;
    $$('.ms-item', results).forEach(b => (b.onclick = () => pick(items[+b.dataset.i])));
  };
  const pick = r => {
    input.value = r.name;
    items = [];
    results.hidden = true;
    input.blur();
    showPlace(r, true);
  };
  let timer = 0;
  input.addEventListener('input', () => {
    $('#msClear').hidden = !input.value;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const my = ++seq;
      const q = input.value.trim();
      const r = q.length >= 2 ? (await api.get('places?limit=7&q=' + encodeURIComponent(q))).results : [];
      if (my !== seq) return;
      items = r;
      sel = 0;
      draw();
    }, 110);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      draw();
    } else if (e.key === 'Enter' && items[sel]) {
      e.preventDefault();
      pick(items[sel]);
    } else if (e.key === 'Escape') {
      input.blur();
      results.hidden = true;
    }
  });
  input.addEventListener('focus', () => items.length && (results.hidden = false));
  input.addEventListener('blur', () => setTimeout(() => (results.hidden = true), 150));
  $('#msClear').onclick = () => {
    input.value = '';
    items = [];
    $('#msClear').hidden = true;
    results.hidden = true;
    hidePlace();
    input.focus();
  };
}

function hidePlace() {
  const card = $('#placeCard');
  if (card) card.hidden = true;
  mapState.marker?.remove();
  mapState.marker = null;
}

function showPlace(p, fly) {
  const map = mapState.map;
  const card = $('#placeCard');
  if (!map || !card) return;
  mapState.marker?.remove();
  const el = document.createElement('div');
  el.className = 'map-pin';
  mapState.marker = new mapLib.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(map);
  if (fly) map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), p.zoom || 12), speed: 1.6, essential: true });
  const sub = [p.kind, p.cc && countryName(p.cc), p.pop ? fmtNum(p.pop) + ' Einwohner' : ''].filter(Boolean).join(' · ');
  card.innerHTML = `
    <button class="icon-btn pc-close" title="Schließen">${ic('x', 16)}</button>
    <h3>${esc(p.name || 'Markierter Ort')}</h3>
    ${p.official ? `<div class="pc-alt">${esc(p.official)}</div>` : ''}
    ${sub ? `<p>${esc(sub)}</p>` : ''}
    <div class="pc-acts">
      ${p.name ? `<button class="btn sm" data-a="wiki">${ic('book', 15)} Wikipedia</button>
      <button class="btn sm" data-a="ask">${ic('sparkle', 15)} Basecamp fragen</button>` : ''}
      <button class="btn sm ghost" data-a="coords" title="Koordinaten kopieren">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</button>
    </div>`;
  card.hidden = false;
  $('.pc-close', card).onclick = hidePlace;
  $('[data-a=coords]', card).onclick = () => copyText(`${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`);
  const wiki = $('[data-a=wiki]', card);
  if (wiki) wiki.onclick = async () => {
    const r = await api.get('suggest?q=' + encodeURIComponent(p.name));
    const want = norm(p.name);
    const hit = r.results.find(x => norm(x.title) === want) || r.results.find(x => norm(x.title).startsWith(want)) || r.results[0];
    if (hit) openArticle(hit.book, hit.path);
    else toast('Kein Artikel gefunden');
  };
  const ask = $('[data-a=ask]', card);
  if (ask) ask.onclick = () => (location.hash = '#/?q=' + encodeURIComponent(`Was sollte man über ${p.name}${p.cc ? ' (' + countryName(p.cc) + ')' : ''} wissen?`));
}

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');

function mapHref(r) {
  const q = new URLSearchParams({ lat: r.lat, lon: r.lon, z: r.zoom || 12, name: r.name, kind: r.kind || '', cc: r.cc || '', pop: r.pop || 0 });
  return '#/map?' + q;
}

/* ================================================================ coding agent */

const CODE_STARTERS = [
  'Schreib ein Skript, das Fotos in einem Ordner nach Aufnahmedatum sortiert',
  'Bau eine kleine Webseite mit einer To-do-Liste, die im Browser speichert',
  'Ein Bash-Skript, das die 10 größten Dateien in einem Ordner zeigt',
];
const TOOL_LABEL = {
  list_files: ['folder', 'Dateien angesehen'], read_file: ['file', 'Datei gelesen'], write_file: ['edit', 'Datei geschrieben'],
  edit_file: ['edit', 'Datei geändert'], run: ['terminal', 'Befehl'], search_docs: ['book', 'Doku durchsucht'],
};
const isLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);

async function streamNdjson(url, payload, signal, onEvent) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || 'HTTP ' + res.status);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onEvent(JSON.parse(line));
    }
  }
}

function createCodeChat(saved) {
  const chat = saved
    ? { ...saved, messages: saved.messages.map(m => ({ ...m })) }
    : { id: crypto.randomUUID(), kind: 'code', title: '', created: Date.now(), cwd: '', messages: [] };
  const root = document.createElement('div');
  root.className = 'chat code';
  root.innerHTML = `
    <div class="thread"><div class="thread-inner"></div></div>
    <div class="composer-wrap">
      <form class="composer">
        <textarea rows="1" placeholder="Was sollen wir bauen?" aria-label="Aufgabe"></textarea>
        <div class="cbar">
          <div class="picker opts-slot"></div>
          <button type="button" class="pill amber auto-pill" hidden title="Automatisch ausschalten">${ic('play', 13)}<span>Automatisch</span>${ic('x', 12, 2.2)}</button>
          <span class="spacer"></span>
          <div class="picker model-slot"></div>
          <button class="send" type="submit" disabled title="Senden">${ic('arrowUp', 18, 2.2)}</button>
        </div>
      </form>
      <div class="disclaimer"></div>
    </div>
    <div class="starters"></div>`;
  const inner = $('.thread-inner', root);
  const thread = $('.thread', root);
  const ta = $('textarea', root);
  const form = $('form', root);
  const sendBtn = $('.send', root);
  const autoPill = $('.auto-pill', root);
  const disclaimer = $('.disclaimer', root);
  let ctrl = null;
  let stopped = false;
  let pendingResolve = null;

  // this option sits in a menu, so when commands run without asking it has to show here
  const opts = composerOptions($('.opts-slot', root), [
    { key: 'codeAuto', def: false, shown: true, icon: 'play', title: 'Automatisch', desc: 'Befehle ohne Nachfragen ausführen' },
    thinkOption('codeThink'),
  ], () => {
    const auto = store.get('codeAuto', false);
    autoPill.hidden = !auto;
    disclaimer.textContent = `Dateien bleiben im Arbeitsordner. ${auto ? 'Befehle laufen ohne Nachfrage.' : 'Befehle laufen erst nach deiner Freigabe.'}`;
  });
  autoPill.onclick = () => { store.set('codeAuto', false); opts.refresh(); };

  function applyCaps() {
    const caps = chatModels(true).find(m => m.name === currentModel(true))?.caps || [];
    opts.hide('codeThink', !caps.includes('thinking'));
    const hint = $('.hero-hint', root);
    if (hint) hint.innerHTML = heroHint();
  }

  let running = false; // the whole agent loop, including tool calls
  const busy = () => running || !!ctrl || !!pendingResolve;
  const autosize = () => {
    sendBtn.disabled = !(ta.value.trim() || busy()) || !currentModel(true);
    if (!ta.isConnected) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  };
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    if (busy()) return stop();
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    autosize();
    send(text);
  });

  function stop() {
    stopped = true;
    ctrl?.abort();
    pendingResolve?.(false);
  }

  function setBusy(on) {
    sendBtn.innerHTML = ic(on ? 'stop' : 'arrowUp', 18, 2.2);
    sendBtn.title = on ? 'Stoppen' : 'Senden';
    autosize();
  }

  async function ensureCwd() {
    if (chat.cwd) return chat.cwd;
    const r = await api.post('code/workspace', { id: chat.id.slice(0, 8), title: chat.title || '' });
    chat.cwd = r.cwd;
    mountCwd();
    return chat.cwd;
  }

  function mountCwd() {
    if (state.chat !== api_ || !isLocal) return;
    const name = chat.cwd ? chat.cwd.split('/').filter(Boolean).pop() : 'Neuer Ordner';
    $('#topRight').innerHTML = `<div class="picker"><button class="btn sm ghost picker-btn" id="cwdBtn" title="${esc(chat.cwd || 'Wird beim Start angelegt')}">${ic('folder', 15)}<span>${esc(name)}</span>${ic('chevDown', 14)}</button></div>`;
    $('#cwdBtn').onclick = e => {
      e.stopPropagation();
      if ($('#topRight .menu')) return closeMenus();
      const menu = document.createElement('div');
      menu.className = 'menu right';
      menu.innerHTML = `
        <div class="menu-label">Arbeitsordner</div>
        <div class="menu-path"><code class="path">${esc(chat.cwd || 'Wird beim Start angelegt in data/code')}</code></div>
        ${chat.cwd ? `<button class="menu-item" data-a="finder">${ic('external', 16)}<div class="grow"><b>Im Finder öffnen</b></div></button>
          <button class="menu-item" data-a="preview">${ic('globe', 16)}<div class="grow"><b>Im Browser ansehen</b><small>Zeigt index.html oder die Dateien</small></div></button>` : ''}
        <div class="menu-sep"></div>
        <form class="menu-form"><input name="p" placeholder="Anderer Ordner, z. B. ~/Documents/Skripte" autocomplete="off"><button class="btn sm">Wählen</button></form>`;
      $('#topRight .picker').appendChild(menu);
      $('[data-a=finder]', menu)?.addEventListener('click', () => { api.post('code/open', { cwd: chat.cwd }); closeMenus(); });
      $('[data-a=preview]', menu)?.addEventListener('click', async () => {
        closeMenus();
        const tab = window.open('about:blank', '_blank');
        const r = await api.post('code/preview', { cwd: chat.cwd }).catch(() => ({}));
        if (r.url && tab) tab.location = r.url;
        else { tab?.close(); toast(r.error || 'Vorschau geht gerade nicht.'); }
      });
      $('.menu-form', menu).onsubmit = async ev => {
        ev.preventDefault();
        const r = await api.post('code/workspace', { path: ev.target.p.value.trim() });
        if (r.error) return toast(r.error);
        chat.cwd = r.cwd;
        if (chat.messages.length) Chats.save(chat);
        closeMenus();
        mountCwd();
        toast('Ordner gewechselt');
      };
    };
  }

  // ---- rendering
  // the models load after the first paint, so only warn once they are known
  function heroHint() {
    if (!isLocal) return 'Basecamp Code geht nur direkt auf dem Mac, nicht übers WLAN.';
    if (state.models && !currentModel(true)) return 'Noch kein Modell mit Werkzeugen. <a href="#/settings?tab=models" style="text-decoration:underline">Code-Modell laden</a>';
    return 'Schreibt und testet Skripte in einem Ordner auf deinem Mac. Alles bleibt lokal.';
  }
  function renderEmpty() {
    const empty = !chat.messages.length;
    root.classList.toggle('empty', empty);
    const starters = $('.starters', root);
    if (!empty) {
      starters.innerHTML = '';
      return;
    }
    inner.innerHTML = `<div class="hero">${wordmark('Code')}<p class="hero-hint">${heroHint()}</p></div>`;
    starters.innerHTML = CODE_STARTERS.map(s => `<button class="starter" data-q="${esc(s)}">${esc(s)}</button>`).join('') +
      `<div class="starter-note">Lieber im Terminal? <code class="path">./basecamp code</code> startet Claude Code, OpenCode oder Codex mit dem lokalen Modell.</div>`;
    $$('[data-q]', starters).forEach(b => (b.onclick = () => send(b.dataset.q)));
  }

  // show paths relative to the working folder, even when the model wrote them absolute
  const rel = s => (chat.cwd ? String(s ?? '').split(chat.cwd + '/').join('').split(chat.cwd).join('.') : String(s ?? ''));
  function toolArg(c) {
    const a = c.args || {};
    return rel(c.name === 'run' ? a.command : c.name === 'search_docs' ? a.query : a.path || '.');
  }

  function toolCard(c, i) {
    const [icon, label] = TOOL_LABEL[c.name] || ['sparkle', c.name];
    const r = c.result;
    const st = c.status === 'pending' ? '<span class="tc-state wait">Wartet auf dich</span>'
      : c.status === 'running' ? '<span class="tc-state"><span class="spin"></span></span>'
      : c.status === 'denied' ? '<span class="tc-state bad">Abgelehnt</span>'
      : r && !r.ok ? `<span class="tc-state bad">${c.name === 'run' ? 'Exit ' + r.exit : 'Fehler'}</span>`
      : r ? `<span class="tc-state ok">${ic('check', 13, 2.6)}${c.name === 'run' && r.seconds != null ? ' ' + String(r.seconds).replace('.', ',') + ' s' : ''}</span>` : '';
    let body = '';
    const a = c.args || {};
    if (c.name === 'write_file') body = `<pre class="code-block"><code>${esc(a.content || '')}</code></pre>`;
    else if (c.name === 'edit_file') body = `<pre class="code-block diff"><code>${esc(a.old || '').split('\n').map(l => `<del>- ${l}</del>`).join('\n')}\n${esc(a.new || '').split('\n').map(l => `<ins>+ ${l}</ins>`).join('\n')}</code></pre>`;
    else if (c.name === 'run') body = `<pre class="term"><code><span class="ps">$</span> ${esc(rel(a.command))}${r ? '\n' + esc(r.output) : ''}</code></pre>`;
    else if (c.name === 'search_docs' && r?.sources?.length) body = `<div class="tc-src">${r.sources.map((s, k) => `<a class="src-chip" data-src="${k}" href="${readHref(s.book, s.path)}">${srcIco(s.book, s.source)}<span class="t">${esc(s.title)}</span></a>`).join('')}</div>`;
    else if (r) body = `<pre class="code-block"><code>${esc(r.output)}</code></pre>`;
    if (r && !r.ok && !['run'].includes(c.name)) body += `<div class="tc-err">${esc(r.output)}</div>`;
    const open = c._open ?? (c.name === 'run' || c.status === 'pending' || (r && !r.ok));
    return `<div class="tc ${c.status || ''}" data-c="${i}">
      <button class="tc-head" data-t="${i}">${ic(icon, 15)}<span class="tc-label">${esc(label)}</span><code class="tc-arg">${esc(toolArg(c))}</code>${st}${body ? ic(open ? 'chevDown' : 'chevRight', 14) : ''}</button>
      ${body && open ? `<div class="tc-body">${body}</div>` : ''}
      ${c.status === 'pending' ? `<div class="tc-approve"><span>Diesen Befehl ausführen?</span><span class="spacer"></span>
        <button class="btn sm ghost" data-deny="${i}">Ablehnen</button><button class="btn sm primary" data-ok="${i}">${ic('play', 13)} Ausführen</button></div>` : ''}
    </div>`;
  }

  function paintStep(m, streaming) {
    const el = m._el;
    let html = '';
    if (m.thinking) {
      html += thoughtHtml(m, streaming && !m.content && !m.calls?.length);
    } else if (streaming && !m.content && !m.calls?.length) {
      html += `<div class="step">${shimmer(esc(m.status || 'Arbeitet …'))}${since(m.statusSince || Date.now())}</div>`;
      if (m.statusLoad) html += '<div class="step-hint">Passiert einmal nach dem Start. Danach geht es schneller.</div>';
    }
    if (m.content) html += `<div class="md ${streaming ? 'caret' : ''}">${md(m.content)}</div>`;
    if (m.calls?.length) html += `<div class="tools">${m.calls.map(toolCard).join('')}</div>`;
    if (m.error) html += `<div class="err">${esc(m.error)}</div>`;
    if (m.final && !streaming) {
      const s = m.stats;
      html += `<div class="actions">
        <button class="icon-btn" data-act="copy" title="Kopieren">${ic('copy', 16)}</button>
        ${chat.cwd ? `<button class="icon-btn" data-act="finder" title="Ordner im Finder öffnen">${ic('folder', 16)}</button>` : ''}
        ${s ? `<span class="stats">${esc(modelMeta(s.model)?.title || s.model)} · ${m.steps || 1} Schritte · ${s.tps} Token/s</span>` : ''}</div>`;
    }
    el.innerHTML = html;
    const caret = $('.md.caret', el);
    if (caret?.lastElementChild) { caret.lastElementChild.classList.add('caret'); caret.classList.remove('caret'); }
    const det = $('details.thought', el);
    if (det) det.ontoggle = () => (m._open = det.open);
    $$('[data-t]', el).forEach(b => (b.onclick = () => {
      const c = m.calls[+b.dataset.t];
      const cur = c._open ?? (c.name === 'run' || c.status === 'pending' || (c.result && !c.result.ok));
      c._open = !cur;
      paintStep(m, streaming);
    }));
    $$('[data-ok]', el).forEach(b => (b.onclick = () => pendingResolve?.(true)));
    $$('[data-deny]', el).forEach(b => (b.onclick = () => pendingResolve?.(false)));
    $$('[data-src]', el).forEach(a => (a.onclick = e => {
      e.preventDefault();
      const c = m.calls[+a.closest('[data-c]').dataset.c];
      const s = c.result.sources[+a.dataset.src];
      openArticle(s.book, s.path);
    }));
    $('[data-act=copy]', el)?.addEventListener('click', () => copyText(m.content));
    $('[data-act=finder]', el)?.addEventListener('click', () => api.post('code/open', { cwd: chat.cwd }));
  }

  function stepEl(m) {
    const el = document.createElement('div');
    el.className = 'turn bot agent';
    m._el = el;
    paintStep(m, false);
    return el;
  }
  function userEl(m) {
    const el = document.createElement('div');
    el.className = 'turn user';
    el.innerHTML = `<div class="bubble">${esc(m.content)}</div>`;
    return el;
  }

  function renderAll() {
    renderEmpty();
    if (!chat.messages.length) return;
    inner.innerHTML = '';
    chat.messages.forEach(m => inner.appendChild(m.role === 'user' ? userEl(m) : stepEl(m)));
    requestAnimationFrame(() => (thread.scrollTop = thread.scrollHeight));
  }

  function apiMessages() {
    const out = [];
    for (const m of chat.messages) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.content });
        continue;
      }
      if (!m.content && !m.calls?.length) continue;
      out.push({ role: 'assistant', content: m.content || '', tool_calls: (m.calls || []).map(c => ({ name: c.name, args: c.args })) });
      for (const c of m.calls || []) {
        out.push({ role: 'tool', tool_name: c.name, content: c.result ? c.result.output : 'Abgebrochen.' });
      }
    }
    return out;
  }

  const stick = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;

  // ---- the agent loop: model step -> tools (with approval) -> next step
  async function send(text) {
    if (!state.models) await loadModels();
    const model = currentModel(true);
    if (!model || !isLocal) {
      if (!model) location.hash = '#/settings?tab=models';
      return;
    }
    if (running) return;
    running = true;
    if (!chat.messages.length) inner.innerHTML = '';
    const user = { role: 'user', content: text };
    chat.messages.push(user);
    renderEmpty();
    inner.appendChild(userEl(user));
    if (!chat.title) chat.title = text.slice(0, 70);
    const first = chat.messages.length === 1;
    await ensureCwd();
    Chats.save(chat);
    if (first) {
      history.replaceState(null, '', '#/code/' + chat.id);
      state.view = 'code';
    }
    renderChatList();
    live.set(chat.id, api_);
    stopped = false;
    let steps = 0, last = null;

    while (!stopped && steps < 30) {
      steps++;
      const step = { role: 'assistant', content: '', thinking: '', calls: [], statusSince: Date.now() };
      chat.messages.push(step);
      inner.appendChild(stepEl(step));
      paintStep(step, true);
      thread.scrollTop = thread.scrollHeight;
      last = step;
      ctrl = new AbortController();
      setBusy(true);
      let frame = 0, t0 = 0;
      const repaint = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          const s = stick();
          paintStep(step, true);
          if (s) thread.scrollTop = thread.scrollHeight;
        });
      };
      try {
        await streamNdjson('/api/code/chat', {
          model, cwd: chat.cwd, think: opts.on('codeThink'), messages: apiMessages(),
        }, ctrl.signal, ev => {
          if (ev.t === 'think') { if (!t0) t0 = step.thinkStart = Date.now(); step.thinking += ev.c; }
          else if (ev.t === 'status') { step.status = ev.c; step.statusLoad = !!ev.load; step.statusSince = Date.now(); }
          else if (ev.t === 'tok') { if (t0 && !step.thinkSecs) step.thinkSecs = Math.max(1, Math.round((Date.now() - t0) / 1000)); step.content += ev.c; }
          else if (ev.t === 'tool_calls') step.calls = ev.c;
          else if (ev.t === 'retry') { step.content = ''; step.thinking = ''; step.calls = []; t0 = 0; }
          else if (ev.t === 'error') step.error = ev.c;
          else if (ev.t === 'done') step.stats = ev.c;
          repaint();
        });
      } catch (e) {
        if (e.name !== 'AbortError') step.error = 'Verbindung unterbrochen: ' + e.message;
      }
      if (frame) cancelAnimationFrame(frame);
      ctrl = null;
      if (step.thinking && !step.thinkSecs && t0) step.thinkSecs = Math.max(1, Math.round((Date.now() - t0) / 1000));
      paintStep(step, false);
      if (stopped || step.error || !step.calls.length) break;

      for (const c of step.calls) {
        if (stopped) break;
        if (c.name === 'run' && !store.get('codeAuto', false)) {
          c.status = 'pending';
          paintStep(step, false);
          if (stick()) thread.scrollTop = thread.scrollHeight;
          setBusy(true);
          const ok = await new Promise(res => (pendingResolve = res));
          pendingResolve = null;
          if (!ok) {
            c.status = 'denied';
            c.result = { ok: false, output: 'Der Nutzer hat diesen Befehl abgelehnt. Frag nach, was er stattdessen möchte.' };
            paintStep(step, false);
            if (stopped) break;
            continue;
          }
        }
        c.status = 'running';
        c._open = undefined;
        paintStep(step, false);
        c.result = await api.post('code/tool', { cwd: chat.cwd, name: c.name, args: c.args }).catch(e => ({ ok: false, output: String(e) }));
        c.status = 'done';
        paintStep(step, false);
        if (stick()) thread.scrollTop = thread.scrollHeight;
      }
      Chats.save(chat);
    }
    if (last) {
      last.final = true;
      last.steps = steps;
      if (stopped && !last.content && !last.error) last.error = 'Gestoppt.';
      paintStep(last, false);
    }
    running = false;
    setBusy(false);
    if (!deleted.has(chat.id)) Chats.save(chat);
    live.delete(chat.id);
    if (state.chat === api_) renderChatList();
  }

  const api_ = {
    root, chat, send, applyCaps, mountCwd, stop,
    attachArticle: () => {},
    focus: () => setTimeout(() => { autosize(); ta.focus(); }, 0),
    streaming: busy,
  };
  renderAll();
  applyCaps();
  autosize();
  return api_;
}

async function showCode(id) {
  if (!state.books.length) await loadBooks();
  let c = id && live.get(id);
  if (!c) {
    const saved = id ? Chats.get(id) : null;
    if (id && (!saved || saved.kind !== 'code')) {
      location.hash = '#/code';
      return;
    }
    c = createCodeChat(saved);
  }
  state.chat = c;
  view.replaceChildren(c.root);
  renderChatList();
  await mountModelPicker(true);
  c.applyCaps();
  c.mountCwd();
  c.focus();
}

/* ================================================================ background tasks */

let lastActive = -1;

async function pollTasks() {
  try {
    state.tasks = (await api.get('tasks')).tasks;
  } catch {
    return;
  }
  const active = state.tasks.filter(t => ['queued', 'running'].includes(t.status));
  const dl = $('#dlStatus');
  if (active.length) {
    const run = active.find(t => t.status === 'running') || active[0];
    dl.hidden = false;
    dl.innerHTML = `<div style="display:flex;justify-content:space-between"><span>${active.length === 1 ? 'Lädt' : `Lädt ${active.length} Dateien`} · ${esc(modelMeta(run.ref)?.title || run.title)}</span><span>${pct(run)} %</span></div>
      <div class="bar"><div style="width:${pct(run)}%"></div></div>`;
  } else dl.hidden = true;

  if (state.view === 'settings') {
    renderTasks();
    $$('[data-task]').forEach(b => {
      const t = state.tasks.find(x => x.id === b.dataset.task);
      if (t) b.textContent = t.status === 'queued' ? 'Wartet' : pct(t) + ' %';
    });
  }
  if (lastActive >= 0 && active.length < lastActive) {
    // something finished
    state.books = [];
    await Promise.all([loadBooks(), loadModels()]);
    state.chat?.applyCaps();
    if (state.view === 'map' && !mapState.map) route();
    if (state.view === 'settings') {
      const tab = new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || 'content';
      const body = $('#tabBody');
      if (body) (tab === 'models' ? renderModels : tab === 'content' ? renderContent : renderSystem)(body);
    }
  }
  lastActive = active.length;
}
setInterval(pollTasks, 2000);

/* ================================================================ start */

hydrateIcons();
pollTasks();
loadBooks().finally(route);
