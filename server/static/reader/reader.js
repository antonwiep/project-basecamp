// Basecamp reader. Runs inside every ZIM page (Wikipedia, iFixit, ...) on the content origin.
// Adds what the real sites have: contents sidebar, link previews, night mode, text size.
// It talks to the app only through postMessage, it cannot reach the app's API.
(() => {
  const doc = document;
  const root = doc.documentElement;
  if (root.classList.contains('bc')) return;
  const APP = `${location.protocol}//${location.host.replace(/:(\d+)$/, (_, p) => ':' + (+p - 1))}`;
  const framed = window.parent !== window;
  const m = decodeURIComponent(location.pathname).match(/^\/zim\/([^/]+)\/(.*)$/);
  const book = m ? m[1] : '';
  const path = m ? m[2] : '';
  const wiki = !!doc.querySelector('.mw-parser-output');
  const de = (doc.documentElement.lang || '').startsWith('de');
  const T = de ? { toc: 'Inhalt', top: '(Anfang)', more: 'Weiterlesen' } : { toc: 'Contents', top: '(Top)', more: 'Read more' };
  root.classList.add('bc');
  if (wiki) root.classList.add('bc-wiki');
  if (framed) root.classList.add('bc-framed');

  const tell = msg => framed && parent.postMessage({ bc: 1, ...msg }, APP);

  /* ---------------------------------------------------------------- night mode */
  const dark = matchMedia('(prefers-color-scheme: dark)');
  function lightPage() {
    for (const el of [doc.body, root]) {
      if (!el) continue;
      const [r, g, b, a = 1] = (getComputedStyle(el).backgroundColor.match(/[\d.]+/g) || []).map(Number);
      if (r !== undefined && a > 0.5) return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
    }
    return !/dark/.test(getComputedStyle(root).colorScheme);
  }
  function theme() {
    root.classList.remove('bc-invert');
    if (dark.matches && lightPage()) root.classList.add('bc-invert');
  }
  theme();
  dark.addEventListener('change', theme);

  /* ---------------------------------------------------------------- picture placeholders */
  // Wikipedia "nopic" and "mini" files replace pictures with grey boxes that only show the alt text.
  const isEmpty = el => !el.textContent.trim() && !el.querySelector('img, svg, video, audio, canvas, math, iframe, table');
  function dropPlaceholders() {
    const holders = [...doc.querySelectorAll('img[src^="data:image/svg+xml"]')]
      .filter(img => /alt-text-clip|%3Ctitle%3E/.test(img.getAttribute('src')));
    const touched = new Set();
    for (const img of holders) {
      const fig = img.closest('figure, .thumb, .gallerybox, .tsingle');
      if (fig) {
        touched.add(fig.parentElement);
        fig.remove();
        continue;
      }
      const el = img.closest('a') || img;
      touched.add(el.parentElement);
      el.remove();
    }
    for (let el of touched) {
      while (el && el !== doc.body && !el.matches('td, th, section, .mw-parser-output') && isEmpty(el)) {
        const up = el.parentElement;
        el.remove();
        el = up;
      }
      if (el && el.matches('td, th') && (isEmpty(el) || (el.matches('.infobox-image, .infobox-full-data') && !el.querySelector('img, svg')))) {
        const tr = el.closest('tr');
        if (tr && [...tr.cells].every(c => c === el || isEmpty(c))) tr.remove();
      }
    }
    doc.querySelectorAll('ul.gallery').forEach(ul => !ul.querySelector('li') && ul.remove());
  }
  if (wiki) dropPlaceholders();

  /* ---------------------------------------------------------------- contents */
  const scope = doc.querySelector('.mw-parser-output') || doc.body;
  const heads = [...scope.querySelectorAll('h2, h3')].filter(h =>
    h.textContent.trim() && !h.closest('.infobox, .navbox, table, .toc, #toc, nav, header, footer, .bc-toc'));
  const toc = heads.map((h, i) => {
    if (!h.id) h.id = 'bc-' + i;
    return { id: h.id, text: h.textContent.replace(/\[[^\]]*\]/g, '').trim(), level: h.tagName === 'H2' ? 2 : 3 };
  });
  let nav = null;
  // a contents sidebar inside the page only for Wikipedia; other sites often have their own navigation
  if (wiki && toc.length >= 2) {
    nav = doc.createElement('nav');
    nav.className = 'bc-toc';
    nav.innerHTML = `<div class="bc-toc-title">${T.toc}</div><a href="#" data-top class="on">${T.top}</a>` +
      toc.map(t => `<a href="#${CSS.escape(t.id)}" class="l${t.level}">${t.text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</a>`).join('');
    root.appendChild(nav); // outside <body>, so the night-mode filter cannot break position: fixed
    root.classList.add('bc-has-toc');
    nav.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      if (a.dataset.top !== undefined) scrollTo({ top: 0 });
      else doc.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)))?.scrollIntoView();
    });
    const links = [...nav.querySelectorAll('a')];
    let ticking = false;
    const mark = () => {
      ticking = false;
      let cur = -1;
      heads.forEach((h, i) => { if (h.getBoundingClientRect().top < 120) cur = i; });
      links.forEach((a, i) => a.classList.toggle('on', i === cur + 1));
    };
    addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(mark); } }, { passive: true });
  }

  /* ---------------------------------------------------------------- link previews */
  const MEDIA = /\.(png|jpe?g|gif|svg|webp|webm|mp4|ogg|ogv|oga|mp3|pdf)$/i;
  const cache = new Map();
  let card = null, timer = 0, hideTimer = 0, current = null;
  const internal = a => {
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || a.closest('.bc-toc, .bc-card, .reference, .mw-cite-backlink, .navbox')) return false;
    try {
      const u = new URL(a.href);
      return u.origin === location.origin && u.pathname.startsWith(`/zim/${encodeURIComponent(book)}/`) &&
        u.pathname !== location.pathname && !MEDIA.test(u.pathname);
    } catch { return false; }
  };
  async function summary(url) {
    if (cache.has(url)) return cache.get(url);
    const p = fetch(url).then(r => (r.ok ? r.text() : Promise.reject())).then(text => {
      const d = new DOMParser().parseFromString(text, 'text/html');
      const body = d.querySelector('.mw-parser-output') || d.body;
      if (!body) return null;
      body.querySelectorAll('sup, .mw-ref, .reference, style, script, .noprint, .mw-empty-elt, #coordinates, .hatnote').forEach(x => x.remove());
      const para = [...body.querySelectorAll('p')].map(x => x.textContent.replace(/\s+/g, ' ').trim()).find(t => t.length > 60);
      if (!para) return null;
      const img = [...d.querySelectorAll('.infobox img, figure img, .thumb img, img')]
        .find(i => { const s = i.getAttribute('src') || ''; return s && !s.startsWith('data:') && (+i.getAttribute('width') || 100) >= 60; });
      const title = (d.querySelector('#firstHeading, h1') || d.querySelector('title'))?.textContent.trim() || '';
      return { title, text: para.length > 420 ? para.slice(0, 420).replace(/\s+\S*$/, '') + ' …' : para, img: img ? new URL(img.getAttribute('src'), url).href : '' };
    }).catch(() => null);
    cache.set(url, p);
    return p;
  }
  function hide() {
    clearTimeout(timer);
    card?.remove();
    card = null;
    current = null;
  }
  async function show(a) {
    const s = await summary(a.href);
    if (!s || current !== a || !a.isConnected) return;
    card?.remove();
    card = doc.createElement('div');
    card.className = 'bc-card';
    card.innerHTML = (s.img ? `<div class="bc-card-img"><img src="${s.img}" alt=""></div>` : '') +
      `<div class="bc-card-body"><b></b><p></p><span class="bc-card-more">${T.more} →</span></div>`;
    card.querySelector('b').textContent = s.title;
    card.querySelector('p').textContent = s.text;
    card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    card.addEventListener('mouseleave', () => (hideTimer = setTimeout(hide, 250)));
    card.addEventListener('click', () => (location.href = a.href));
    root.appendChild(card);
    const r = a.getBoundingClientRect();
    const w = Math.min(340, innerWidth - 24);
    card.style.width = w + 'px';
    const left = Math.max(12, Math.min(r.left, innerWidth - w - 12));
    const below = r.bottom + 8 + card.offsetHeight < innerHeight || r.top < card.offsetHeight + 16;
    card.style.left = left + 'px';
    card.style.top = (below ? r.bottom + 8 : r.top - card.offsetHeight - 8) + 'px';
    requestAnimationFrame(() => card && card.classList.add('in'));
  }
  if (wiki && matchMedia('(hover: hover)').matches) {
    doc.addEventListener('mouseover', e => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a || !internal(a) || a === current) return;
      clearTimeout(timer);
      clearTimeout(hideTimer);
      hide();
      current = a;
      timer = setTimeout(() => show(a), 500);
    });
    doc.addEventListener('mouseout', e => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (a && a === current && !a.contains(e.relatedTarget)) {
        clearTimeout(timer);
        hideTimer = setTimeout(hide, 250);
      }
    });
    addEventListener('scroll', hide, { passive: true });
  }

  /* ---------------------------------------------------------------- links and keys */
  doc.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (/^(https?:)?\/\//i.test(href) && !a.href.startsWith(location.origin)) {
      a.target = '_blank';
      a.rel = 'noopener';
    }
  }, true);
  doc.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if ((mod && (k === 'k' || (e.shiftKey && k === 'o'))) || e.key === 'Escape') {
      if (mod) e.preventDefault();
      tell({ type: 'key', key: e.key, mod, shift: e.shiftKey });
    }
  });

  /* ---------------------------------------------------------------- talk to the app */
  function prefs(p) {
    const size = Math.max(0, Math.min(2, p.size ?? 1));
    if (wiki) {
      root.className = root.className.replace(/vector-feature-custom-font-size-clientpref-\d/, '') + ` vector-feature-custom-font-size-clientpref-${size}`;
      root.className = root.className.replace(/vector-feature-limited-width-clientpref-\d/, '') + ` vector-feature-limited-width-clientpref-${p.wide ? 0 : 1}`;
    }
    root.dataset.bcSize = size;
    root.classList.toggle('bc-wide', !!p.wide);
  }
  addEventListener('message', e => {
    if (e.origin !== APP || e.source !== parent || !e.data || !e.data.bc) return;
    const d = e.data;
    if (d.type === 'prefs') prefs(d);
    else if (d.type === 'goto') doc.getElementById(d.id)?.scrollIntoView();
    else if (d.type === 'top') scrollTo({ top: 0 });
  });
  const title = (doc.querySelector('#firstHeading') || {}).textContent || doc.title || path.split('/').pop().replace(/_/g, ' ');
  tell({ type: 'page', book, path, title: title.trim(), toc: toc.length >= 2 ? toc : [], sidebar: !!nav });
})();
