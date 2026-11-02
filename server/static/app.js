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
  link: '<path d="M10 14a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.5-1.5"/>',
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
  brain: '<path d="M12 5a3 3 0 1 0-6 .1 4 4 0 0 0-2.5 5.8 4 4 0 0 0 .6 6.6A4 4 0 1 0 12 18z"/><path d="M12 5a3 3 0 1 1 6 .1 4 4 0 0 1 2.5 5.8 4 4 0 0 1-.6 6.6A4 4 0 1 1 12 18z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lifebuoy: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="m5.6 5.6 3.6 3.6M14.8 14.8l3.6 3.6M18.4 5.6l-3.6 3.6M9.2 14.8l-3.6 3.6"/>',
  phone: '<path d="M21 16.5v3a2 2 0 0 1-2.2 2A18 18 0 0 1 2.5 5.2 2 2 0 0 1 4.5 3h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.5 10.8a15 15 0 0 0 4.7 4.7l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  printer: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  wave: '<path d="M2 8c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2 2.5-2 5-2"/><path d="M2 15c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2 2.5-2 5-2"/>',
  alert: '<path d="M12 3.5 22 21H2z"/><path d="M12 10v5"/><path d="M12 18h.01" stroke-width="2.6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>',
};
const LOGO = (size = 22) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M12 2.5 22.5 21h-21Z M12 11l4.6 10H7.4Z"/><circle cx="18.5" cy="5.5" r="1.6"/></svg>`;
const wordmark = () => `<div class="wordmark">${LOGO(50)}<span>Basecamp</span></div>`;
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
  projects: null, // null: not available here, e.g. on a phone in the WLAN
  power: null,
  warn: null,
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
async function loadProjects() {
  const r = await api.get('projects').catch(() => ({}));
  state.projects = r.projects || null;
  $('#navProjects').hidden = !state.projects;
}
const projectById = id => state.projects?.find(p => p.id === id);

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
  const box = anchor.getBoundingClientRect();
  const area = $('#view').getBoundingClientRect();
  const above = box.top - area.top - 16;
  const below = area.bottom - box.bottom - 16;
  // a composer near the top of a page has no room above it, so its menus open downward
  if (above < 260 && below > above) menu.classList.remove('up');
  menu.style.maxHeight = `min(70vh, ${menu.classList.contains('up') ? above : below}px)`;
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
  // the chats of a deleted project stay, as normal chats
  unlinkProject(project) {
    store.set('chats', Chats.all().map(c => (c.project === project ? { ...c, project: null } : c)));
    for (const c of live.values()) if (c.chat.project === project) c.chat.project = null;
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
        ${c.kind === 'code' ? `<i class="sb-kind" title="Basecamp Code">${ic('terminal', 14)}</i>` : projectById(c.project) ? `<i class="sb-kind" title="Projekt: ${esc(projectById(c.project).name)}">${ic('folder', 14)}</i>` : ''}<span>${esc(c.title || 'Neuer Chat')}</span>
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

let leaveNotfall = null; // saves the emergency form when the user moves on

function route() {
  const saving = leaveNotfall?.();
  leaveNotfall = null;
  const hash = location.hash.slice(1) || '/';
  const [path, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  const page = parts[0] || '';
  state.view = page;
  if (page !== 'bibel') bible.meta = null; // sources can change while we are away
  if (page !== 'map' && mapState.map) {
    mapState.map.remove();
    mapState.map = null;
    mapState.observer?.disconnect();
  }
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === ({ p: 'projects', bibel: 'library' }[page] || page)));
  $('#topLeft').innerHTML = '';
  $('#topRight').innerHTML = '';
  closeMenus();
  renderChatList();
  if (innerWidth <= 900) setSidebar(false);
  if (page === 'read') {
    const book = decodeURIComponent(parts[1] || '');
    const article = parts.slice(2).map(decodeURIComponent).join('/');
    if (book.startsWith(BIBLE_PREFIX)) return location.replace(bibleHrefOf(book, article));
    return showReader(book, article);
  }
  renderPower();
  if (page === 'library') return showLibrary();
  if (page === 'bibel') return showBible(parts[1], parts[2], parts[3], params);
  if (page === 'notfall') return showNotfall(params.get('edit'), params.get('flow') === '1', saving);
  if (page === 'projects') return showProjects();
  if (page === 'p') return showProject(parts[1]);
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
    if ((readerNav?.page?.path ?? path) === bb?.main) title = 'Startseite';
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
  if (!(code ? ['code'] : ['', 'c', 'p']).includes(state.view)) return;
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

function createChat(saved, project = null) {
  const chat = saved
    ? { ...saved, messages: saved.messages.map(m => ({ ...m })) }
    : { id: crypto.randomUUID(), title: '', created: Date.now(), messages: [], article: null, project };
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
  let turns = 0; // answers and learning steps still running

  const opts = composerOptions($('.opts-slot', root), [
    { key: 'kb', def: true, icon: 'book', title: 'Bibliothek', desc: 'Antworten mit Quellen aus deiner Bibliothek' },
    { key: 'memory', def: true, icon: 'brain', title: 'Gedächtnis', desc: 'Merkt sich Fakten aus dem Chat und nutzt sie', hidden: !state.projects },
    thinkOption('think'),
  ]);
  $('[data-a=attach]', root).onclick = () => fileInput.click();

  function applyCaps() {
    const caps = chatModels().find(m => m.name === currentModel())?.caps || [];
    opts.hide('think', !caps.includes('thinking'));
    $('[data-a=attach]', root).hidden = !caps.includes('vision');
    autosize();
    if (!chat.messages.length) renderEmpty();
  }

  // ---- composer
  const canSend = () => !!ctrl || (ta.value.trim().length > 0 && !!currentModel() && !state.power?.on);
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
    if (!text || state.power?.on) return;
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
  let heroKey = null; // drawn once per state: drawing it again would replay the animation
  function renderEmpty() {
    const empty = !chat.messages.length;
    root.classList.toggle('empty', empty);
    const starters = $('.starters', root);
    if (!empty) {
      starters.innerHTML = '';
      heroKey = null;
      return;
    }
    const st = state.status;
    const aiOff = !!st && !st.ollama;
    const noBooks = !state.books.length;
    const noModel = !aiOff && !!state.models && !currentModel();
    const key = [noBooks, noModel, aiOff, !!state.projects, state.books.length].join();
    if (key === heroKey && $('.hero', inner)) return;
    heroKey = key;
    const total = state.books.reduce((n, b) => n + b.articles, 0);
    const todo = [
      noBooks && `<a class="btn primary" href="#/settings?tab=content">Wissen laden</a>`,
      noModel && `<a class="btn ${noBooks ? '' : 'primary'}" href="#/settings?tab=models">KI-Modell laden</a>`,
    ].filter(Boolean).join('');
    const note = todo
      ? `<p>${noBooks && noModel ? 'Zum Start fehlen noch zwei Dinge.' : noBooks ? 'Noch keine Inhalte. Einmal laden, danach geht alles ohne Internet.' : 'Noch kein KI-Modell. Suchen und Lesen gehen schon.'}</p><div class="hero-todo">${todo}</div>`
      : aiOff
        ? '<p>Die KI ist aus. Starte sie mit <code class="path">./basecamp start</code>. Suchen geht trotzdem mit ⌘K.</p>'
        : `<p>${state.books.length} Quellen · ${fmtNum(total)} Artikel · alles offline</p>`;
    inner.innerHTML = `<div class="hero">${wordmark()}${note}${modeSwitch('chat')}</div>`;
    starters.innerHTML = noModel || aiOff ? '' : STARTERS.slice(0, 3).map(q => `<button class="starter" data-q="${esc(q)}">${esc(q)}</button>`).join('');
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
    if (m.memory) html += memoryNote(m.memory, chat.project);
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
      if (root.classList.contains('embedded')) { // started on a project page: the chat takes over the view
        root.classList.remove('embedded');
        view.replaceChildren(root);
        mountProjectChip();
        ta.focus();
      }
    }
    renderChatList();
    turns++;
    live.set(chat.id, api_);
    const project = chat.project || null;
    const useMemory = opts.on('memory');

    const payload = {
      model,
      mode,
      article: chat.article ? { book: chat.article.book, path: chat.article.path } : null,
      think: opts.on('think'),
      project,
      memory: useMemory,
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
    if (state.chat === api_) renderChatList();
    if (useMemory && bot.content && !bot.error) await learnFrom(bot, text, model, project);
    if (--turns === 0) live.delete(chat.id);
  }

  // runs after the answer, so it never delays it
  async function learnFrom(bot, text, model, project) {
    const r = await api.post('memory/learn', { project, model, text }).catch(() => null);
    if (!r?.added?.length && !r?.removed?.length) return;
    bot.memory = { added: r.added.map(f => f.text), removed: r.removed.map(f => f.text) };
    paintBot(bot, false);
    if (!deleted.has(chat.id)) Chats.save(chat);
  }

  const api_ = {
    root,
    chat,
    send,
    applyCaps,
    attachArticle,
    setProject(id) {
      chat.project = id;
      if (chat.messages.length) Chats.save(chat);
      renderChatList();
    },
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
  mountProjectChip();
  await mountModelPicker();
  c.applyCaps();
  if (pendingArticle) {
    c.attachArticle(pendingArticle);
    if (!panel.book && innerWidth > 900) openPanel(pendingArticle.book, pendingArticle.path);
    if (pendingArticle.draft) {
      const box = $('textarea', c.root);
      box.value = pendingArticle.draft;
      box.dispatchEvent(new Event('input'));
    }
    pendingArticle = null;
  }
  if (q) {
    history.replaceState(null, '', '#/');
    c.send(q);
  } else c.focus();
}

/* ================================================================ projects and memory */

const memoryHref = project => (project ? `#/p/${project}` : '#/settings?tab=memory');

function memoryNote(mem, project) {
  const list = items => items.map(esc).join(' · ');
  const parts = [mem.added.length && `Gemerkt: ${list(mem.added)}`, mem.removed.length && `Vergessen: ${list(mem.removed)}`].filter(Boolean);
  return `<a class="mem-note" href="${memoryHref(project)}" title="Gedächtnis ansehen">${ic('brain', 14)}<span>${parts.join(' · ')}</span></a>`;
}

// Shows which project the open chat belongs to, and moves it to another one.
// Stays away until there is a project to choose.
function mountProjectChip() {
  const slot = $('#topLeft');
  const c = state.chat;
  if (!state.projects?.length || !c?.setProject) return;
  const cur = projectById(c.chat.project);
  slot.innerHTML = `<div class="picker project-chip"><button type="button" class="picker-btn" title="Projekt wählen">${ic('folder', 16)}<span>${esc(cur?.name || 'Kein Projekt')}</span>${ic('chevDown', 15)}</button></div>`;
  const picker = $('.picker', slot);
  $('.picker-btn', slot).onclick = () => {
    if ($('.menu', slot)) return closeMenus();
    closeMenus();
    const item = (id, name, sub) => `<button type="button" class="menu-item ${(id || null) === (cur?.id || null) ? 'on' : ''}" data-project="${id}">
      <div class="grow"><b>${esc(name)}</b><small>${esc(sub)}</small></div><span class="check">${ic('check', 16)}</span></button>`;
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.innerHTML = `
      <div class="menu-label">Das Gedächtnis ist je Projekt getrennt</div>
      ${item('', 'Kein Projekt', 'Allgemeines Gedächtnis')}
      ${state.projects.map(p => item(p.id, p.name, `${p.facts} ${p.facts === 1 ? 'Fakt' : 'Fakten'}`)).join('')}
      <div class="menu-sep"></div>
      ${cur ? `<a class="menu-item" href="#/p/${cur.id}"><div class="grow"><b>Projekt öffnen</b></div>${ic('chevRight', 16)}</a>` : ''}
      <a class="menu-item" href="#/projects"><div class="grow"><b>Alle Projekte</b></div>${ic('chevRight', 16)}</a>`;
    picker.appendChild(menu);
    $$('[data-project]', menu).forEach(b => (b.onclick = () => {
      closeMenus();
      c.setProject(b.dataset.project || null);
      mountProjectChip();
    }));
    $$('a', menu).forEach(a => (a.onclick = closeMenus));
  };
}

async function showProjects() {
  if (panel.book) closePanel();
  await loadProjects();
  if (state.view !== 'projects') return;
  if (!state.projects) {
    location.hash = '#/';
    return;
  }
  const chats = Chats.all();
  const facts = n => `${n} ${n === 1 ? 'Fakt' : 'Fakten'}`;
  const count = p => {
    const n = chats.filter(c => c.project === p.id).length;
    return `${n} ${n === 1 ? 'Chat' : 'Chats'} · ${facts(p.facts)}`;
  };
  view.innerHTML = `<div class="page"><div class="page-inner narrow">
    <div class="page-head"><div><h1>Projekte</h1><p>Jedes Projekt hat eigene Anweisungen, eigene Chats und ein eigenes Gedächtnis.</p></div></div>
    <form class="ms-input mem-add" id="newProject">
      ${ic('plus', 17)}<input placeholder="Name des neuen Projekts" maxlength="80" aria-label="Name des neuen Projekts">
      <button class="btn primary sm" disabled>Erstellen</button>
    </form>
    ${state.projects.length ? `<div class="group">${state.projects.map(p => `
      <a class="row link" href="#/p/${p.id}">${ic('folder', 20)}
        <div class="grow"><b>${esc(p.name)}</b><small>${count(p)}</small></div>${ic('chevRight', 16)}</a>`).join('')}</div>` : ''}
  </div></div>`;
  const form = $('#newProject');
  const input = $('input', form);
  input.oninput = () => ($('button', form).disabled = !input.value.trim());
  form.onsubmit = async e => {
    e.preventDefault();
    const r = await api.post('projects/save', { name: input.value });
    if (r.project) location.hash = `#/p/${r.project.id}`;
    else toast(r.error || 'Das hat nicht geklappt.');
  };
  input.focus();
}

async function showProject(id) {
  if (panel.book) closePanel();
  if (!state.books.length) await loadBooks();
  await loadProjects();
  if (location.hash !== `#/p/${id}`) return; // the user moved on while it loaded
  const p = projectById(id);
  if (!p) {
    location.hash = '#/projects';
    return;
  }
  $('#topLeft').innerHTML = `<a class="btn ghost sm" href="#/projects">${ic('arrowLeft', 15)}Projekte</a>`;
  const c = createChat(null, id);
  c.root.classList.add('embedded');
  state.chat = c;
  const chats = Chats.all().filter(x => x.project === id);
  view.innerHTML = `<div class="page"><div class="page-inner narrow">
    <div class="page-head project-head">
      <h1 id="pName">${esc(p.name)}</h1>
      <button class="icon-btn" id="pRename" title="Umbenennen">${ic('edit', 17)}</button>
    </div>
    <div id="pComposer"></div>
    <div class="group-title">Chats</div>
    ${chats.length ? `<div class="group">${chats.map(x => `
      <a class="row link" href="#/c/${x.id}"><div class="grow"><b>${esc(x.title || 'Neuer Chat')}</b><small>${new Date(x.updated || x.created).toLocaleDateString('de-DE')}</small></div>${ic('chevRight', 16)}</a>`).join('')}</div>`
      : '<p class="faint sm section-note">Noch keine Chats. Schreib oben los.</p>'}
    <div class="group-title">Anweisungen <span>Gelten für jeden Chat in diesem Projekt</span></div>
    <textarea class="field" id="pInstructions" rows="4" maxlength="4000" placeholder="Zum Beispiel: Antworte kurz und in Stichpunkten. Es geht um unseren Hausbau in Kiel.">${esc(p.instructions)}</textarea>
    <div class="group-title">Gedächtnis <span>Nur Chats in diesem Projekt sehen diese Fakten</span></div>
    <div id="pMemory"></div>
    <div class="group-title">Projekt löschen</div>
    <div class="group"><div class="row"><div class="grow"><b>Anweisungen und Gedächtnis löschen</b><small>Die Chats bleiben und werden zu normalen Chats.</small></div>
      <button class="btn danger" id="pDelete">Löschen</button></div></div>
  </div></div>`;
  $('#pComposer').appendChild(c.root);
  renderChatList();
  mountModelPicker();
  c.applyCaps();
  c.focus();

  const saveProject = fields => api.post('projects/save', { id, ...fields });
  const instructions = $('#pInstructions');
  let timer = 0;
  let savedText = p.instructions;
  const saveInstructions = () => {
    clearTimeout(timer);
    if (instructions.value === savedText) return;
    savedText = instructions.value;
    saveProject({ instructions: savedText });
  };
  instructions.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(saveInstructions, 500);
  };
  instructions.onchange = saveInstructions;

  $('#pRename').onclick = () => {
    const h1 = $('#pName');
    const input = document.createElement('input');
    input.className = 'title-input';
    input.value = p.name;
    input.maxLength = 80;
    input.setAttribute('aria-label', 'Name des Projekts');
    h1.replaceWith(input);
    input.focus();
    input.select();
    const finish = async keep => {
      input.onblur = null;
      const name = input.value.trim();
      if (keep && name && name !== p.name) {
        const r = await saveProject({ name });
        if (r.project) p.name = r.project.name;
      }
      h1.textContent = p.name;
      input.replaceWith(h1);
    };
    input.onblur = () => finish(true);
    input.onkeydown = e => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    };
  };

  confirmClick($('#pDelete'), async () => {
    const r = await api.post('projects/delete', { id });
    if (!r.ok) return toast('Das hat nicht geklappt.');
    Chats.unlinkProject(id);
    await loadProjects();
    location.hash = '#/projects';
  });
  mountMemory($('#pMemory'), id);
}

// The list of facts of one project, or of the general memory: read, add, change, delete.
async function mountMemory(el, project) {
  const query = project ? `memory?project=${project}` : 'memory';
  const body = extra => ({ project, ...extra });
  const when = t => new Date(t * 1000).toLocaleDateString('de-DE');
  const draw = async () => {
    const r = await api.get(query);
    if (!el.isConnected) return;
    const facts = (r.facts || []).slice().reverse();
    el.innerHTML = `
      <form class="ms-input mem-add">
        ${ic('plus', 17)}<input placeholder="Selbst etwas eintragen" maxlength="300" aria-label="Fakt hinzufügen">
        <button class="btn sm" disabled>Merken</button>
      </form>
      ${facts.length ? `<div class="group">${facts.map(f => `
        <div class="row" data-fact="${f.id}">
          <div class="grow"><b class="mem-text">${esc(f.text)}</b><small>${f.source === 'chat' ? 'Aus einem Chat' : 'Von dir'} · ${when(f.created)}</small></div>
          <div class="acts">
            <button class="icon-btn" data-edit title="Ändern">${ic('edit', 16)}</button>
            <button class="icon-btn" data-remove title="Löschen">${ic('trash', 16)}</button>
          </div></div>`).join('')}</div>
        <div class="mem-clear"><button class="btn ghost sm danger" id="memClear">Alles löschen</button></div>`
      : '<p class="faint sm section-note">Noch nichts gespeichert. Erzähl in einem Chat etwas über dich oder sag „Merk dir …“.</p>'}`;
    const form = $('form', el);
    const input = $('input', form);
    input.oninput = () => ($('button', form).disabled = !input.value.trim());
    form.onsubmit = async e => {
      e.preventDefault();
      const added = await api.post('memory/add', body({ text: input.value }));
      if (!added.fact) toast('Das steht schon im Gedächtnis.');
      await draw();
      $('input', el)?.focus();
    };
    $$('[data-fact]', el).forEach(row => {
      const fid = row.dataset.fact;
      $('[data-remove]', row).onclick = async () => {
        await api.post('memory/delete', body({ id: fid }));
        draw();
      };
      $('[data-edit]', row).onclick = () => {
        const text = $('.mem-text', row);
        const edit = document.createElement('input');
        edit.className = 'mem-edit';
        edit.value = text.textContent;
        edit.maxLength = 300;
        edit.setAttribute('aria-label', 'Fakt ändern');
        text.replaceWith(edit);
        edit.focus();
        const finish = async keep => {
          edit.onblur = null;
          const value = edit.value.trim();
          if (keep && value && value !== text.textContent) await api.post('memory/edit', body({ id: fid, text: value }));
          draw();
        };
        edit.onblur = () => finish(true);
        edit.onkeydown = e => {
          if (e.key === 'Enter') finish(true);
          if (e.key === 'Escape') finish(false);
        };
      };
    });
    const clear = $('#memClear', el);
    if (clear) confirmClick(clear, async () => {
      await api.post('memory/clear', body());
      draw();
    });
  };
  await draw();
}

function renderMemorySettings(el) {
  el.innerHTML = `
    <div class="group-title">Allgemeines Gedächtnis <span>Für alle Chats ohne Projekt. Jedes Projekt hat sein eigenes.</span></div>
    <div id="memBox"></div>
    <p class="faint sm section-note">Liegt nur auf diesem Mac. Im Chat lässt es sich unter Optionen ausschalten.</p>`;
  return mountMemory($('#memBox', el), null);
}

/* ================================================================ power saving */

function batteryIcon(b, size = 18) {
  const fill = Math.max(1, Math.round((b.percent / 100) * 13));
  return `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="2" y="7" width="17" height="10" rx="2.5"/><path d="M22 11v2"/><rect x="4" y="9" width="${fill}" height="6" rx="1" fill="currentColor" stroke="none"/></svg>`;
}

async function loadPower() {
  const p = await api.get('power').catch(() => null);
  if (p && !p.error) state.power = p;
  renderPower();
}

function renderPower() {
  const p = state.power;
  const b = p?.battery;
  const btn = $('#powerBtn');
  btn.hidden = !state.projects || !p || (!b && !p.on);
  if (!btn.hidden) {
    const left = b?.minutes_left ? `, noch ${Math.floor(b.minutes_left / 60)}:${String(b.minutes_left % 60).padStart(2, '0')} h` : '';
    const level = b ? `Akku ${b.percent} %${b.charging ? ', lädt' : left}. ` : '';
    btn.innerHTML = `${b ? batteryIcon(b, 16) : ic('bulb', 16)}${b ? `<span>${b.percent} %</span>` : ''}`;
    btn.classList.toggle('on', p.on);
    btn.classList.toggle('low', !!b && b.on_battery && b.percent <= 20);
    btn.title = level + (p.on ? 'Stromsparen ist an. Klicken schaltet die KI wieder ein.' : 'Klicken: Stromsparen, die KI wird entladen und nur das Wissen läuft.');
    btn.setAttribute('aria-label', btn.title);
  }
  $('#powerBar').hidden = !p?.on || !['', 'c', 'code', 'p'].includes(state.view);
  $('#powerOff').hidden = !state.projects;
  state.chat?.applyCaps?.();
}

// Chat and Code are the same kind of thing: a box to write in. So they share one place to start.
const modeSwitch = mode => (state.projects
  ? `<div class="seg mode-seg"><a href="#/" class="${mode === 'chat' ? 'on' : ''}">Chat</a><a href="#/code" class="${mode === 'code' ? 'on' : ''}">Code</a></div>`
  : '');

async function setPowerSave(on) {
  const p = await api.post('power', { on }).catch(() => null);
  if (!p || p.error) return toast('Das hat nicht geklappt.');
  state.power = p;
  renderPower();
  toast(on ? 'Stromsparen an: Die KI ist entladen.' : 'Die KI ist wieder an.');
}
$('#powerBtn').onclick = () => setPowerSave(!state.power?.on);
$('#powerOff').onclick = () => setPowerSave(false);

/* ================================================================ emergency: warnings */

const WARN_STALE_SECS = 3600;
// wording of the Bavarian flood service, shortened
const STAGE_TEXT = {
  1: 'Stellenweise kleine Ausuferungen',
  2: 'Felder und Wälder überflutet oder leichte Verkehrsbehinderungen',
  3: 'Einzelne Grundstücke oder Keller überflutet, Sperrungen',
  4: 'Bebaute Gebiete in größerem Umfang überflutet',
};
const SEVERITY = {
  Extreme: ['Extreme Gefahr', 'high'],
  Severe: ['Gefahr', 'high'],
  Moderate: ['Warnung', 'mid'],
  Minor: ['Hinweis', 'low'],
};

const fmtAge = secs => {
  if (secs < 90) return 'gerade eben';
  if (secs < 3600) return `vor ${Math.round(secs / 60)} Min.`;
  if (secs < 172800) return `vor ${Math.round(secs / 3600)} Std.`;
  return `vor ${Math.round(secs / 86400)} Tagen`;
};

async function loadWarnings() {
  const w = await api.get('warnings').catch(() => null);
  if (!w || w.error) return;
  state.warn = w;
  const alert = w.warnings.some(x => x.severity !== 'Minor') || w.gauges.some(g => g.stage >= 1);
  $('#notfallDot').hidden = !alert;
  // Also when nothing new came in: offline the age must keep counting, or an old state looks current.
  const box = $('#warnBox');
  if (box && !$('.warn-setup', box)) renderWarnings(box);
}

// "All clear" only counts while the data is fresh. An old state must never read as safe.
function freshness(at, error, now) {
  const age = now - at;
  if (!at) return { stale: true, text: error ? `Noch kein Stand: ${error}` : 'Wird abgerufen …' };
  if (age > WARN_STALE_SECS) return { stale: true, text: `Stand ${fmtAge(age)}${error ? ` (${error})` : ''}. Kann veraltet sein.` };
  return { stale: false, text: `Stand ${fmtAge(age)}${error ? ` (letzter Versuch: ${error})` : ''}` };
}

function warningCard(w) {
  const [label, level] = SEVERITY[w.severity] || ['Warnung', 'mid'];
  const details = [w.text && `<p>${esc(w.text)}</p>`, w.area && `<p class="faint sm">${esc(w.area)}</p>`].filter(Boolean).join('');
  return `<div class="warn-card ${level}">
    <div class="warn-head">${ic('alert', 18)}<div class="grow"><b>${esc(w.title || label)}</b><small>${label} · ${esc(w.source)}</small></div></div>
    ${w.instruction ? `<div class="warn-do"><b>Was tun</b><p>${esc(w.instruction)}</p></div>` : ''}
    ${details ? `<details class="warn-more" data-key="${esc(w.id)}"><summary>Details</summary>${details}</details>` : ''}
  </div>`;
}

function gaugeGroups(gauges) {
  const rivers = [];
  for (const g of gauges) {
    let r = rivers.find(x => x.name === g.river);
    if (!r) rivers.push((r = { name: g.river, gauges: [] }));
    r.gauges.push(g);
  }
  return rivers;
}

function gaugeRow(g) {
  const stage = g.stage ?? -1;
  const state = g.level === null ? 'Keine aktuellen Daten' : g.stage === null ? 'Ohne Meldestufe' : stage === 0 ? 'Unter Meldestufe 1' : `Meldestufe ${stage}`;
  return `<div class="row gauge ${stage >= 3 ? 'high' : stage >= 1 ? 'mid' : ''}">
    <div class="grow"><b>${esc(g.name)}</b><small>${[STAGE_TEXT[stage], g.level === null ? '' : g.at].filter(Boolean).map(esc).join(' · ')}</small></div>
    <div class="gauge-val"><b>${g.level === null ? '–' : `${g.level} cm`}</b><small>${state}</small></div></div>`;
}

function renderGauges(w, stale) {
  if (!w.gauges.length) return '';
  const groups = gaugeGroups(w.gauges).sort((a, b) => Math.max(...b.gauges.map(g => g.stage || 0)) - Math.max(...a.gauges.map(g => g.stage || 0)));
  return groups.map(r => {
    const top = Math.max(...r.gauges.map(g => g.stage || 0));
    const n = r.gauges.length;
    const live = r.gauges.filter(g => g.level !== null).length;
    const sum = top >= 1 ? `Bis Meldestufe ${top}`
      : !live ? 'Keine aktuellen Daten'
      : `${live === n ? `${n} Pegel` : `${live} von ${n} Pegeln melden`}, ${stale ? 'beim letzten Abruf ' : ''}keine Meldestufe gemeldet`;
    return `<details class="gauges" data-key="${esc(r.name)}" ${top >= 1 || n <= 4 ? 'open' : ''}><summary>${ic('wave', 17)}<b>${esc(r.name)}</b><span>${sum}</span>${ic('chevDown', 15)}</summary>
      <div class="group">${r.gauges.map(gaugeRow).join('')}</div></details>`;
  }).join('');
}

function renderWarningOffer(el) {
  el.innerHTML = `<div class="group"><div class="row"><div class="grow"><b>Warnungen für eure Gegend</b><small>NINA, Wetter und Hochwasser. Der letzte Stand bleibt auch offline lesbar.</small></div>
    <button type="button" class="btn" id="warnStart">Einschalten</button></div></div>`;
  $('#warnStart', el).onclick = () => renderWarningSetup(el, state.warn);
}

function renderWarningSetup(el, w) {
  const configured = !!(w.regions.length || w.flood);
  const regions = [...w.regions];
  let flood = w.flood;
  let floodChosen = configured;
  const inFloodArea = () => regions.some(r => w.flood_regions.some(prefix => r.id.startsWith(prefix)));
  const paint = () => {
    if (!floodChosen) flood = inFloodArea(); // on by itself where these rivers matter
    el.innerHTML = `<div class="group warn-setup">
      <div class="row region-row"><div class="grow"><b>Dein Kreis oder deine Stadt</b><small>Du kannst mehrere wählen, zum Beispiel Stadt und Landkreis.</small>
        <div class="region-chips">${regions.map((r, i) => `<span class="chip">${esc(r.name)}<button type="button" data-remove="${i}" title="Entfernen">${ic('x', 13)}</button></span>`).join('')}</div>
        <div class="region-search"><div class="ms-input">${ic('search', 16)}<input placeholder="Zum Beispiel Bamberg" aria-label="Kreis oder Stadt suchen" autocomplete="off"></div><div class="region-hits"></div></div></div></div>
      ${inFloodArea() || flood ? `<div class="row"><div class="grow"><b>Hochwasser an ${esc(w.flood_rivers.join(' und '))}</b><small>Warnungen und Pegel</small></div>
        <button type="button" class="switch-row" role="switch" aria-checked="${flood}" aria-label="Hochwasser" id="floodSwitch"><span class="switch"></span></button></div>` : ''}
      <div class="row warn-setup-foot"><div class="grow"><small>Fragt alle 15 Minuten warnung.bund.de und hnd.bayern.de und sendet nur den Kreis. Basecamp meldet sich nicht von selbst und ersetzt nicht die NINA-App.</small></div>
        <button type="button" class="btn ghost" id="warnCancel">Abbrechen</button>
        <button type="button" class="btn primary" id="warnSave" ${!configured && !regions.length && !flood ? 'disabled' : ''}>${configured ? 'Speichern' : 'Einschalten'}</button></div>
    </div>`;
    $$('[data-remove]', el).forEach(b => (b.onclick = () => { regions.splice(+b.dataset.remove, 1); paint(); }));
    if ($('#floodSwitch', el)) $('#floodSwitch', el).onclick = () => { floodChosen = true; flood = !flood; paint(); };
    $('#warnCancel', el).onclick = () => renderWarnings(el);
    $('#warnSave', el).onclick = async () => {
      state.warn = await api.post('warnings/settings', { regions, flood });
      renderWarnings(el);
      pollWarningsSoon();
    };
    const input = $('.region-search input', el);
    const hits = $('.region-hits', el);
    let timer = 0;
    input.oninput = () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { hits.innerHTML = ''; return; }
      timer = setTimeout(async () => {
        const r = await api.get(`warnings/regions?q=${encodeURIComponent(q)}`).catch(() => ({ error: 'Dafür braucht es einmal Internet.' }));
        if (input.value.trim() !== q) return;
        if (r.error) { hits.innerHTML = `<p class="faint sm">${esc(r.error)}</p>`; return; }
        hits.innerHTML = (r.regions || []).length ? r.regions.map(x => `<button type="button" class="menu-item" data-id="${esc(x.id)}" data-name="${esc(x.name)}"><div class="grow"><b>${esc(x.name)}</b></div></button>`).join('') : '<p class="faint sm">Nichts gefunden.</p>';
        $$('[data-id]', hits).forEach(b => (b.onclick = () => {
          if (regions.length < 5 && !regions.some(x => x.id === b.dataset.id)) regions.push({ id: b.dataset.id, name: b.dataset.name });
          paint();
          $('.region-search input', el).focus();
        }));
      }, 200);
    };
  };
  paint();
}

function renderWarnings(el) {
  const w = state.warn;
  if (!el || !w) return;
  if (!w.regions.length && !w.flood) {
    if (!state.projects) { el.innerHTML = '<p class="faint sm section-note">Warnungen lassen sich direkt auf dem Mac einrichten.</p>'; return; }
    return renderWarningOffer(el);
  }
  const f = freshness(w.warnings_at, w.warnings_error, w.now);
  const g = w.flood ? freshness(w.gauges_at, w.gauges_error, w.now) : null;
  const top = Math.max(0, ...w.gauges.map(x => x.stage || 0));
  const clear = !w.warnings.length && w.warnings_at && !top;
  const area = w.regions.map(r => r.name).join(', ') || w.flood_rivers.join(' und ');
  const head = !w.warnings_at ? f.text
    : w.warnings.length ? `${w.warnings.length} ${w.warnings.length === 1 ? 'aktive Warnung' : 'aktive Warnungen'} für ${area}`
    : top ? `Keine amtliche Warnung, aber ein Pegel auf Meldestufe ${top}`
    : f.stale ? `Beim letzten Abruf keine Warnungen für ${area}` : `Keine aktuellen Warnungen für ${area}`;
  const open = new Map($$('details[data-key]', el).map(d => [d.dataset.key, d.open]));
  el.innerHTML = `
    <div class="warn-status ${f.stale ? 'stale' : clear ? 'clear' : ''}">
      <i>${ic(f.stale || !clear ? 'alert' : 'check', 18)}</i>
      <div class="grow"><b>${esc(head)}</b><small>${w.warnings_at ? `${esc(f.text)} · ` : ''}NINA, DWD${w.flood ? ', Hochwasserportal' : ''}</small></div>
      ${state.projects ? `<button class="btn ghost sm" id="warnRefresh" ${w.checking ? 'disabled' : ''}>${w.checking ? 'Ruft ab …' : 'Aktualisieren'}</button>
      <button class="icon-btn" id="warnEdit" title="Ändern">${ic('settings', 16)}</button>` : ''}
    </div>
    ${w.warnings.map(warningCard).join('')}
    ${g ? `<div class="group-title warn-gauges">Pegel <span class="${g.stale ? 'warn-stale' : ''}">${esc(g.text)} · Hochwassernachrichtendienst Bayern</span></div>${renderGauges(w, g.stale)}` : ''}`;
  $$('details[data-key]', el).forEach(d => { if (open.has(d.dataset.key)) d.open = open.get(d.dataset.key); });
  if ($('#warnRefresh', el)) $('#warnRefresh', el).onclick = async () => {
    state.warn = await api.post('warnings/refresh');
    renderWarnings(el);
    pollWarningsSoon();
  };
  if ($('#warnEdit', el)) $('#warnEdit', el).onclick = () => renderWarningSetup(el, w);
}

// after a request the worker needs a moment: look again a few times
function pollWarningsSoon() {
  for (const ms of [1000, 3000, 7000, 15000, 30000]) setTimeout(loadWarnings, ms);
}

/* ================================================================ emergency: plan */

const EMERGENCY_NUMBERS = [
  ['112', 'Feuerwehr und Rettungsdienst'],
  ['110', 'Polizei'],
  ['116 117', 'Ärztlicher Bereitschaftsdienst'],
];

// One tap each. What a choice means is written by hand, so it works without a model and invents nothing.
const HOUSEHOLD_CHOICES = [
  ['pets', 'Haustiere', 'Haustiere: Leine oder Box, Futter und Impfpass griffbereit legen.'],
  ['cellar', 'Keller oder Erdgeschoss', 'Keller oder Erdgeschoss: Wichtiges früh nach oben bringen. Bei Hochwasser nicht in den Keller.'],
  ['water', 'Nah am Wasser', 'Nah am Wasser: Warnungen ernst nehmen und früh gehen, nicht erst, wenn das Wasser da ist.'],
  ['high', 'Weit oben', 'Weit oben: Vorher klären, wer beim Treppensteigen und Tragen hilft.'],
  ['gas', 'Gasheizung oder Gasherd', 'Bei Gasgeruch: kein Licht und keine Schalter, Fenster auf, raus, draußen 112 anrufen.'],
  ['electric', 'Elektroherd', 'Ohne Strom kein Herd: Essen bereithalten, das man nicht kochen muss.'],
  ['nocar', 'Kein Auto', 'Kein Auto: Früh klären, wer euch mitnimmt, und rechtzeitig aufbrechen.'],
];

// Written by hand, not by a model, from the advice of the German civil protection office (BBK).
const PLAN_TEMPLATE = `## Zuerst
- Ruhe bewahren und die Lage prüfen. Bei Lebensgefahr: 112.
- Radio einschalten und die Warnungen hier prüfen.
- Alle im Haushalt informieren.
- Kontakte kurz melden. Eine SMS kommt oft noch durch, wenn Anrufe nicht gehen.
- Erreichen wir uns nicht, gehen alle zum Treffpunkt.

## Stromausfall
- Taschenlampen statt Kerzen nutzen.
- Kühlschrank und Gefrierschrank geschlossen halten.
- Empfindliche Geräte ausstecken.
- Handy sparsam nutzen und Powerbank bereithalten.
- Nie drinnen mit Grill oder Gasbrenner heizen oder kochen. Kohlenmonoxid ist tödlich.

## Hochwasser und Unwetter
- Keller und Tiefgaragen nicht betreten. Dort besteht Lebensgefahr.
- Wichtige Sachen und Medikamente nach oben bringen.
- Nicht durch Wasser gehen oder fahren.
- Bei Gewitter drinnen bleiben und Fenster schließen.

## Feuer
- Alle warnen und sofort raus. Keinen Aufzug nehmen.
- Türen hinter sich schließen.
- Draußen 112 anrufen. Nicht zurückgehen.

## Haus verlassen
- Notgepäck, Dokumentenmappe und Medikamente mitnehmen.
- Fenster und Türen schließen, Strom und Gas abstellen, wenn das gefahrlos geht.
- Nachbarn Bescheid sagen, die Hilfe brauchen.
- Zum Treffpunkt gehen und Kontakte melden.

## Vorrat
- Essen und Trinken für 10 Tage. 3 Tage sind ein guter Anfang.
- 2 Liter Trinken pro Person und Tag, also 20 Liter für 10 Tage.
- Medikamente, Erste-Hilfe-Set, Taschenlampe, Batterien, Radio, Bargeld.
- Dokumentenmappe griffbereit, Notgepäck fertig gepackt.`;

function householdPlan(s) {
  const kids = +s.kids || 0;
  const persons = (+s.adults || 0) + kids;
  const points = [];
  if (persons) points.push(`Vorrat für ${persons} ${persons === 1 ? 'Person' : 'Personen'}: ${persons * 20} Liter Trinken für 10 Tage.`);
  if (s.needs?.trim()) points.push(`Zuerst daran denken: ${s.needs.trim()}. Mit Arzt oder Apotheke klären, was bei Stromausfall zu tun ist.`);
  if (kids) points.push('Kinder: Treffpunkt und Kontaktnummer üben. Ihre Papiere und etwas zum Beschäftigen ins Notgepäck.');
  for (const [k, , point] of HOUSEHOLD_CHOICES) if (s[k]) points.push(point);
  return points;
}

const fullTemplate = setup => {
  const points = householdPlan(setup);
  return points.length ? `${PLAN_TEMPLATE}\n\n## Für unseren Haushalt\n${points.map(x => `- ${x}`).join('\n')}` : PLAN_TEMPLATE;
};

// There is always a plan. It follows the answers until someone writes their own.
const currentPlan = d => (d.plan?.trim() ? d.plan : fullTemplate(d.setup || {}));

const hasPersonalData = d => !!(d.contacts?.length || d.people?.length || d.plan?.trim() || Object.values(d.setup || {}).some(Boolean));

const householdLines = s => [
  +s.adults ? `- Erwachsene: ${s.adults}` : '',
  +s.kids ? `- Kinder: ${s.kids}` : '',
  ...HOUSEHOLD_CHOICES.filter(([k]) => s[k]).map(([, label]) => `- ${label}`),
  s.needs?.trim() ? `- Besonderes: ${s.needs.trim()}` : '',
].filter(Boolean);

// Only for copying into an AI the person picks. There is no button for the local model on purpose: it
// wrote dangerous advice even with tight rules, like insulin in a cellar that floods or gas heaters indoors.
function planPrompt(setup) {
  return `Hier ist ein Haushalt in Deutschland:

${householdLines(setup).join('\n') || '- Keine Angaben'}

Er hat schon einen allgemeinen Notfallplan für Stromausfall, Hochwasser, Feuer, Haus verlassen und Vorrat. Schreib eine kurze Liste mit dem, was für genau diesen Haushalt dazukommt.

Regeln:
- 3 bis 8 Punkte auf Deutsch. Jeder Punkt ist eine kurze Anweisung ohne Anrede und beginnt mit "- ".
- Jeder Punkt muss direkt aus einer Angabe oben folgen.
- Nur was der Haushalt bereitlegen oder im Notfall tun soll. Keine Umbauten, keine neue Technik, keine Behörden oder Verträge.
- Nur vernünftige, allgemein bekannte Ratschläge. Bist du unsicher, lass den Punkt weg.
- Erfinde keine Telefonnummern, Namen, Adressen oder Orte.
- Keine Überschriften, keine Einleitung, kein Schluss.`;
}

const NOTFALL_STEPS = [
  { key: 'haushalt', title: 'Euer Zuhause', note: 'Tippt an, was stimmt. Daraus wird euer Plan.', mount: mountHousehold },
  { key: 'treffpunkte', title: 'Wo trefft ihr euch?', note: 'Wenn das Handy nicht geht, weiß trotzdem jeder, wohin.', mount: mountMeetings },
  { key: 'kontakte', title: 'Wen ruft ihr an?', note: 'Am besten auch jemanden außerhalb der Region.', mount: mountContacts },
  { key: 'personen', title: 'Was müssen Helfer wissen?', note: 'Medikamente, Allergien, Krankheiten, Hausarzt. Nur wenn es etwas gibt, überspringen ist völlig in Ordnung.', mount: mountPeople },
];

let notfallRun = 0;

async function showNotfall(edit, flow, saving) {
  if (panel.book) closePanel();
  const run = ++notfallRun;
  await saving;
  let data = state.projects ? await api.get('emergency').catch(() => null) : {};
  // A failed read must never open a form: saving it would replace the real plan with an empty one.
  const local = !!state.projects && !!data && !data.error;
  if (!local) data = {};
  await loadWarnings();
  if (run !== notfallRun || state.view !== 'notfall') return;
  if (edit && local) return edit === 'plan' ? renderPlanEditor(data) : renderNotfallStep(data, edit, flow);
  renderNotfallPage(data, local);
}

function renderNotfallPage(data, local) {
  const setup = data.setup || {};
  const contacts = data.contacts || [];
  const people = data.people || [];
  const personal = hasPersonalData(data);
  const change = (step, label = 'Ändern') => (local ? `<a class="sec-change no-print" href="#/notfall?edit=${step}">${label}</a>` : '');
  const head = (title, links, note = '') => `<div class="sec-head"><div class="group-title">${title}${note ? ` <span>${note}</span>` : ''}</div><div class="sec-links">${links}</div></div>`;
  const place = (label, value) => (value ? `<div class="row"><div class="grow"><b>${esc(value)}</b><small>${label}</small></div></div>` : '');
  const open = local && personal ? [
    !(setup.near || setup.far) && ['treffpunkte', 'Treffpunkte eintragen'],
    !contacts.length && ['kontakte', 'Kontakte eintragen'],
    !people.length && ['personen', 'Eintragen, was Helfer wissen müssen'],
  ].filter(Boolean) : [];
  view.innerHTML = `<div class="page notfall"><div class="page-inner narrow">
    <div class="page-head">
      <div class="grow"><h1>Notfall</h1><p class="print-only">Notfallplan${data.updated ? ` · Stand ${new Date(data.updated * 1000).toLocaleDateString('de-DE')}` : ''}</p></div>
      ${local ? `<div class="page-acts no-print"><button class="btn" id="eprint">${ic('printer', 15)}Drucken oder PDF</button></div>` : ''}
    </div>
    <div class="group numbers">${EMERGENCY_NUMBERS.map(([n, label]) => `<a class="row number" href="tel:${n.replace(/\s/g, '')}">${ic('phone', 18)}<b>${n}</b><span>${label}</span></a>`).join('')}</div>
    ${setup.home ? `<div class="group">${place('Eure Adresse für den Notruf', setup.home)}</div>` : ''}
    <div class="no-print"><div class="group-title">Warnungen</div><div id="warnBox"></div></div>
    ${local && !personal ? `<div class="group no-print notfall-cta"><div class="row"><div class="grow"><b>Macht den Plan zu eurem</b><small>4 kurze Fragen, etwa 2 Minuten. Alles bleibt auf diesem Mac.</small></div><a class="btn primary" href="#/notfall?edit=haushalt&flow=1">Los geht's</a></div></div>` : ''}
    ${!local ? `<p class="faint sm section-note">${state.projects ? 'Euer Plan ließ sich gerade nicht laden. Lade die Seite neu.' : 'Eure Kontakte und Treffpunkte sind nur direkt auf dem Mac zu sehen.'}</p>` : ''}
    ${setup.near || setup.far ? `${head('Treffpunkte', change('treffpunkte'))}<div class="group">${place('In der Nähe', setup.near)}${place('Außerhalb', setup.far)}</div>` : ''}
    ${contacts.length ? `${head('Kontakte', change('kontakte'))}<div class="group">${contacts.map(c => `<div class="row"><div class="grow"><b>${esc(c.name || 'Kontakt')}</b></div>${c.phone ? `<a class="tel" href="tel:${esc(c.phone.replace(/[^+\d]/g, ''))}">${esc(c.phone)}</a>` : ''}</div>`).join('')}</div>` : ''}
    ${people.length ? `${head('Was Helfer wissen müssen', change('personen'))}<div class="group">${people.map(x => `<div class="row"><div class="grow"><b>${esc(x.name || 'Ohne Name')}</b>${x.info ? `<small>${esc(x.info)}</small>` : ''}</div></div>`).join('')}</div>` : ''}
    ${open.length ? `<div class="no-print"><div class="group-title">Noch offen</div><div class="group">${open.map(([step, label]) => `<a class="row link add-row" href="#/notfall?edit=${step}">${ic('plus', 16)}<span>${label}</span></a>`).join('')}</div></div>` : ''}
    ${head('Plan', `${personal ? change('haushalt', 'Angaben ändern') : ''}${change('plan', 'Anpassen')}`, data.plan?.trim() ? 'Selbst angepasst' : 'Nach den Empfehlungen des BBK')}
    <div class="group plan-text"><div class="md">${md(currentPlan(data))}</div></div>
  </div></div>`;
  renderWarnings($('#warnBox'));
  const printBtn = $('#eprint');
  if (printBtn) printBtn.onclick = () => {
    const title = document.title;
    document.title = 'Notfallplan';
    window.print();
    document.title = title;
  };
}

// Saves shortly after each change, one save after the other, so an older save can never win.
function emergencySaver(data) {
  let timer = 0;
  let dirty = false;
  let saves = Promise.resolve();
  const now = () => {
    clearTimeout(timer);
    if (!dirty) return saves;
    dirty = false;
    saves = saves.then(() => api.post('emergency/save', data).catch(() => null)).then(r => {
      const status = $('#saveState');
      if (status) status.textContent = r?.ok ? 'Gespeichert' : 'Nicht gespeichert';
      if (!r?.ok) { dirty = true; if (!status) toast('Notfalldaten nicht gespeichert.'); }
    });
    return saves;
  };
  const later = () => {
    dirty = true;
    const status = $('#saveState');
    if (status) status.textContent = '';
    clearTimeout(timer);
    timer = setTimeout(now, 500);
  };
  return { now, later };
}

const textField = (k, label, placeholder, value) => `<label class="ef"><span>${esc(label)}</span><input data-k="${k}" value="${esc(value || '')}" placeholder="${esc(placeholder)}" maxlength="500"></label>`;

function mountHousehold(el, data, changed) {
  const s = data.setup;
  const counter = (k, label, value) => `<div class="count" data-k="${k}"><span>${label}</span><button type="button" data-d="-1" aria-label="${label}: weniger">−</button><b>${value}</b><button type="button" data-d="1" aria-label="${label}: mehr">+</button></div>`;
  // the counter shows one adult from the start, so any answer here confirms that number
  const touched = () => { if (!s.adults) s.adults = '1'; changed(); };
  el.innerHTML = `
    <div class="counts">${counter('adults', 'Erwachsene', +s.adults || 1)}${counter('kids', 'Kinder', +s.kids || 0)}</div>
    <div class="taps">${HOUSEHOLD_CHOICES.map(([k, label]) => `<button type="button" class="tap" data-k="${k}" aria-pressed="${!!s[k]}">${esc(label)}</button>`).join('')}</div>
    ${textField('needs', 'Braucht jemand etwas Besonderes?', 'Zum Beispiel Insulin, Rollator', s.needs)}
    ${textField('home', 'Eure Adresse, für den Notruf', 'Straße, Ort', s.home)}`;
  $$('.count', el).forEach(box => {
    const k = box.dataset.k;
    const out = $('b', box);
    $$('button', box).forEach(b => (b.onclick = () => {
      const value = Math.max(k === 'adults' ? 1 : 0, Math.min(20, +out.textContent + +b.dataset.d));
      out.textContent = value;
      s[k] = String(value);
      touched();
    }));
  });
  $$('.tap', el).forEach(b => (b.onclick = () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', on);
    s[b.dataset.k] = on ? '1' : '';
    touched();
  }));
  $$('input', el).forEach(i => (i.oninput = () => { s[i.dataset.k] = i.value; touched(); }));
  return () => !!s.adults;
}

function mountMeetings(el, data, changed) {
  const s = data.setup;
  el.innerHTML = textField('near', 'In der Nähe', 'Zum Beispiel Spielplatz an der Ecke', s.near)
    + textField('far', 'Außerhalb, falls ihr weg müsst', 'Zum Beispiel bei Oma in Erlangen', s.far);
  $$('input', el).forEach(i => (i.oninput = () => { s[i.dataset.k] = i.value; changed(); }));
  return () => !!(s.near?.trim() || s.far?.trim());
}

function mountRows(el, rows, fields, seed, wide, changed) {
  while (rows.length < seed) rows.push({});
  const paint = () => {
    el.innerHTML = `${rows.map((row, i) => `<div class="input-row ${wide ? 'wide' : ''}" data-i="${i}">
        ${fields.map(([k, label, type, hint]) => `<input data-k="${k}" ${type ? `type="${type}"` : ''} aria-label="${esc(label)}" placeholder="${esc(hint || label)}" value="${esc(row[k] || '')}" maxlength="500">`).join('')}
        <button type="button" class="icon-btn" data-del title="Entfernen" aria-label="Entfernen">${ic('trash', 16)}</button></div>`).join('')}
      <button type="button" class="btn" data-add>${ic('plus', 15)}Noch jemand</button>`;
    $$('.input-row', el).forEach(line => {
      const i = +line.dataset.i;
      $$('input', line).forEach(input => (input.oninput = () => { rows[i][input.dataset.k] = input.value; changed(); }));
      $('[data-del]', line).onclick = () => {
        rows.splice(i, 1);
        if (!rows.length) rows.push({});
        paint();
        changed();
      };
    });
    $('[data-add]', el).onclick = () => {
      rows.push({});
      paint();
      $$('.input-row', el).at(-1).querySelector('input').focus();
    };
  };
  paint();
  return () => rows.some(r => Object.values(r).some(v => String(v || '').trim()));
}

function mountContacts(el, data, changed) {
  return mountRows(el, data.contacts, [['name', 'Name'], ['phone', 'Telefonnummer', 'tel']], 2, false, changed);
}

function mountPeople(el, data, changed) {
  const seed = Math.max(1, Math.min(6, (+data.setup.adults || 0) + (+data.setup.kids || 0)));
  return mountRows(el, data.people, [['name', 'Name'], ['info', 'Was Helfer wissen müssen', '', 'Zum Beispiel Insulin, Hausarzt']], seed, true, changed);
}

function renderNotfallStep(data, key, flow) {
  const i = NOTFALL_STEPS.findIndex(x => x.key === key);
  if (i < 0) {
    location.hash = '#/notfall';
    return;
  }
  const step = NOTFALL_STEPS[i];
  const link = n => `#/notfall?edit=${NOTFALL_STEPS[n].key}&flow=1`;
  const last = !flow || i === NOTFALL_STEPS.length - 1;
  data.setup = data.setup || {};
  data.contacts = data.contacts || [];
  data.people = data.people || [];
  $('#topLeft').innerHTML = `<a class="btn ghost sm" href="#/notfall">${ic('arrowLeft', 15)}Notfall</a>`;
  view.innerHTML = `<div class="page notfall-step"><div class="page-inner narrow">
    ${flow ? `<div class="step-meter"><span>Frage ${i + 1} von ${NOTFALL_STEPS.length}</span><div class="bar"><i style="width:${((i + 1) / NOTFALL_STEPS.length) * 100}%"></i></div></div>` : ''}
    <h1>${step.title}</h1>
    <p class="step-note">${step.note}</p>
    <div class="step-body" id="stepBody"></div>
    <div class="step-foot">
      ${flow && i ? `<a class="btn ghost" href="${link(i - 1)}">Zurück</a>` : ''}
      <span class="spacer"></span>
      <span class="faint sm" id="saveState"></span>
      <a class="btn primary" id="stepNext" href="${last ? '#/notfall' : link(i + 1)}"></a>
    </div>
  </div></div>`;
  const saver = emergencySaver(data);
  const next = $('#stepNext');
  const body = $('#stepBody');
  const label = () => { next.textContent = last ? 'Fertig' : filled() ? 'Weiter' : 'Überspringen'; };
  const filled = step.mount(body, data, () => { saver.later(); label(); });
  label();
  body.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') next.click(); });
  if (i && innerWidth > 900) $('input', body)?.focus();
  leaveNotfall = saver.now;
}

function renderPlanEditor(data) {
  data.setup = data.setup || {};
  $('#topLeft').innerHTML = `<a class="btn ghost sm" href="#/notfall">${ic('arrowLeft', 15)}Notfall</a>`;
  view.innerHTML = `<div class="page notfall-step"><div class="page-inner narrow">
    <h1>Plan anpassen</h1>
    <p class="step-note">Kurze Stichpunkte reichen. <code class="path">## Titel</code> macht eine Überschrift, <code class="path">- </code> einen Punkt.</p>
    <textarea class="field" id="ePlan" rows="20" maxlength="30000" aria-label="Plan"></textarea>
    <details class="plan-ai"><summary>Mit KI ergänzen</summary>
      <p class="faint sm">Kopier den Prompt und füg ihn in eine KI deiner Wahl ein. Er enthält nur die Antworten zu eurem Zuhause, ohne Adresse. Bei einer Online-KI verlassen sie deinen Mac. KI schreibt hier auch Falsches und Gefährliches, also prüf jeden Punkt, bevor du ihn übernimmst.</p>
      <button type="button" class="btn" id="pCopy">${ic('copy', 15)}Prompt kopieren</button>
    </details>
    <div class="step-foot">
      <button type="button" class="btn ghost" id="pReset">Zurück zur Vorlage</button>
      <span class="spacer"></span>
      <span class="faint sm" id="saveState"></span>
      <a class="btn primary" href="#/notfall">Fertig</a>
    </div>
  </div></div>`;
  const plan = $('#ePlan');
  const reset = $('#pReset');
  const saver = emergencySaver(data);
  plan.value = currentPlan(data);
  const sync = () => {
    // unchanged text stays automatic, so it keeps following the answers
    data.plan = plan.value.trim() === fullTemplate(data.setup).trim() ? '' : plan.value;
    reset.hidden = !data.plan;
    saver.later();
  };
  reset.hidden = !data.plan?.trim();
  plan.oninput = sync;

  let armed = 0;
  reset.onclick = () => {
    if (!armed) {
      reset.textContent = 'Plan ersetzen?';
      armed = setTimeout(() => { armed = 0; reset.textContent = 'Zurück zur Vorlage'; }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    reset.textContent = 'Zurück zur Vorlage';
    plan.value = fullTemplate(data.setup);
    sync();
  };
  $('#pCopy').onclick = () => copyText(planPrompt(data.setup));

  leaveNotfall = saver.now;
}

/* ================================================================ bible */

const BIBLE_PREFIX = 'bibel_';
const BIBLE_PARTS = [
  ['Altes Testament', [
    ['Die fünf Bücher Mose', ['GEN', 'EXO', 'LEV', 'NUM', 'DEU']],
    ['Geschichte', ['JOS', 'JDG', 'RUT', '1SA', '2SA', '1KI', '2KI', '1CH', '2CH', 'EZR', 'NEH', 'EST']],
    ['Psalmen und Weisheit', ['JOB', 'PSA', 'PRO', 'ECC', 'SNG']],
    ['Propheten', ['ISA', 'JER', 'LAM', 'EZK', 'DAN', 'HOS', 'JOL', 'AMO', 'OBA', 'JON', 'MIC', 'NAM', 'HAB', 'ZEP', 'HAG', 'ZEC', 'MAL']],
  ]],
  ['Neues Testament', [
    ['Evangelien und Apostelgeschichte', ['MAT', 'MRK', 'LUK', 'JHN', 'ACT']],
    ['Briefe', ['ROM', '1CO', '2CO', 'GAL', 'EPH', 'PHP', 'COL', '1TH', '2TH', '1TI', '2TI', 'TIT', 'PHM', 'HEB', 'JAS', '1PE', '2PE', '1JN', '2JN', '3JN', 'JUD']],
    ['Offenbarung', ['REV']],
  ]],
];
const BIBLE_POEMS = new Set(['PSA', 'PRO', 'SNG', 'LAM']); // read line by line, also where the source has one long paragraph
const BIBLE_SIZES = [17, 19, 22];
const bible = { meta: null, run: 0, nav: null, current: null, picked: new Set() };

const bibleHref = (t, b, c, v) => `#/bibel/${t}${b ? `/${b}/${c}${v ? `?v=${v}` : ''}` : ''}`;
const bibleTitle = (book, c) => `${book.id === 'PSA' ? 'Psalm' : book.name} ${c}`;
const bibleLayout = () => store.get('bibleLayout', 'flow');

function bibleHrefOf(id, article) {
  const m = /^([1-3A-Z]{3})\.(\d+)$/.exec(article);
  return bibleHref(id.slice(BIBLE_PREFIX.length), m?.[1], m?.[2]);
}

function markWords(text, words) {
  if (!words.length) return esc(text);
  const part = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ss/g, '(?:ss|ß)');
  const start = '(?<![\\p{L}\\p{N}])';
  const phrase = new RegExp(`${start}${words.map(part).join('[\\s,;:]+')}`, 'giu');
  const long = words.filter(w => w.length > 3);
  const re = words.length > 1 && phrase.test(text)
    ? phrase
    : new RegExp(`${start}(?:${(long.length ? long : words).map(part).join('|')})[\\p{L}\\p{N}]*`, 'giu');
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += `${esc(text.slice(last, m.index))}<mark>${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

// A verse only counts once, even if the source starts a new paragraph inside it.
function bibleVerses(blocks) {
  const verses = new Map();
  for (const [, rows] of blocks) for (const [v, text] of rows) verses.set(v, verses.has(v) ? `${verses.get(v)} ${text}` : text);
  return verses;
}

function verseRanges(list) {
  const parts = [];
  for (const v of [...list].sort((a, b) => a - b)) {
    const last = parts.at(-1);
    if (last && last[1] === v - 1) last[1] = v;
    else parts.push([v, v]);
  }
  return parts.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join('.');
}

async function showBible(code, b, c, params) {
  if (panel.book) closePanel();
  const run = ++bible.run;
  bible.nav = null;
  bible.current = null;
  bible.picked = new Set();
  const stale = () => run !== bible.run || state.view !== 'bibel';
  bible.meta ||= await api.get('bible').catch(() => null);
  if (stale()) return;
  const meta = bible.meta;
  const have = meta?.translations.filter(t => t.installed) || [];
  if (!have.length) return renderBibleEmpty(meta);
  const last = store.get('bibleLast', null);
  const t = have.find(x => x.code === code) || have.find(x => x.code === last?.t) || have[0];
  const book = meta.books.find(x => x.id === b);
  const chapter = +c;
  if (!book || !(chapter >= 1 && chapter <= book.verses.length)) return renderBibleHome(meta, have, t, params.get('q') || '');
  const other = have.find(x => x.code === store.get('bibleWith', '') && x !== t) || null;
  const load = x => api.get(`bible/chapter?t=${encodeURIComponent(x.code)}&b=${book.id}&c=${chapter}`);
  const [main, second] = await Promise.all([load(t), other && load(other)]).catch(() => []);
  if (stale()) return;
  if (!main?.blocks || (other && !second?.blocks)) {
    toast('Dieses Kapitel ließ sich nicht laden.');
    return renderBibleHome(meta, have, t, '');
  }
  store.set('bibleLast', { t: t.code, b: book.id, c: chapter });
  renderBibleChapter({ meta, have, t, other, book, c: chapter, main, second, target: params.get('v') });
}

function renderBibleEmpty(meta) {
  const list = meta?.translations || [];
  const names = list.map(t => t.title).join(' und ');
  view.innerHTML = `<div class="page bible-home"><div class="page-inner narrow bible-empty">
    <h1>Die Bibel</h1>
    <p>${list.length ? `${esc(names)}, vollständig. Zusammen etwa 7 MB, danach ohne Internet lesbar.` : 'Die Bibel ließ sich gerade nicht laden.'}</p>
    ${list.length && state.projects ? '<button class="btn primary" id="bibleGet">Bibel laden</button>' : ''}
    ${list.length && !state.projects ? '<p class="faint sm">Laden geht direkt auf dem Mac.</p>' : ''}
  </div></div>`;
  const get = $('#bibleGet');
  if (get) get.onclick = async () => {
    get.disabled = true;
    get.textContent = 'Lädt …';
    await api.post('content/download', { ids: list.map(t => t.id) }).catch(() => null);
    pollTasks();
  };
}

// The menu with the translations, the same at the start and while reading.
function bibleTranslationMenu(wrapBtn, ctx) {
  const { meta, have, t, other = null, book = null, c = 1 } = ctx;
  const ref = book ? `${book.id === 'PSA' ? 'Psalm' : book.name.replace(/\s/g, '')}${c}` : '1.Mose1';
  wrapBtn.onclick = e => {
    e.stopPropagation();
    const wrap = wrapBtn.parentElement;
    if ($('.menu', wrap)) return closeMenus();
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'menu bible-menu';
    const missing = state.projects ? meta.translations.filter(x => !x.installed) : [];
    menu.innerHTML = `
      <div class="menu-label">Übersetzung</div>
      ${have.map(x => `<a class="menu-item ${x === t ? 'on' : ''}" href="${bibleHref(x.code, book?.id, c)}"><div class="grow"><b>${esc(x.title)}</b></div><span class="check">${ic('check', 16)}</span></a>`).join('')}
      ${missing.map(x => `<button class="menu-item" data-get="${esc(x.id)}"><div class="grow"><b>${esc(x.title)}</b><small>Laden, etwa 4 MB</small></div>${ic('download', 15)}</button>`).join('')}
      ${book && have.length > 1 ? `
        <div class="menu-label">Vergleichen mit</div>
        ${have.filter(x => x !== t).map(x => `<button class="menu-item ${x === other ? 'on' : ''}" data-with="${esc(x.code)}"><div class="grow"><b>${esc(x.short)}</b></div><span class="check">${ic('check', 16)}</span></button>`).join('')}` : ''}
      <div class="menu-label">Geschützt, nur online</div>
      ${meta.online.map(x => `<a class="menu-item" href="${esc(x.url.replace('{ref}', encodeURIComponent(ref)))}" target="_blank" rel="noopener"><div class="grow"><b>${esc(x.title)}</b><small>${esc(x.site)}</small></div>${ic('external', 15)}</a>`).join('')}`;
    $$('[data-with]', menu).forEach(b => (b.onclick = () => {
      store.set('bibleWith', b.dataset.with === other?.code ? '' : b.dataset.with);
      closeMenus();
      route();
    }));
    $$('[data-get]', menu).forEach(b => (b.onclick = async () => {
      closeMenus();
      toast('Wird geladen.');
      await api.post('content/download', { ids: [b.dataset.get] }).catch(() => null);
      pollTasks();
    }));
    wrap.appendChild(menu);
  };
}

function renderBibleHome(meta, have, t, query) {
  const last = store.get('bibleLast', null);
  const lastBook = last && meta.books.find(b => b.id === last.b);
  const byId = id => meta.books.find(b => b.id === id);
  $('#topLeft').innerHTML = `<a class="btn ghost sm" href="#/library">${ic('arrowLeft', 15)}Bibliothek</a>`;
  view.innerHTML = `<div class="page bible-home"><div class="page-inner narrow">
    <div class="page-head">
      <div class="grow"><h1>Die Bibel</h1></div>
      <div class="picker"><button class="btn sm picker-btn" id="bTrans">${esc(t.short)}${ic('chevDown', 14)}</button></div>
    </div>
    <div class="ms-input bible-search">${ic('search', 17)}<input id="bQuery" placeholder="Stelle oder Wort, zum Beispiel Joh 3,16 oder Licht der Welt" aria-label="Stelle oder Wort suchen" autocomplete="off" value="${esc(query)}"></div>
    <div id="bHits" hidden></div>
    <div id="bToc">
      ${lastBook ? `<a class="bible-continue" href="${bibleHref(t.code, last.b, last.c)}"><span>Weiterlesen</span><b>${esc(bibleTitle(lastBook, last.c))}</b>${ic('arrowRight', 16)}</a>` : ''}
      ${BIBLE_PARTS.map(([part, groups]) => `
        <h2 class="bible-part">${part}</h2>
        ${groups.map(([group, ids]) => `
          <div class="bible-group">
            <div class="group-title">${group}</div>
            <div class="bible-books">${ids.map(byId).filter(Boolean).map(b => `<button class="bible-book" data-b="${b.id}" aria-expanded="false">${esc(b.name)}</button>`).join('')}</div>
            <div class="bible-grid" hidden></div>
          </div>`).join('')}`).join('')}
    </div>
    <p class="bible-credit">${esc(t.title)}. ${esc(t.credit)}</p>
  </div></div>`;
  bibleTranslationMenu($('#bTrans'), { meta, have, t });
  $$('.bible-book').forEach(btn => (btn.onclick = () => {
    const book = byId(btn.dataset.b);
    if (book.verses.length === 1) {
      location.hash = bibleHref(t.code, book.id, 1);
      return;
    }
    const grid = btn.closest('.bible-group').querySelector('.bible-grid');
    const open = btn.getAttribute('aria-expanded') === 'true';
    $$('.bible-book[aria-expanded=true]').forEach(x => x.setAttribute('aria-expanded', 'false'));
    $$('.bible-grid').forEach(x => (x.hidden = true));
    if (open) return;
    btn.setAttribute('aria-expanded', 'true');
    grid.hidden = false;
    grid.innerHTML = book.verses.map((_, k) => `<a href="${bibleHref(t.code, book.id, k + 1)}">${k + 1}</a>`).join('');
  }));

  const input = $('#bQuery');
  const hits = $('#bHits');
  const toc = $('#bToc');
  let timer = 0;
  let seq = 0;
  const open = () => { const first = $('a', hits); if (first) location.hash = first.getAttribute('href'); };
  const search = async () => {
    const q = input.value.trim();
    history.replaceState(null, '', `${bibleHref(t.code)}${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    const mine = ++seq;
    if (!q) {
      hits.hidden = true;
      toc.hidden = false;
      return;
    }
    const r = await api.get(`bible/search?t=${encodeURIComponent(t.code)}&q=${encodeURIComponent(q)}`).catch(() => null);
    if (mine !== seq) return;
    toc.hidden = true;
    hits.hidden = false;
    const list = r?.hits || [];
    const place = r?.place ? `<a class="bible-hit place" href="${bibleHref(t.code, r.place.b, r.place.c, r.place.v)}"><b>${esc(r.place.label)}</b><span>Öffnen</span>${ic('arrowRight', 16)}</a>` : '';
    const count = r?.total ? `<div class="group-title">${fmtNum(r.total)} ${r.total === 1 ? 'Vers' : 'Verse'}${r.total > list.length ? `, die ersten ${list.length}` : ''}</div>` : '';
    hits.innerHTML = place + count + list.map(h => {
      const book = byId(h.b);
      return `<a class="bible-hit" href="${bibleHref(t.code, h.b, h.c, h.v)}"><b>${esc(bibleTitle(book, h.c))},${h.v}</b><span>${markWords(h.text, r.words)}</span></a>`;
    }).join('') + (place || list.length ? '' : '<p class="faint sm section-note">Nichts gefunden. Alte Schreibweisen helfen manchmal, zum Beispiel "Hülfe".</p>');
  };
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(search, 180);
  };
  input.onkeydown = e => {
    if (e.key === 'Enter') {
      clearTimeout(timer);
      search().then(open);
    }
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      input.value = '';
      search();
    }
  };
  if (query) search();
  if (innerWidth > 900) input.focus();
}

function renderBibleChapter(ctx) {
  const { meta, have, t, other, book, c, main, second, target } = ctx;
  const keep = bible.current === ctx ? $('.bible-read')?.scrollTop : 0;
  bible.current = ctx;
  const title = bibleTitle(book, c);
  const at = meta.books.indexOf(book);
  const before = c > 1 ? [book, c - 1] : at > 0 ? [meta.books[at - 1], meta.books[at - 1].verses.length] : null;
  const after = c < book.verses.length ? [book, c + 1] : at + 1 < meta.books.length ? [meta.books[at + 1], 1] : null;
  const href = page => bibleHref(t.code, page[0].id, page[1]);
  bible.nav = { before: before && href(before), after: after && href(after) };
  const size = BIBLE_SIZES[store.get('bibleSize', 1)] ?? BIBLE_SIZES[1];
  const verses = bibleVerses(main.blocks);
  const layout = other ? 'compare' : BIBLE_POEMS.has(book.id) || bibleLayout() === 'verses' ? 'lines' : 'flow';

  const flow = () => {
    const seen = new Set([main.blocks[0]?.[1][0]?.[0]]); // the big chapter number stands in for the first verse number
    const verse = ([v, text]) => {
      const number = seen.has(v) ? '' : `<sup>${v}</sup>`;
      seen.add(v);
      return `<span class="bv" data-v="${v}">${number}${esc(text)} </span>`;
    };
    return main.blocks.map(([kind, rows], i) => `<p class="bf b-${kind}">${i ? '' : `<span class="bc">${c}</span>`}${rows.map(verse).join('')}</p>`).join('');
  };
  const lines = () => `<div class="bc-big">${c}</div>${[...verses].map(([v, text]) => `<p class="bl" data-v="${v}"><sup>${v}</sup><span>${esc(text)}</span></p>`).join('')}`;
  const compare = () => {
    const theirs = bibleVerses(second.blocks);
    const all = [...new Set([...verses.keys(), ...theirs.keys()])].sort((x, y) => x - y);
    return `<div class="bc-big">${c}</div>
      <div class="bp-head"><span></span><b>${esc(t.short)}</b><b>${esc(other.short)}</b></div>
      ${all.map(v => `<div class="bp-row" data-v="${v}"><sup>${v}</sup><div>${esc(verses.get(v) || '')}</div><div class="bp-b">${esc(theirs.get(v) || '')}</div></div>`).join('')}`;
  };

  $('#topLeft').innerHTML = `
    <a class="icon-btn" href="${bibleHref(t.code)}" title="Alle Bücher und Suche" aria-label="Alle Bücher und Suche">${ic('book', 18)}</a>
    <div class="picker"><button class="btn sm ghost picker-btn" id="bChapter"><span class="bible-label">${esc(title)}</span>${ic('chevDown', 14)}</button></div>
    <div class="picker"><button class="btn sm ghost picker-btn" id="bTrans" title="${esc(t.title)}"><span class="sub">${esc(t.short.split(' ')[0])}<span class="bible-year"> ${esc(t.short.split(' ')[1] || '')}</span></span>${ic('chevDown', 14)}</button></div>`;
  $('#topRight').innerHTML = `
    <div class="picker"><button class="icon-btn picker-btn" id="bText" title="Text" aria-label="Text">${ic('type', 18)}</button></div>
    <button class="btn sm primary bible-ask" id="bAsk" title="Basecamp fragen">${ic('sparkle', 15)}<span>Fragen</span></button>`;

  view.innerHTML = `<div class="bible-shell"><div class="page bible-read"><div class="bible-wrap ${layout === 'compare' ? 'wide' : ''}">
      ${before ? `<a class="bible-side no-print" href="${href(before)}" title="${esc(bibleTitle(...before))}" aria-label="${esc(bibleTitle(...before))}">${ic('arrowLeft', 18)}</a>` : '<span></span>'}
      <article class="bible-text ${layout}" lang="de" style="--bible-size:${size}px">
        <div class="bible-book-title">${esc(book.title)}</div>
        ${layout === 'compare' ? compare() : layout === 'lines' ? lines() : flow()}
        <nav class="bible-pager no-print">
          ${before ? `<a href="${href(before)}">${ic('arrowLeft', 15)}${esc(bibleTitle(...before))}</a>` : '<span></span>'}
          ${after ? `<a href="${href(after)}">${esc(bibleTitle(...after))}${ic('arrowRight', 15)}</a>` : '<span></span>'}
        </nav>
        <p class="bible-credit">${esc(t.title)}. ${esc(t.credit)}${other ? `<br>${esc(other.title)}. ${esc(other.credit)}` : ''}</p>
      </article>
      ${after ? `<a class="bible-side no-print" href="${href(after)}" title="${esc(bibleTitle(...after))}" aria-label="${esc(bibleTitle(...after))}">${ic('arrowRight', 18)}</a>` : '<span></span>'}
    </div></div>
    <div class="bible-bar no-print" id="bBar" hidden></div></div>`;

  bibleTranslationMenu($('#bTrans'), ctx);
  $('#bChapter').onclick = e => {
    e.stopPropagation();
    const wrap = e.currentTarget.parentElement;
    if ($('.menu', wrap)) return closeMenus();
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'menu bible-menu';
    menu.innerHTML = `<a class="menu-item" href="${bibleHref(t.code)}">${ic('book', 16)}<div class="grow"><b>Alle Bücher</b></div></a>
      <div class="menu-label">${esc(book.name)}</div>
      <div class="bible-grid">${book.verses.map((_, k) => `<a class="${k + 1 === c ? 'on' : ''}" href="${bibleHref(t.code, book.id, k + 1)}">${k + 1}</a>`).join('')}</div>`;
    wrap.appendChild(menu);
    $('.bible-grid .on', menu)?.scrollIntoView({ block: 'nearest' });
  };
  $('#bText').onclick = e => {
    e.stopPropagation();
    const wrap = e.currentTarget.parentElement;
    if ($('.menu', wrap)) return closeMenus();
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'menu right text-menu bible-menu';
    menu.innerHTML = `
      <div class="menu-label">Textgröße</div>
      <div class="seg-row">${['Klein', 'Normal', 'Groß'].map((label, i) => `<button class="${store.get('bibleSize', 1) === i ? 'on' : ''}" data-size="${i}">${label}</button>`).join('')}</div>
      <div class="menu-label">Darstellung</div>
      <div class="seg-row">${[['flow', 'Fließtext'], ['verses', 'Vers für Vers']].map(([k, label]) => `<button class="${bibleLayout() === k ? 'on' : ''}" data-layout="${k}">${label}</button>`).join('')}</div>`;
    $$('button', menu).forEach(b => (b.onclick = () => {
      if (b.dataset.size) store.set('bibleSize', +b.dataset.size);
      if (b.dataset.layout) store.set('bibleLayout', b.dataset.layout);
      closeMenus();
      renderBibleChapter(ctx);
    }));
    wrap.appendChild(menu);
  };
  const ask = draft => {
    pendingArticle = { book: t.id, path: `${book.id}.${c}`, title, draft };
    location.hash = '#/';
  };
  $('#bAsk').onclick = () => ask('');

  // A click marks a verse. Marking text with the mouse stays normal text selection.
  const text = $('.bible-text');
  const bar = $('#bBar');
  const paint = () => {
    $$('[data-v]', text).forEach(el => el.classList.toggle('on', bible.picked.has(+el.dataset.v)));
    bar.hidden = !bible.picked.size;
    if (!bible.picked.size) return;
    const ref = `${title},${verseRanges(bible.picked)}`;
    const quote = [...bible.picked].sort((x, y) => x - y).map(v => verses.get(v) || '').filter(Boolean).join(' ');
    bar.innerHTML = `<b>${esc(ref)}</b>
      <button class="btn sm ghost" data-a="copy">${ic('copy', 15)}Kopieren</button>
      <button class="btn sm ghost" data-a="link">${ic('link', 15)}Link</button>
      <button class="btn sm ghost" data-a="ask">${ic('sparkle', 15)}Fragen</button>
      <button class="icon-btn" data-a="clear" title="Auswahl aufheben" aria-label="Auswahl aufheben">${ic('x', 16)}</button>`;
    $('[data-a=copy]', bar).onclick = () => copyText(`„${quote}“\n${ref} (${t.short})`);
    $('[data-a=link]', bar).onclick = () => copyText(`${location.origin}${location.pathname}${bibleHref(t.code, book.id, c, verseRanges(bible.picked).split('.')[0])}`);
    $('[data-a=ask]', bar).onclick = () => ask(`Was bedeutet ${ref}?`);
    $('[data-a=clear]', bar).onclick = () => { bible.picked.clear(); paint(); };
  };
  text.onclick = e => {
    if (e.target.closest('a') || getSelection().toString()) return;
    const el = e.target.closest('[data-v]');
    if (!el) return;
    const v = +el.dataset.v;
    if (bible.picked.has(v)) bible.picked.delete(v);
    else bible.picked.add(v);
    paint();
  };
  bible.clearPicked = () => { if (!bible.picked.size) return false; bible.picked.clear(); paint(); return true; };
  paint();

  // A link to a verse shows it in the middle and marks it for a moment.
  const scroller = $('.bible-read');
  if (keep) scroller.scrollTop = keep;
  else if (target) {
    const [from, to] = target.split('-').map(Number);
    const marked = $$('[data-v]', text).filter(el => +el.dataset.v >= from && +el.dataset.v <= (to || from));
    marked.forEach(el => el.classList.add('hit'));
    marked[0]?.scrollIntoView({ block: 'center' });
  }
  ctx.target = null;
}

document.addEventListener('keydown', e => {
  if (state.view !== 'bibel' || !bible.nav || !pal.wrap.hidden) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.key === 'ArrowLeft' && bible.nav.before) location.hash = bible.nav.before;
  if (e.key === 'ArrowRight' && bible.nav.after) location.hash = bible.nav.after;
  if (e.key === 'Escape') bible.clearPicked?.();
});

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
        <div class="meta"><span>${fmtNum(b.articles)} ${b.category === 'bibel' ? 'Kapitel' : 'Artikel'}</span><span class="pill">${esc(b.lang)}</span></div></div>
    </a>`;
  const byWeight = (x, y) => (y.lang === 'de') - (x.lang === 'de') || y.articles - x.articles;
  const sections = (cat === 'all' ? present : present.filter(c => c.id === cat)).map(c => `
    ${cat === 'all' ? `<div class="section-h"><h2>${esc(c.title)}</h2><span>${state.books.filter(b => b.category === c.id).length}</span></div>` : ''}
    <div class="lib-grid">${state.books.filter(b => b.category === c.id).sort(byWeight).map(card).join('')}</div>`).join('');
  const others = state.books.filter(b => !state.categories.some(c => c.id === b.category));
  const recent = store.get('recent', []).filter(r => bookById(r.book) && r.path !== bookById(r.book).main).slice(0, 6);

  view.innerHTML = `<div class="page"><div class="page-inner">
    <div class="page-head">
      <div><h1>Bibliothek</h1><p>${state.books.length} Quellen · ${fmtNum(total)} Artikel · ${files.length} eigene Dateien</p></div>
      <span class="spacer"></span>
      <button class="btn" id="libSearch">${ic('search', 16)} Durchsuchen <kbd>⌘K</kbd></button>
      ${state.books.length ? `<button class="btn" id="libRandom">${ic('dice', 16)} Zufall</button>` : ''}
      ${state.projects && state.books.length ? `<a class="btn" href="#/settings?tab=content">${ic('download', 16)} Quellen verwalten</a>` : ''}
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
      ${state.projects ? `<a href="#/settings?tab=memory" class="${tab === 'memory' ? 'on' : ''}">Gedächtnis</a>` : ''}
      <a href="#/settings?tab=system" class="${tab === 'system' ? 'on' : ''}">System</a>
    </div>
    <div id="tasksBox"></div>
    <div id="tabBody"><p class="faint">Lade …</p></div>
  </div></div>`;
  renderTasks();
  const body = $('#tabBody');
  if (tab === 'models') return renderModels(body);
  if (tab === 'system') return renderSystem(body);
  if (tab === 'memory' && state.projects) return renderMemorySettings(body);
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

const openSources = new Set();
let sourceQuery = '';

async function renderContent(el) {
  const c = await api.get('catalog');
  if (!$('#tabBody') || el !== $('#tabBody')) return;
  const lang = store.get('langFilter', 'all');
  const onlyInstalled = store.get('onlyInstalled', false);
  const used = c.items.reduce((n, i) => n + (i.installed_size || 0), 0) + c.extra.reduce((n, b) => n + b.size, 0);
  const usedGb = used / 1e9;
  const refocus = document.activeElement?.id === 'srcQuery';
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

    <div class="src-tools">
      <div class="group-title" style="margin:0">Einzelne Quellen</div>
      <span class="spacer"></span>
      <select class="select" id="lang"><option value="all">Alle Sprachen</option><option value="de">Deutsch</option><option value="en">Englisch</option></select>
      <button class="filter ${onlyInstalled ? 'on' : ''}" id="only">Installiert</button>
      <button class="btn sm ghost" id="refresh" title="Prüft bei Kiwix, ob es neuere Versionen gibt">${ic('refresh', 14)} ${c.checked ? 'Erneut prüfen' : 'Updates prüfen'}</button>
    </div>
    <div class="ms-input src-search">${ic('search', 16)}<input id="srcQuery" placeholder="Quelle suchen" aria-label="Quelle suchen" autocomplete="off"></div>
    ${c.categories.map(cat => {
      const rows = items.filter(i => i.cat === cat.id);
      if (!rows.length) return '';
      const have = rows.filter(i => i.installed).length;
      const open = onlyInstalled || openSources.has(cat.id) || rows.some(i => activeTask('zim', i.id));
      return `<details class="src-group" data-cat="${esc(cat.id)}" ${open ? 'open' : ''}>
        <summary><b>${esc(cat.title)}</b><span>${have ? `${have} von ${rows.length} installiert` : `${rows.length} ${rows.length === 1 ? 'Quelle' : 'Quellen'}`}</span>${ic('chevDown', 15)}</summary>
        <div class="group">${rows.map(it => `
        <div class="row" data-src="${esc(`${it.title} ${it.desc}`.toLowerCase())}">
          <div class="grow"><b>${esc(it.title)}</b> ${it.kind === 'map' ? '' : `<span class="pill">${esc(it.lang)}</span>`}<small>${esc(it.desc)}</small></div>
          <span class="size">${fmtGb(it.gb)}</span>
          <div class="acts" data-status="${esc(it.id)}">${status(it)}${action(it)}</div>
        </div>`).join('')}</div></details>`;
    }).join('')}
    ${c.extra.length ? `<div class="group-title" style="margin-top:18px">Eigene ZIM-Dateien</div><div class="group">${c.extra.map(b => `
      <div class="row"><div class="grow"><b>${esc(b.title)}</b> <span class="pill">${esc(b.lang)}</span><small>${esc(b.description)}</small></div>
        <span class="size">${fmtSize(b.size)}</span>
        <div class="acts"><button class="icon-btn" data-delete="${esc(b.id)}" title="Löschen">${ic('trash', 16)}</button></div></div>`).join('')}</div>` : ''}
    <p class="faint sm" style="margin-top:18px">Ordner: <code class="path">${esc(c.zim_dir)}</code>. Eigene .zim-Dateien einfach hineinlegen.</p>`;

  const groups = $$('.src-group', el);
  const applyQuery = () => {
    const q = sourceQuery.trim().toLowerCase();
    for (const d of groups) {
      const rows = $$('.row', d);
      rows.forEach(r => { r.hidden = !!q && !r.dataset.src.includes(q); });
      d.hidden = rows.every(r => r.hidden);
      if (q) d.open = true;
    }
  };
  const query = $('#srcQuery');
  query.value = sourceQuery;
  query.oninput = () => {
    const was = sourceQuery.trim();
    sourceQuery = query.value;
    if (was && !sourceQuery.trim()) groups.forEach(d => { d.open = onlyInstalled || openSources.has(d.dataset.cat); });
    applyQuery();
  };
  groups.forEach(d => (d.ontoggle = () => {
    if (sourceQuery.trim() || onlyInstalled) return;
    d.open ? openSources.add(d.dataset.cat) : openSources.delete(d.dataset.cat);
  }));
  applyQuery();
  if (refocus) query.focus();
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
  const kv = (k, v) => `<div class="row kv"><b>${k}</b><span class="muted sm">${v}</span></div>`;
  el.innerHTML = `
    <div class="group">
      ${kv('Mac', `${esc(st.chip)} · ${st.ram_gb} GB RAM`)}
      ${kv('KI', st.ollama ? `Ollama läuft · ${esc(modelMeta(st.model)?.title || st.model)}` : 'Ollama aus')}
      ${kv('Quellen', `${st.books} Quellen · ${st.files} eigene Dateien`)}
      ${kv('Speicher', `${fmtGb(st.disk_free_gb)} frei`)}
      ${kv('Daten', `<code class="path">${esc(st.data_dir)}</code>`)}
    </div>
    <div class="group-title">Stromsparen</div>
    <div class="group"><div class="row">${ic('bulb', 20)}<div class="grow"><b>${state.power?.on ? 'Stromsparen ist an' : 'Nur das Wissen laufen lassen'}</b>
      <small>Entlädt die KI-Modelle und sperrt die KI. Suchen, Lesen, Karten und der Notfall-Bereich bleiben an.</small></div>
      ${state.projects ? `<button class="btn" id="powerToggle">${state.power?.on ? 'Ausschalten' : 'Einschalten'}</button>` : ''}</div></div>
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
  const toggle = $('#powerToggle', el);
  if (toggle) toggle.onclick = async () => {
    await setPowerSave(!state.power?.on);
    renderSystem(el);
  };
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
    autosize();
  }

  let running = false; // the whole agent loop, including tool calls
  const busy = () => running || !!ctrl || !!pendingResolve;
  const autosize = () => {
    sendBtn.disabled = !busy() && (!ta.value.trim() || !currentModel(true) || !!state.power?.on);
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
    if (!text || state.power?.on) return;
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
    inner.innerHTML = `<div class="hero">${wordmark()}<p class="hero-hint">${heroHint()}</p>${modeSwitch('code')}</div>`;
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
    bible.meta = null;
    if (state.view === 'map' && !mapState.map) route();
    if (state.view === 'bibel') route();
    if (state.view === 'settings') {
      const tab = new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || 'content';
      const body = $('#tabBody');
      if (body && tab !== 'memory') (tab === 'models' ? renderModels : tab === 'content' ? renderContent : renderSystem)(body);
    }
  }
  lastActive = active.length;
}
// slower while nobody looks and while saving power: this wakes browser and server every time
(function tick() {
  setTimeout(() => pollTasks().finally(tick), document.hidden || state.power?.on ? 30000 : 2000);
})();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  pollTasks();
  loadPower();
  loadWarnings();
});
setInterval(() => { if (!document.hidden) loadPower(); }, 30000);
setInterval(() => { if (!document.hidden) loadWarnings(); }, 60000);

/* ================================================================ start */

hydrateIcons();
pollTasks();
Promise.allSettled([loadBooks(), loadProjects(), loadPower(), loadWarnings()]).finally(route);
