/*! snicker02 Shelf v1.0.1 — shared image shelf + app hand-off for snicker02.github.io
 *
 *  Every app under https://snicker02.github.io/ shares one browser origin, so they can share
 *  one IndexedDB store. This classic script (no dependencies, no build) exposes
 *  window.SnickerShelf:
 *
 *    SnickerShelf.mount({ app, onImage(file, item), getImage(), button })   // UI + incoming ?shelf=<id>
 *    SnickerShelf.put(src, {app, name, params})  -> item     src: Blob | canvas | ImageBitmap | img | ImageData | Promise
 *    SnickerShelf.list()                          -> items (newest first, with .thumb Blob)
 *    SnickerShelf.get(id) / file(id) / remove(id) / clear()
 *    SnickerShelf.send(src, 'Catoptron', meta)    -> opens target app with the image   (call inside a click)
 *    SnickerShelf.sendItem(id, 'Catoptron')       -> same, for an image already on the shelf
 *    SnickerShelf.copy(src) / readClipboard()     -> system clipboard (PNG)
 *    SnickerShelf.apps() / targets('image')       -> app manifest from /apps.json
 *    SnickerShelf.onChange(fn)                    -> fires on any change, in any open tab
 */
(function () {
  'use strict';
  if (window.SnickerShelf) return;

  const VERSION = '1.0.1';
  const HOME = 'https://snicker02.github.io';
  const DB_NAME = 'snicker02-shelf', STORE = 'images';
  const MAX_ITEMS = 200, THUMB = 320;
  const ON_SITE = location.hostname === 'snicker02.github.io';
  const BASE = ON_SITE ? location.origin : HOME;
  const MANIFEST_URL = BASE + '/apps.json';

  let currentApp = '';

  // ───────────────────────── change events (this tab + other tabs) ─────────────────────────
  const listeners = new Set();
  const bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel('snicker02-shelf') : null;
  function emit(ev) { listeners.forEach(fn => { try { fn(ev); } catch (e) { console.error(e); } }); }
  if (bc) bc.onmessage = e => emit(e.data || { kind: 'change' });
  function notify(kind, id) { const ev = { kind, id: id || null }; emit(ev); if (bc) bc.postMessage(ev); }
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // ───────────────────────── IndexedDB ─────────────────────────
  let dbP = null;
  function openDB() {
    if (dbP) return dbP;
    dbP = new Promise((res, rej) => {
      if (!('indexedDB' in window)) { rej(new Error('IndexedDB unavailable')); return; }
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('created', 'created');
      };
      r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); dbP = null; }; res(d); };
      r.onerror = () => { dbP = null; rej(r.error); };
    });
    return dbP;
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function os(mode) { const d = await openDB(); return d.transaction(STORE, mode).objectStore(STORE); }
  function done(store) {
    const t = store.transaction;
    return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error || new Error('shelf write aborted')); });
  }

  let persisted = false;
  function persistOnce() {
    if (persisted) return; persisted = true;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* ignore */ }
  }

  // ───────────────────────── image helpers ─────────────────────────
  function canvasBlob(c, type, q) {
    return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('image encode failed'))), type || 'image/png', q));
  }
  async function toBlob(src) {
    if (typeof src === 'function') src = src();
    if (src && typeof src.then === 'function') src = await src;
    if (!src) throw new Error('no image');
    if (src instanceof Blob) return src;
    if (typeof src.convertToBlob === 'function') return src.convertToBlob({ type: 'image/png' });
    if (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) return canvasBlob(src);
    const c = document.createElement('canvas');
    if (typeof ImageData !== 'undefined' && src instanceof ImageData) {
      c.width = src.width; c.height = src.height; c.getContext('2d').putImageData(src, 0, 0);
    } else {
      const w = src.naturalWidth || src.videoWidth || src.width, h = src.naturalHeight || src.videoHeight || src.height;
      if (!w || !h) throw new Error('image has no size');
      c.width = w; c.height = h; c.getContext('2d').drawImage(src, 0, 0, w, h);
    }
    return canvasBlob(c);
  }
  async function decode(blob) {
    if (typeof createImageBitmap === 'function') {
      try { const b = await createImageBitmap(blob); return { src: b, w: b.width, h: b.height, close: () => { if (b.close) b.close(); } }; }
      catch (e) { /* fall through to <img> (e.g. SVG) */ }
    }
    return new Promise((res, rej) => {
      const u = URL.createObjectURL(blob), im = new Image();
      im.onload = () => { URL.revokeObjectURL(u); res({ src: im, w: im.naturalWidth, h: im.naturalHeight, close() {} }); };
      im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('not a readable image')); };
      im.src = u;
    });
  }
  function drawTo(pic, maxDim, bg) {
    const s = maxDim ? Math.min(1, maxDim / Math.max(pic.w, pic.h)) : 1;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(pic.w * s)); c.height = Math.max(1, Math.round(pic.h * s));
    const x = c.getContext('2d');
    if (bg) { x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height); }
    x.imageSmoothingQuality = 'high';
    x.drawImage(pic.src, 0, 0, c.width, c.height);
    return c;
  }
  async function asPng(blob) {
    if (blob.type === 'image/png') return blob;
    const pic = await decode(blob);
    try { return await canvasBlob(drawTo(pic, 0)); } finally { pic.close(); }
  }
  const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' };
  const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  function fileName(rec) {
    const ext = EXT[rec.type] || 'png';
    const base = rec.name ? slug(rec.name.replace(/\.[a-z0-9]+$/i, '')) : slug(rec.app || 'shelf') + '-' + rec.id;
    return (base || 'shelf-' + rec.id) + '.' + ext;
  }
  function strip(r) {
    return { id: r.id, w: r.w, h: r.h, type: r.type, app: r.app, name: r.name, params: r.params, created: r.created, size: r.blob ? r.blob.size : 0 };
  }

  // ───────────────────────── store API ─────────────────────────
  async function put(src, meta) {
    meta = meta || {};
    const blob = await toBlob(src);
    const pic = await decode(blob);
    let thumb;
    try { thumb = await canvasBlob(drawTo(pic, THUMB, '#0d1017'), 'image/jpeg', 0.82); }
    finally { pic.close(); }
    const rec = {
      id: newId(), blob, thumb, w: pic.w, h: pic.h,
      type: blob.type || 'image/png',
      app: meta.app || currentApp || 'unknown',
      name: meta.name || (blob.name || ''),
      params: meta.params === undefined ? null : meta.params,
      created: Date.now(),
    };
    const s = await os('readwrite'); s.put(rec); await done(s);
    persistOnce();
    prune().catch(() => {});
    notify('put', rec.id);
    return strip(rec);
  }
  async function prune() {
    const s = await os('readonly');
    const keys = await req(s.index('created').getAllKeys());
    if (keys.length <= MAX_ITEMS) return;
    const w = await os('readwrite');
    keys.slice(0, keys.length - MAX_ITEMS).forEach(k => w.delete(k));
    await done(w);
    notify('remove');
  }
  async function list() {
    const s = await os('readonly');
    const all = await req(s.getAll());
    return all.map(r => Object.assign(strip(r), { thumb: r.thumb })).sort((a, b) => b.created - a.created);
  }
  async function count() { const s = await os('readonly'); return req(s.count()); }
  async function get(id) { const s = await os('readonly'); return (await req(s.get(id))) || null; }
  async function file(id) {
    const r = await get(id);
    if (!r) return null;
    return new File([r.blob], fileName(r), { type: r.type, lastModified: r.created });
  }
  async function remove(id) { const s = await os('readwrite'); s.delete(id); await done(s); notify('remove', id); }
  async function clear() { const s = await os('readwrite'); s.clear(); await done(s); notify('clear'); }

  // ───────────────────────── manifest + hand-off ─────────────────────────
  let appsP = null;
  function apps() {
    if (!appsP) {
      appsP = fetch(MANIFEST_URL, { cache: 'no-cache' })
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
        .then(m => (m.apps || []).map(a => Object.assign({}, a, { href: new URL(a.url || ('/' + a.name + '/'), BASE + '/').href })))
        .catch(e => { appsP = null; console.warn('[shelf] manifest unavailable:', e.message); return []; });
    }
    return appsP;
  }
  async function targets(kind) {
    kind = kind || 'image';
    return (await apps()).filter(a => a.shelf && (a.accepts || []).indexOf(kind) >= 0);
  }
  async function resolveApp(target) {
    if (target && typeof target === 'object') return target;
    const list_ = await apps();
    const a = list_.find(x => x.name.toLowerCase() === String(target).toLowerCase());
    if (a) return a;
    return { name: String(target), href: BASE + '/' + encodeURIComponent(target) + '/' };
  }
  function appUrl(app, id) { const u = new URL(app.href); u.searchParams.set('shelf', id); return u.href; }

  // window.open must run synchronously inside the click, before any await — otherwise it's a blocked popup.
  function openWith(target, idP) {
    let win = null;
    try { win = window.open('about:blank', '_blank'); } catch (e) { win = null; }
    return Promise.all([resolveApp(target), idP]).then(([app, id]) => {
      const url = appUrl(app, id);
      if (win && !win.closed) {
        try { win.opener = null; } catch (e) { /* ignore */ }
        win.location.href = url;
        return { url, app: app.name, id };
      }
      const err = new Error('popup blocked'); err.url = url; err.app = app.name; err.id = id;
      throw err;
    }, e => { if (win && !win.closed) win.close(); throw e; });
  }
  function send(src, target, meta) { return openWith(target, put(src, meta).then(r => r.id)); }
  function sendItem(id, target) { return openWith(target, Promise.resolve(id)); }

  // ───────────────────────── clipboard ─────────────────────────
  function copy(src) {
    if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem !== 'function') {
      return Promise.reject(new Error('image copy not supported in this browser'));
    }
    // ClipboardItem gets a promise so Safari keeps the user gesture while the PNG is encoded
    const p = toBlob(src).then(asPng);
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': p })]);
  }
  async function readClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.read) throw new Error('use Ctrl+V / long-press → Paste instead');
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const t = it.types.find(x => x.indexOf('image/') === 0);
      if (t) return it.getType(t);
    }
    return null;
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ───────────────────────── in-app UI (shadow DOM, can't collide with app CSS) ─────────────────────────
  const CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.bk{position:absolute;inset:0;background:rgba(0,0,0,.5)}
.panel{position:absolute;top:0;right:0;bottom:0;width:min(400px,100%);display:flex;flex-direction:column;
  background:#11141d;color:#eef2f8;border-left:1px solid rgba(255,255,255,.14);font-size:13px;
  padding-bottom:env(safe-area-inset-bottom);box-shadow:-12px 0 40px rgba(0,0,0,.45)}
@media (max-width:760px) and (orientation:portrait){
  .panel{top:auto;left:0;width:100%;height:74dvh;border-left:0;border-top:1px solid rgba(255,255,255,.14);border-radius:14px 14px 0 0}
}
header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08)}
header b{font-size:15px;letter-spacing:-.01em}
.count{color:#9aa3b8;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.sp{flex:1}
button,.btn{background:#161a26;color:#eef2f8;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:7px 11px;
  font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:5px}
button:hover,.btn:hover{border-color:rgba(255,255,255,.3)}
button:disabled{opacity:.4;cursor:default}
button.pri{background:#38e2c7;color:#051614;border-color:#38e2c7;font-weight:600}
button.danger:hover{border-color:#f87171;color:#fca5a5}
.x{width:34px;height:34px;padding:0;font-size:15px}
.tools{display:flex;gap:6px;flex-wrap:wrap;padding:10px 14px 4px}
.send{padding:8px 14px 4px}
.lbl{color:#9aa3b8;font-size:11.5px;margin-bottom:5px;display:block}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chips button{border-radius:999px;border-color:rgba(56,226,199,.35);color:#9ff3e4}
.chips button:hover{border-color:#38e2c7;color:#38e2c7}
.none{color:#717a90;font-size:12px}
.grid{flex:1;overflow:auto;padding:10px 14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px;align-content:start;overscroll-behavior:contain}
.th{position:relative;padding:0;aspect-ratio:1;border-radius:8px;overflow:hidden;background:#07090e;border:2px solid transparent}
.th img{width:100%;height:100%;object-fit:cover;display:block}
.th span{position:absolute;left:0;right:0;bottom:0;padding:3px 5px;font-size:10px;text-align:left;color:#cfd6e4;
  background:linear-gradient(transparent,rgba(0,0,0,.78));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.th.sel{border-color:#38e2c7}
.empty{grid-column:1/-1;color:#9aa3b8;text-align:center;padding:30px 10px;line-height:1.55;border:1px dashed rgba(255,255,255,.12);border-radius:10px}
.item{display:none;border-top:1px solid rgba(255,255,255,.08);padding:10px 14px}
.item.on{display:block}
.info{color:#9aa3b8;font-size:12px;margin-bottom:8px;font-family:ui-monospace,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acts{display:flex;gap:6px;flex-wrap:wrap}
footer{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid rgba(255,255,255,.08);font-size:12px;color:#717a90}
footer a{color:#9aa3b8;text-decoration:none}
footer a:hover{color:#38e2c7}
.drag .grid{outline:2px dashed #38e2c7;outline-offset:-6px}
.toast{position:absolute;left:50%;bottom:calc(58px + env(safe-area-inset-bottom));transform:translateX(-50%);max-width:90%;
  background:#0e1118;border:1px solid rgba(56,226,199,.5);color:#eef2f8;border-radius:9px;padding:8px 12px;font-size:12.5px;
  opacity:0;pointer-events:none;transition:opacity .18s}
.toast.on{opacity:1;pointer-events:auto}
.toast a{color:#38e2c7;font-weight:600}
@media (pointer:coarse){
  button,.btn{min-height:40px;padding:8px 13px;font-size:13.5px}
  .x{width:40px;height:40px}
}
`;

  const fab = (label) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.title = 'Shared image shelf';
    b.style.cssText = 'position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:2147482999;' +
      'background:#11141d;color:#eef2f8;border:1px solid rgba(56,226,199,.55);border-radius:999px;padding:8px 14px;' +
      'font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.4)';
    document.body.appendChild(b);
    return b;
  };

  function mount(opts) {
    opts = opts || {};
    currentApp = opts.app || currentApp || document.title || 'app';
    const canSave = typeof opts.getImage === 'function';
    const canLoad = typeof opts.onImage === 'function';

    const host = document.createElement('div');
    host.setAttribute('data-snicker-shelf', VERSION);
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:none';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
<div class="bk"></div>
<section class="panel" role="dialog" aria-modal="true" aria-label="Image shelf">
  <header><b>Shelf</b><span class="count"></span><span class="sp"></span><button class="x" data-a="close" aria-label="Close">✕</button></header>
  <div class="tools">
    ${canSave ? '<button class="pri" data-a="save" title="Put the current image on the shelf">＋ Save current</button><button data-a="copycur" title="Copy the current image to the system clipboard">Copy current</button>' : ''}
    <button data-a="paste" title="Add an image from the system clipboard">Paste</button>
    <label class="btn" title="Add image files to the shelf">Add files<input type="file" accept="image/*" multiple hidden></label>
  </div>
  <div class="send"><span class="lbl"></span><div class="chips"></div></div>
  <div class="grid"></div>
  <div class="item">
    <div class="info"></div>
    <div class="acts">
      ${canLoad ? '<button class="pri" data-a="load">Load here</button>' : ''}
      <button data-a="copy">Copy</button>
      <button data-a="dl">Download</button>
      <button class="danger" data-a="del">Delete</button>
    </div>
  </div>
  <footer><a href="${HOME}/#shelf" target="_blank" rel="noopener">All shelf images ↗</a><span>shelf v${VERSION}</span></footer>
  <div class="toast"></div>
</section>`;
    document.body.appendChild(host);

    const $ = s => root.querySelector(s);
    const panel = $('.panel'), grid = $('.grid'), chips = $('.chips'), lbl = $('.lbl'), item = $('.item'), info = $('.info'), toastEl = $('.toast');
    let isOpen = false, sel = null, items = [], urls = [], tgts = [], toastT = 0;

    function toast(html, ms) {
      toastEl.innerHTML = html; toastEl.classList.add('on');
      clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('on'), ms || 2200);
    }
    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    function failed(e) {
      if (e && e.url) toast(`Pop-up blocked — <a href="${esc(e.url)}" target="_blank" rel="noopener">open ${esc(e.app)} ↗</a>`, 8000);
      else toast(esc((e && e.message) || 'failed'));
    }

    function renderChips() {
      const others = tgts.filter(a => a.name.toLowerCase() !== currentApp.toLowerCase());
      const subject = sel ? 'selected image' : (canSave ? 'current image' : null);
      $('.send').style.display = others.length ? '' : 'none';
      if (!subject) { lbl.textContent = 'Select an image to send it to another app'; chips.innerHTML = ''; return; }
      lbl.textContent = 'Send ' + subject + ' to';
      chips.innerHTML = others.map(a => `<button data-to="${esc(a.name)}" title="${esc(a.description || '')}">${esc(a.name)} ↗</button>`).join('');
    }
    function renderItem() {
      const r = sel && items.find(x => x.id === sel);
      if (!r) { sel = null; item.classList.remove('on'); return; }
      item.classList.add('on');
      info.textContent = `${r.w}×${r.h} · ${r.app} · ${new Date(r.created).toLocaleString()}${r.name ? ' · ' + r.name : ''}`;
    }
    async function refresh() {
      try { items = await list(); }
      catch (e) { items = []; grid.innerHTML = `<div class="empty">Shelf storage unavailable here.<br>${esc(e.message)}</div>`; return; }
      urls.forEach(u => URL.revokeObjectURL(u)); urls = [];
      $('.count').textContent = items.length ? items.length + (items.length === 1 ? ' image' : ' images') : '';
      if (!items.length) {
        grid.innerHTML = `<div class="empty">Nothing on the shelf yet.<br>${canSave ? 'Use <b>＋ Save current</b>, or ' : ''}add files, paste, or drop images here.<br>Every snicker02 app sees the same shelf.</div>`;
      } else {
        grid.innerHTML = items.map(r => {
          const u = URL.createObjectURL(r.thumb); urls.push(u);
          return `<button class="th${r.id === sel ? ' sel' : ''}" data-id="${esc(r.id)}" title="${esc(r.app)} · ${r.w}×${r.h}"><img src="${u}" alt="" loading="lazy"><span>${esc(r.app)}</span></button>`;
        }).join('');
      }
      renderItem(); renderChips();
    }
    function open() {
      if (isOpen) return;
      isOpen = true; host.style.display = 'block';
      refresh();
      targets('image').then(t => { tgts = t; renderChips(); });
    }
    function close() {
      if (!isOpen) return;
      isOpen = false; host.style.display = 'none'; sel = null;
      urls.forEach(u => URL.revokeObjectURL(u)); urls = []; grid.innerHTML = '';
    }

    const current = () => { try { return Promise.resolve(opts.getImage()); } catch (e) { return Promise.reject(e); } };
    const meta = () => (typeof opts.getMeta === 'function' ? (opts.getMeta() || {}) : {});
    async function addBlobs(blobs) {
      let n = 0;
      for (const b of blobs) { if (b && /^image\//.test(b.type)) { try { await put(b, { name: b.name || '' }); n++; } catch (e) { failed(e); } } }
      if (n) toast(n === 1 ? 'Added to shelf' : `Added ${n} images`);
    }
    async function loadItem(id) {
      try {
        const f = await file(id);
        if (!f) { toast('That image is gone'); return; }
        const r = items.find(x => x.id === id) || strip(await get(id));
        close();
        await opts.onImage(f, r);
      } catch (e) { failed(e); }
    }

    root.addEventListener('click', async e => {
      const t = e.target.closest('[data-a],[data-to],[data-id]');
      if (!t) { if (e.target.classList.contains('bk')) close(); return; }
      if (t.dataset.id) { sel = sel === t.dataset.id ? null : t.dataset.id; root.querySelectorAll('.th').forEach(b => b.classList.toggle('sel', b.dataset.id === sel)); renderItem(); renderChips(); return; }
      if (t.dataset.to) {
        const p = sel ? sendItem(sel, t.dataset.to) : send(current(), t.dataset.to, Object.assign({ app: currentApp }, meta()));
        p.then(r => toast('Sent to ' + esc(r.app))).catch(failed);
        return;
      }
      switch (t.dataset.a) {
        case 'close': close(); break;
        case 'save':
          t.disabled = true;
          try { await put(current(), Object.assign({ app: currentApp }, meta())); toast('Saved to shelf'); }
          catch (er) { failed(er); } finally { t.disabled = false; }
          break;
        case 'copycur': copy(current()).then(() => toast('Copied to clipboard')).catch(failed); break;
        case 'paste':
          try { const b = await readClipboard(); if (b) await addBlobs([b]); else toast('No image on the clipboard'); }
          catch (er) { failed(er); }
          break;
        case 'load': if (sel) loadItem(sel); break;
        case 'copy': if (sel) copy(get(sel).then(r => r.blob)).then(() => toast('Copied to clipboard')).catch(failed); break;
        case 'dl': if (sel) { const r = await get(sel); if (r) download(r.blob, fileName(r)); } break;
        case 'del': if (sel) { const id = sel; sel = null; remove(id).catch(failed); } break;
      }
    });
    root.addEventListener('dblclick', e => { const t = e.target.closest('[data-id]'); if (t && canLoad) loadItem(t.dataset.id); });
    root.querySelector('input[type=file]').addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; addBlobs(fs); });

    // keep keyboard / drop / paste inside the shelf from reaching the app underneath
    host.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') close(); });
    host.addEventListener('keyup', e => e.stopPropagation());
    ['dragenter', 'dragover'].forEach(ev => host.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); panel.classList.add('drag'); }));
    host.addEventListener('dragleave', e => { e.stopPropagation(); if (!host.contains(e.relatedTarget)) panel.classList.remove('drag'); });
    host.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); panel.classList.remove('drag'); addBlobs([...(e.dataTransfer ? e.dataTransfer.files : [])]); });
    host.addEventListener('paste', e => {
      e.stopPropagation();
      const fs = [...((e.clipboardData && e.clipboardData.items) || [])].filter(i => i.type.indexOf('image/') === 0).map(i => i.getAsFile());
      if (fs.length) { e.preventDefault(); addBlobs(fs); }
    });
    document.addEventListener('keydown', e => { if (isOpen && e.key === 'Escape') { e.stopPropagation(); close(); } }, true);
    onChange(() => { if (isOpen) refresh(); });

    const btn = opts.button === undefined ? fab('⇄ Shelf') : opts.button;
    if (btn) btn.addEventListener('click', () => (isOpen ? close() : open()));

    // incoming hand-off: ?shelf=<id>
    if (canLoad) takeIncoming(opts.onImage, toast);

    return { open, close, refresh, toggle: () => (isOpen ? close() : open()), get isOpen() { return isOpen; } };
  }

  async function takeIncoming(onImage, toast) {
    let u;
    try { u = new URL(location.href); } catch (e) { return; }
    const id = u.searchParams.get('shelf');
    if (!id) return;
    u.searchParams.delete('shelf');
    try { history.replaceState(history.state, '', u.pathname + u.search + u.hash); } catch (e) { /* ignore */ }
    try {
      const r = await get(id);
      if (!r) { toast('Shelf image not found'); return; }
      const f = new File([r.blob], fileName(r), { type: r.type, lastModified: r.created });
      await onImage(f, strip(r));
    } catch (e) {
      console.error('[shelf] incoming image failed', e);
      toast('Could not load the shelf image');
    }
  }

  window.SnickerShelf = {
    VERSION, HOME,
    mount, put, list, count, get, file, remove, clear,
    send, sendItem, copy, readClipboard, apps, targets, onChange,
    download, fileName,
  };
})();
