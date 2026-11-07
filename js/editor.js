// The page viewer/editor: renders pages, native form fields, and free-floating marks.
import { pdfjsLib } from './loaders.js';
import { store, formatDate } from './store.js';
import { pickSignature } from './signature.js';
import { suggestForPage } from './smart.js';
import { toast } from './ui.js';

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const COLORS = ['#111111', '#1d3fbf', '#c0392b'];
// Recolor every opaque pixel of a PNG/JPEG data URL (alpha preserved, so edges stay smooth).
async function tintDataUrl(dataUrl, hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex); if (!m) return dataUrl;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  const img = new Image(); img.src = dataUrl; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height); const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    // Treat near-white as background (uploaded photo signatures) and keep ink darkness as alpha.
    const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const ink = lum > 235 ? 0 : 1;
    if (!ink) { d[i + 3] = 0; continue; }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  ctx.putImageData(id, 0, 0);
  return c.toDataURL('image/png');
}
// Ink points are stored normalized to the annotation box so resizing just scales them.
function inkPath(a) {
  return a.points.map((p, i) => (i ? 'L' : 'M') + (p[0] * a.w).toFixed(1) + ' ' + (p[1] * a.h).toFixed(1)).join(' ');
}

export class Editor {
  constructor({ onChange }) {
    this.wrap = $('#pages-wrap');
    this.root = $('#pages');
    this.onChange = onChange || (() => {});
    this.doc = null; this.pdf = null; this.fieldDefs = [];
    this.zoom = 1; this.tool = null; this.selectedId = null; this.editingId = null;
    this.history = []; this.future = [];
    this.pageEls = []; this.bitmaps = new Map(); this.renderTasks = new Map();
    this.observer = new IntersectionObserver(entries => {
      for (const en of entries) { const i = +en.target.dataset.i; if (en.isIntersecting) this.renderPage(i); else this.releasePage(i); }
    }, { root: this.wrap, rootMargin: '700px 0px' });
    this._wireGlobal();
  }

  // ---------------- lifecycle ----------------
  async load(doc, pdf, fieldDefs) {
    this.destroyPages();
    this.doc = doc; this.pdf = pdf; this.fieldDefs = fieldDefs || [];
    this.history = []; this.future = []; this.selectedId = null; this.editingId = null;
    this.setTool(null);
    this.buildPages();
    this.fitWidth();
    this.updateUndoButtons();
    this.computeHotspots();
  }

  // "Tap to sign" / "Tap for date" spots on signature lines that aren't real form fields.
  async computeHotspots() {
    this.hotspots = [];
    if (!this.pdf || this.doc.kind !== 'pdf') return;
    const token = this._hsToken = (this._hsToken || 0) + 1;
    for (let i = 0; i < this.doc.pages.length; i++) {
      const pg = this.doc.pages[i]; if (pg.added) continue;
      let sugg = [];
      try { sugg = await suggestForPage(await this.pdf.getPage(i + 1), i, pg); } catch { /* ignore */ }
      if (token !== this._hsToken || !this.doc) return;
      for (const s of sugg) {
        if (s.kind === 'text' && s.label && !/\bdate\b/i.test(s.label)) continue;      // only sign / initials / date spots
        if (s.kind === 'text' && !/\bdate\b/i.test(s.label)) continue;
        const box = { page: i, x: s.x, y: s.y, w: s.w, h: s.h };
        if (this.fieldDefs.some(f => f.page === i && this.overlaps(f, box))) continue;   // a real field covers it
        this.hotspots.push({ id: 'h' + i + '_' + this.hotspots.length, kind: s.kind === 'text' ? 'date' : s.kind, ...box });
      }
    }
    this.renderHotspots();
    if (this.onHotspots) this.onHotspots(this.hotspots.length);
  }
  overlaps(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
  renderHotspots() {
    for (const el of this.root.querySelectorAll('.hotspot')) el.remove();
    for (const h of this.hotspots || []) {
      const layer = this.pageEls[h.page]?.querySelector('.pg-fields'); if (!layer) continue;
      const el = document.createElement('div');
      el.className = 'fld sig-field hotspot'; el.dataset.hot = h.id;
      el.textContent = h.kind === 'sign' ? 'Tap to sign' : h.kind === 'initials' ? 'Tap to initial' : 'Tap for date';
      el.style.left = `calc(var(--z) * ${h.x}px)`; el.style.top = `calc(var(--z) * ${h.y}px)`;
      el.style.width = `calc(var(--z) * ${h.w}px)`; el.style.height = `calc(var(--z) * ${h.h}px)`;
      el.addEventListener('pointerdown', ev => ev.stopPropagation());
      el.addEventListener('click', async () => {
        if (h.kind === 'date') {
          const size = Math.min(12, Math.max(9, Math.round(h.h * 0.55)));
          this.addAnnot({ id: uid(), page: h.page, type: 'text', x: h.x + 2, y: h.y + h.h - size * 1.2 - 4, w: Math.max(80, h.w - 4), h: size * 1.2 + 4, size, bold: false, color: store.prefs.color, text: formatDate() });
        } else {
          const sig = await pickSignature(h.kind === 'initials' ? 'initials' : 'signature'); if (!sig) return;
          const a = this.fitImageInto(sig, h); a.x = h.x + 2; a.y = h.y + h.h - a.h; // sit on the line, from the left
          this.addAnnot(a);
        }
        this.syncSigFields();
      });
      layer.appendChild(el);
    }
    this.syncSigFields();
  }
  destroyPages() {
    for (const el of this.pageEls) this.observer.unobserve(el);
    for (const t of this.renderTasks.values()) { try { t.cancel(); } catch { /* ignore */ } }
    this.renderTasks.clear();
    for (const b of this.bitmaps.values()) { if (b && b.close) b.close(); }
    this.bitmaps.clear();
    this.root.innerHTML = ''; this.pageEls = [];
  }
  destroy() {
    this.destroyPages();
    if (this.pdf) { try { this.pdf.destroy(); } catch { /* ignore */ } }
    this.pdf = null; this.doc = null;
  }

  buildPages() {
    this.doc.pages.forEach((pg, i) => {
      const el = document.createElement('div');
      el.className = 'page'; el.dataset.i = i;
      el.style.setProperty('--pw', pg.w); el.style.setProperty('--ph', pg.h);
      el.innerHTML = `<canvas class="pg-canvas"></canvas><div class="pg-fields"></div><div class="pg-annots"></div><div class="pg-num">${i + 1} / ${this.doc.pages.length}</div>`;
      this.root.appendChild(el);
      this.pageEls.push(el);
      this.observer.observe(el);
      this._wirePage(el, i);
    });
    this.buildFields();
    this.renderAllAnnots();
  }

  // ---------------- zoom ----------------
  setZoom(z, anchor) {
    z = clamp(z, 0.25, 5);
    const old = this.zoom;
    if (anchor) {
      const r = this.wrap.getBoundingClientRect();
      const ax = anchor.x - r.left, ay = anchor.y - r.top;
      const cx = (this.wrap.scrollLeft + ax), cy = (this.wrap.scrollTop + ay);
      this.zoom = z; this.root.style.setProperty('--z', z);
      this.wrap.scrollLeft = cx * (z / old) - ax;
      this.wrap.scrollTop = cy * (z / old) - ay;
    } else {
      this.zoom = z; this.root.style.setProperty('--z', z);
    }
    this.scheduleRerender();
  }
  fitWidth() {
    const maxW = Math.max(...this.doc.pages.map(p => p.w));
    const avail = this.wrap.clientWidth - 24;
    this.setZoom(Math.min(2, avail / maxW));
  }
  zoomBy(f, anchor) { this.setZoom(this.zoom * f, anchor); }
  scheduleRerender() {
    clearTimeout(this._rr);
    this._rr = setTimeout(() => this.rerenderVisible(), 160);
  }
  // Render pages near the viewport at the current zoom; release the bitmaps of pages far away.
  rerenderVisible() {
    const wr = this.wrap.getBoundingClientRect();
    this.pageEls.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (r.bottom > wr.top - 700 && r.top < wr.bottom + 700) this.renderPage(i);
      else this.releasePage(i);
    });
  }
  releasePage(i) {
    const el = this.pageEls[i]; if (!el || !el.dataset.scale) return;
    const t = this.renderTasks.get(i); if (t) { try { t.cancel(); } catch { /* ignore */ } this.renderTasks.delete(i); }
    const c = el.querySelector('canvas'); c.width = 0; c.height = 0; el.dataset.scale = '';
  }

  // ---------------- page rendering ----------------
  // Canvas memory is the scarce resource on phones: one shared offscreen canvas, capped pixel
  // budgets, and off-screen pages are released (see rerenderVisible / the observer).
  async renderPage(i) {
    const el = this.pageEls[i]; const pg = this.doc.pages[i];
    if (!el || !pg) return;
    const touch = matchMedia('(pointer: coarse)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, touch ? 2 : 3);
    const maxPx = touch ? 6e6 : 14e6;
    let scale = this.zoom * dpr;
    const px = pg.w * pg.h * scale * scale;
    if (px > maxPx) scale *= Math.sqrt(maxPx / px);
    const key = scale.toFixed(3);
    if (el.dataset.scale === key) return;
    if (el.dataset.pending === key) return;
    el.dataset.pending = key;
    const canvas = el.querySelector('canvas');
    const w = Math.round(pg.w * scale), h = Math.round(pg.h * scale);
    let task = null;
    try {
      if (this.doc.kind === 'pdf' && !pg.added) {
        const prev = this.renderTasks.get(i); if (prev) { try { prev.cancel(); } catch { /* ignore */ } }
        const page = await this.pdf.getPage(i + 1);
        if (el.dataset.pending !== key) return;
        const vp = page.getViewport({ scale });
        // One PDF render at a time through the single shared offscreen canvas.
        await Editor.renderLock(async () => {
          if (el.dataset.pending !== key) return;
          const off = Editor.offscreen(w, h);
          task = page.render({ canvasContext: off.getContext('2d'), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS });
          this.renderTasks.set(i, task);
          try { await task.promise; } finally { if (this.renderTasks.get(i) === task) this.renderTasks.delete(i); }
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(off, 0, 0);
          off.width = 0; off.height = 0;
          el.dataset.scale = key;
        });
        return;
      } else {
        let bmp = pg.image ? this.bitmaps.get(i) : null;
        if (pg.image && !bmp) { bmp = await createImageBitmap(pg.image); this.bitmaps.set(i, bmp); }
        if (el.dataset.pending !== key) return;
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        if (bmp) ctx.drawImage(bmp, 0, 0, w, h);
      }
      el.dataset.scale = key;
    } catch (e) {
      if (task && this.renderTasks.get(i) === task) this.renderTasks.delete(i);
      if (!(e && e.name === 'RenderingCancelledException')) console.warn('render', e);
    } finally {
      if (el.dataset.pending === key) el.dataset.pending = '';
    }
  }
  static renderLock(fn) {
    const run = (Editor._chain || Promise.resolve()).then(fn, fn);
    Editor._chain = run.catch(() => {});
    return run;
  }
  static offscreen(w, h) {
    if (!Editor._off) Editor._off = document.createElement('canvas');
    Editor._off.width = w; Editor._off.height = h;
    return Editor._off;
  }

  async thumbnail() {
    const pg = this.doc.pages[0]; if (!pg) return null;
    const W = 260, scale = W / pg.w, H = Math.round(pg.h * scale);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    try {
      if (this.doc.kind === 'pdf' && !pg.added) {
        const page = await this.pdf.getPage(1);
        await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale }) }).promise;
      } else if (pg.image) {
        const cached = this.bitmaps.get(0); const bmp = cached || await createImageBitmap(pg.image);
        ctx.drawImage(bmp, 0, 0, W, H);
        if (!cached && bmp.close) bmp.close();
      }
    } catch (e) { console.warn('thumb', e); }
    return c.toDataURL('image/jpeg', 0.7);
  }

  // ---------------- form fields ----------------
  buildFields() {
    const vals = this.doc.fields;
    for (const f of this.fieldDefs) {
      const layer = this.pageEls[f.page]?.querySelector('.pg-fields'); if (!layer) continue;
      let el;
      const cur = f.name in vals ? vals[f.name] : f.value;
      if (f.type === 'text') {
        el = document.createElement(f.multiLine ? 'textarea' : 'input');
        if (!f.multiLine) el.type = 'text';
        el.value = cur == null ? '' : String(cur);
        if (f.maxLen) el.maxLength = f.maxLen;
        const fs = f.multiLine ? 10 : clamp(f.h * 0.62, 7, 13);
        el.style.fontSize = `calc(var(--z) * ${fs.toFixed(1)}px)`;
        if (f.align === 1) el.style.textAlign = 'center'; else if (f.align === 2) el.style.textAlign = 'right';
        if (f.comb && f.maxLen) {
          // Space the characters into the comb cells (approximation of the PDF's comb layout).
          const cell = f.w / f.maxLen, charW = fs * 0.6;
          el.style.fontFamily = 'Menlo, Consolas, "Courier New", monospace';
          el.style.letterSpacing = `calc(var(--z) * ${(cell - charW).toFixed(2)}px)`;
          el.style.paddingLeft = `calc(var(--z) * ${((cell - charW) / 2).toFixed(2)}px)`;
          el.style.textAlign = 'left';
        }
        el.addEventListener('input', () => { vals[f.name] = el.value; el.classList.toggle('filled', !!el.value); this.onChange(); });
        el.classList.toggle('filled', !!el.value);
        if (f.multiLine) el.rows = 1;
      } else if (f.type === 'checkbox' || f.type === 'radio') {
        el = document.createElement('input');
        el.type = f.type; el.dataset.export = f.exportValue;
        el.style.setProperty('--fw', Math.min(f.w, f.h));
        if (f.type === 'radio') el.name = 'r_' + f.name;
        el.checked = cur === true || cur === f.exportValue;
        el.addEventListener('change', () => {
          if (f.type === 'radio') {
            vals[f.name] = f.exportValue;
            // Radios in the same group that share an on-state turn on together (as in Acrobat).
            for (const o of this.root.querySelectorAll(`input[type=radio].fld[data-name="${CSS.escape(f.name)}"]`)) o.checked = o.dataset.export === f.exportValue;
          } else {
            vals[f.name] = el.checked ? f.exportValue : false;
            // Siblings sharing the name: same export value stays in sync, different ones go off.
            for (const o of this.root.querySelectorAll(`input[type=checkbox].fld[data-name="${CSS.escape(f.name)}"]`)) {
              if (o === el) continue;
              o.checked = o.dataset.export === f.exportValue ? el.checked : false;
            }
          }
          this.onChange();
        });
      } else if (f.type === 'combo' || f.type === 'list') {
        el = document.createElement('select');
        if (f.type === 'list') el.multiple = true;
        if (f.type === 'combo') el.add(new Option('', ''));
        for (const o of f.options) el.add(new Option(o.label || o.v, o.v));
        const sel = Array.isArray(cur) ? cur : (cur == null ? [] : [cur]);
        for (const o of el.options) o.selected = sel.includes(o.value);
        el.style.fontSize = `calc(var(--z) * ${clamp(f.h * 0.6, 7, 12).toFixed(1)}px)`;
        el.addEventListener('change', () => {
          vals[f.name] = f.type === 'list' ? [...el.selectedOptions].map(o => o.value) : el.value;
          el.classList.toggle('filled', !!el.value); this.onChange();
        });
        el.classList.toggle('filled', !!el.value);
      } else if (f.type === 'sig') {
        el = document.createElement('div');
        el.className = 'sig-field'; el.textContent = 'Tap to sign';
        el.addEventListener('click', async () => {
          const sig = await pickSignature('signature');
          if (!sig) return;
          const a = this.fitImageInto(sig, f);
          a.sigField = f.name;
          this.pushHistory(); this.doc.annots.push(a); this.renderAllAnnots(); this.select(a.id); this.onChange();
        });
      } else continue;
      el.classList.add('fld'); el.dataset.name = f.name;
      el.style.color = store.prefs.color || '#000';
      if (f.readOnly) el.disabled = true;
      el.style.left = `calc(var(--z) * ${f.x}px)`; el.style.top = `calc(var(--z) * ${f.y}px)`;
      el.style.width = `calc(var(--z) * ${f.w}px)`; el.style.height = `calc(var(--z) * ${f.h}px)`;
      el.addEventListener('pointerdown', e => e.stopPropagation());
      // Tiny fields at fit-width are unreadable on a phone: zoom in around the field when it gets focus.
      if (f.type === 'text' || f.type === 'combo' || f.type === 'list') el.addEventListener('focus', () => this.zoomToField(el, f));
      layer.appendChild(el);
    }
    this.syncSigFields();
  }
  // Jump to the next empty text/choice field (wrapping around); returns false when there are none.
  nextField() {
    const els = [...this.root.querySelectorAll('.fld')].filter(el => !el.disabled && (el.tagName === 'INPUT' && el.type === 'text' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'));
    if (!els.length) return false;
    const cur = els.indexOf(document.activeElement);
    const order = [...els.slice(cur + 1), ...els.slice(0, cur + 1)];
    const target = order.find(el => !el.value) || order[0];
    if (!target) return false;
    for (const el of els) el.classList.remove('current');
    target.classList.add('current');
    const f = this.fieldDefs.find(d => d.name === target.dataset.name) || { h: 20 };
    this.deselect();
    target.focus({ preventScroll: true });
    if (f.h * this.zoom < 22 && matchMedia('(pointer: coarse)').matches) this.setZoom(Math.min(2.2, 26 / f.h));
    setTimeout(() => { try { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); } catch { /* ignore */ } }, 30);
    return true;
  }
  // Smart fill for flat pages: place details / date / signature next to detected labels.
  async smartFill() {
    if (!this.pdf || this.doc.kind !== 'pdf') return { placed: 0, signs: 0, needSig: false };
    const sig = store.sigsOf('signature')[0], ini = store.sigsOf('initials')[0];
    let placed = 0, signs = 0, needSig = false, already = 0;
    const overlaps = (a, b) => a.page === b.page && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const additions = [];
    for (let i = 0; i < this.doc.pages.length; i++) {
      const pg = this.doc.pages[i]; if (pg.added) continue;
      const hasFields = this.fieldDefs.some(f => f.page === i);
      let sugg = [];
      try { sugg = await suggestForPage(await this.pdf.getPage(i + 1), i, pg); } catch (e) { console.warn('smart', e); }
      for (const s of sugg) {
        // On pages with real fields, only signature / initials / date spots make sense, and never over a field.
        if (hasFields && (s.kind === 'text' && !/\bdate\b/i.test(s.label || ''))) continue;
        if (this.fieldDefs.some(f => f.page === i && this.overlaps(f, s))) continue;
        let a;
        if (s.kind === 'text') a = { id: uid(), page: i, type: 'text', x: s.x, y: s.y, w: s.w, h: s.h, size: s.size, bold: false, color: store.prefs.color, text: s.text };
        else {
          const img = s.kind === 'sign' ? sig : ini;
          if (!img) { needSig = true; continue; }
          const ar = img.w / img.h; let h = s.h, w = h * ar; if (w > s.w) { w = s.w; h = w / ar; }
          a = { id: uid(), page: i, type: 'image', x: s.x, y: s.y + (s.h - h), w, h, imgId: this.storeImage(img.dataUrl) };
        }
        const zone = { page: i, x: s.x, y: s.y, w: s.w, h: s.h };
        if (this.doc.annots.some(x => overlaps(x, zone)) || additions.some(x => overlaps(x, zone))) { already++; continue; }
        additions.push(a); if (a.type === 'image') signs++; else placed++;
      }
    }
    if (additions.length) {
      this.pushHistory();
      this.doc.annots.push(...additions);
      this.renderAllAnnots(); this.onChange();
      const first = this.annotEl(additions[0].id); if (first) setTimeout(() => first.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
    }
    return { placed, signs, needSig, already };
  }
  emptyFieldCount() {
    return [...this.root.querySelectorAll('.fld')].filter(el => !el.disabled && (el.tagName === 'INPUT' && el.type === 'text' || el.tagName === 'TEXTAREA') && !el.value).length;
  }
  zoomToField(el, f) {
    if (f.h * this.zoom >= 22 || !matchMedia('(pointer: coarse)').matches) return;
    const r = el.getBoundingClientRect();
    this.setZoom(Math.min(2.2, 26 / f.h), { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    setTimeout(() => { try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch { /* ignore */ } }, 50);
  }
  syncSigFields() {
    const signed = new Set((this.doc.annots || []).map(a => a.sigField).filter(Boolean));
    for (const el of this.root.querySelectorAll('.sig-field:not(.hotspot)')) el.style.display = signed.has(el.dataset.name) ? 'none' : '';
    // Hotspots disappear once something has been placed over them.
    for (const h of this.hotspots || []) {
      const el = this.root.querySelector(`.hotspot[data-hot="${h.id}"]`); if (!el) continue;
      el.style.display = (this.doc.annots || []).some(a => a.page === h.page && this.overlaps(a, h)) ? 'none' : '';
    }
  }
  fitImageInto(sig, box) {
    const ar = sig.w / sig.h;
    let w = box.w - 4, h = w / ar;
    if (h > box.h - 2) { h = box.h - 2; w = h * ar; }
    return { id: uid(), type: 'image', page: box.page, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h, imgId: this.storeImage(sig.dataUrl) };
  }

  // Fill text fields by matching their names to the profile. Returns the count filled.
  autofill() {
    const p = store.profile, vals = this.doc.fields; let n = 0;
    const today = formatDate();
    const rules = [
      [/e.?mail/, p.email], [/phone|tel\b|telephone|mobile|cell/, p.phone],
      [/birth|dob/, p.dob], [/zip|postal/, p.zip], [/city|town/, p.city], [/\bstate\b|province/, p.state],
      [/address|street/, p.address], [/company|employer|organization/, p.company], [/job.*title|position|occupation/, p.title],
      [/(first|given).*name|fname|first$/, p.firstName], [/(last|family|sur).*name|lname|last$/, p.lastName],
      [/full.*name|\bname\b|print|signer|your.*name/, p.fullName],
      [/\bdate\b|signed on/, today]
    ];
    for (const f of this.fieldDefs) {
      if (f.type !== 'text' || f.readOnly) continue;
      const existing = f.name in vals ? vals[f.name] : f.value;
      if (existing) continue;
      const key = f.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
      for (const [re, v] of rules) {
        if (!v) continue;
        if (re.test(key)) {
          if (/birth|dob/.test(key) && v === today) continue;
          vals[f.name] = v; n++;
          const el = this.root.querySelector(`.fld[data-name="${CSS.escape(f.name)}"]`); if (el) el.value = v;
          break;
        }
      }
    }
    if (n) this.onChange();
    return n;
  }

  // ---------------- annotations ----------------
  renderAllAnnots() {
    for (const el of this.pageEls) el.querySelector('.pg-annots').innerHTML = '';
    for (const a of this.doc.annots) this.renderAnnot(a);
    this.syncSigFields();
    this.updateSelBar();
  }
  renderAnnot(a) {
    const layer = this.pageEls[a.page]?.querySelector('.pg-annots'); if (!layer) return;
    let el = layer.querySelector(`[data-id="${a.id}"]`);
    if (!el) {
      el = document.createElement('div'); el.dataset.id = a.id;
      el.innerHTML = (a.type === 'text' ? `<div class="txt" contenteditable="false" spellcheck="false"></div>` :
        a.type === 'image' ? `<img draggable="false" alt="">` :
        a.type === 'ink' ? `<svg preserveAspectRatio="none"><path fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>` :
        `<svg viewBox="0 0 24 24"><path fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`) +
        `<div class="h-del" title="Delete">&times;</div><div class="h-rs" title="Resize"></div>`;
      layer.appendChild(el);
    }
    el.className = `annot ${a.type === 'text' ? 'text' : a.type === 'image' ? 'image' : 'mark'}` +
      (a.bold ? ' bold' : '') + (a.id === this.selectedId ? ' selected' : '') + (a.id === this.editingId ? ' editing' : '');
    el.style.setProperty('--x', a.x); el.style.setProperty('--y', a.y);
    el.style.setProperty('--w', a.w); el.style.setProperty('--h', a.h);
    if (a.type === 'text') {
      el.style.setProperty('--fs', a.size || 12); el.style.setProperty('--c', a.color || '#111');
      const t = el.querySelector('.txt'); if (a.id !== this.editingId && t.textContent !== a.text) t.textContent = a.text || '';
    } else if (a.type === 'image') {
      const src = this.imageSrc(a); const img = el.querySelector('img'); if (img.getAttribute('src') !== src) img.src = src;
    } else if (a.type === 'ink') {
      const svg = el.querySelector('svg'); svg.setAttribute('viewBox', `0 0 ${a.w} ${a.h}`);
      const p = el.querySelector('path');
      p.setAttribute('d', inkPath(a)); p.setAttribute('stroke', a.color || '#111'); p.setAttribute('stroke-width', a.width || 2);
    } else {
      const p = el.querySelector('path');
      p.setAttribute('d', a.type === 'check' ? 'M3 13.2l6.7 6.5L21.6 4.3' : 'M3.6 3.6l16.8 16.8M20.4 3.6L3.6 20.4');
      p.setAttribute('stroke', a.color || '#111'); p.setAttribute('stroke-width', '2.9');
    }
  }
  getAnnot(id) { return this.doc.annots.find(a => a.id === id); }
  imageSrc(a) { return a.dataUrl || (this.doc.images && this.doc.images[a.imgId]) || ''; }
  // Image bytes live once in doc.images; annotations only reference them (keeps history/autosave small).
  storeImage(dataUrl) {
    if (!this.doc.images) this.doc.images = {};
    for (const [k, v] of Object.entries(this.doc.images)) if (v === dataUrl) return k;
    const id = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.doc.images[id] = dataUrl; return id;
  }
  select(id) {
    if (this.selectedId && this.selectedId !== id) this.stopEditing();
    this.selectedId = id;
    for (const el of this.root.querySelectorAll('.annot')) el.classList.toggle('selected', el.dataset.id === id);
    this.updateSelBar();
  }
  deselect() { this.stopEditing(); this.select(null); }
  startEditing(id) {
    const a = this.getAnnot(id); if (!a || a.type !== 'text') return;
    this.editingId = id;
    const el = this.annotEl(id); el.classList.add('editing');
    const t = el.querySelector('.txt'); t.contentEditable = 'true'; t.focus();
    this.updateSelBar();
    const sel = window.getSelection(); if (sel && t.lastChild) { const r = document.createRange(); r.selectNodeContents(t); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
    this._editStart = a.text;
  }
  stopEditing() {
    if (!this.editingId) return;
    const id = this.editingId; this.editingId = null;
    const a = this.getAnnot(id); const el = this.annotEl(id);
    if (el) { el.classList.remove('editing'); const t = el.querySelector('.txt'); t.contentEditable = 'false'; t.blur(); }
    this.updateSelBar();
    if (!a) return;
    if (!a.text || !a.text.trim()) {
      this.doc.annots = this.doc.annots.filter(x => x.id !== id); if (el) el.remove(); if (this.selectedId === id) this.select(null);
      if (this._justAdded === id && this.history.length) { this.history.pop(); this.updateUndoButtons(); } // nothing to undo
      this.onChange();
    }
    else if (a.text !== this._editStart) { this.history.push(JSON.stringify(this.doc.annots.map(x => x.id === id ? { ...x, text: this._editStart } : x))); this.future = []; this.trimHistory(); this.updateUndoButtons(); this.onChange(); }
  }
  annotEl(id) { return this.root.querySelector(`.annot[data-id="${id}"]`); }

  addAnnot(a, { select = true, edit = false } = {}) {
    this.pushHistory();
    this.doc.annots.push(a);
    this.renderAnnot(a);
    if (select) this.select(a.id);
    this._justAdded = edit ? a.id : null;
    if (edit) this.startEditing(a.id);
    this.onChange();
    return a;
  }
  deleteAnnot(id) {
    const a = this.getAnnot(id); if (!a) return;
    this.pushHistory();
    this.doc.annots = this.doc.annots.filter(x => x.id !== id);
    const el = this.annotEl(id); if (el) el.remove();
    if (this.selectedId === id) { this.editingId = null; this.select(null); }
    this.syncSigFields(); this.onChange();
  }
  updateAnnot(a) { this.renderAnnot(a); this.onChange(); }
  clearAnnots() { if (!this.doc.annots.length) return; this.pushHistory(); this.doc.annots = []; this.renderAllAnnots(); this.select(null); this.onChange(); }

  // ---------------- history ----------------
  pushHistory() { this.history.push(JSON.stringify(this.doc.annots)); this.future = []; this.trimHistory(); this.updateUndoButtons(); }
  trimHistory() { if (this.history.length > 80) this.history.splice(0, this.history.length - 80); }
  undo() { if (!this.history.length) return; this.stopEditing(); this.future.push(JSON.stringify(this.doc.annots)); this.doc.annots = JSON.parse(this.history.pop()); this.renderAllAnnots(); this.select(null); this.updateUndoButtons(); this.onChange(); }
  redo() { if (!this.future.length) return; this.stopEditing(); this.history.push(JSON.stringify(this.doc.annots)); this.doc.annots = JSON.parse(this.future.pop()); this.renderAllAnnots(); this.select(null); this.updateUndoButtons(); this.onChange(); }
  updateUndoButtons() { $('#btn-undo').disabled = !this.history.length; $('#btn-redo').disabled = !this.future.length; }

  // ---------------- tools ----------------
  setTool(t) {
    this.tool = this.tool === t ? null : t;
    for (const b of document.querySelectorAll('.tool[data-tool]')) b.classList.toggle('on', b.dataset.tool === this.tool);
    $('#editor').classList.toggle('tool-active', !!this.tool);
    $('#editor').classList.toggle('tool-draw', this.tool === 'draw');
    if (this.tool) this.deselect();
    return this.tool;
  }

  async placeAt(pageIdx, x, y) {
    const pg = this.doc.pages[pageIdx]; const prefs = store.prefs; const tool = this.tool;
    const base = { id: uid(), page: pageIdx, color: prefs.color };
    if (tool === 'text' || tool === 'date') {
      const size = prefs.fontSize || 12, w = Math.min(200, pg.w - x - 4), h = size * 1.2 + 4;
      const a = { ...base, type: 'text', x: clamp(x - 3, 0, pg.w - 40), y: clamp(y - h / 2, 0, pg.h - h), w: Math.max(60, w), h, size, bold: false, text: tool === 'date' ? formatDate() : '' };
      this.setTool(null);
      this.addAnnot(a, { select: true, edit: tool === 'text' });
    } else if (tool === 'check' || tool === 'cross') {
      const s = 14;
      this.addAnnot({ ...base, type: tool, x: clamp(x - s / 2, 0, pg.w - s), y: clamp(y - s / 2, 0, pg.h - s), w: s, h: s }, { select: false });
    } else if (tool === 'sign' || tool === 'initials') {
      const kind = tool === 'initials' ? 'initials' : 'signature';
      this.setTool(null);
      const sig = await pickSignature(kind);
      if (!sig) return;
      const w = Math.min(kind === 'initials' ? 46 : 150, pg.w - 10), h = w * sig.h / sig.w;
      this.addAnnot({ ...base, type: 'image', x: clamp(x - w / 2, 0, pg.w - w), y: clamp(y - h / 2, 0, pg.h - h), w, h, imgId: this.storeImage(sig.dataUrl) });
    } else if (tool === 'fill') {
      this.setTool(null);
      if (this.onQuickFill) this.onQuickFill(pageIdx, x, y);
    } else if (tool === 'image') {
      this.setTool(null);
      if (this.onImagePick) this.onImagePick(pageIdx, x, y);
    }
  }
  placeText(pageIdx, x, y, text) {
    const pg = this.doc.pages[pageIdx]; const size = store.prefs.fontSize || 12; const h = size * 1.2 + 4;
    const w = Math.min(Math.max(60, text.length * size * 0.55 + 12), pg.w - 4);
    this.addAnnot({ id: uid(), page: pageIdx, type: 'text', x: clamp(x - 3, 0, pg.w - w), y: clamp(y - h / 2, 0, pg.h - h), w, h, size, bold: false, color: store.prefs.color, text });
  }
  async placeImageFile(pageIdx, x, y, file) {
    const bmp = await createImageBitmap(file).catch(() => null); if (!bmp) { toast('Could not read image'); return; }
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL(/png/i.test(file.type) ? 'image/png' : 'image/jpeg', 0.85);
    const pg = this.doc.pages[pageIdx]; const w = Math.min(200, pg.w - 10), h = w * c.height / c.width;
    this.addAnnot({ id: uid(), page: pageIdx, type: 'image', x: clamp(x - w / 2, 0, pg.w - w), y: clamp(y - h / 2, 0, pg.h - h), w, h, imgId: this.storeImage(dataUrl) });
  }

  // ---------------- selection toolbar ----------------
  updateSelBar() {
    const bar = $('#sel-bar'); const a = this.selectedId && this.getAnnot(this.selectedId);
    if (!a) { bar.hidden = true; return; }
    bar.hidden = false; bar.dataset.kind = a.type === 'text' ? 'text' : a.type === 'image' ? 'image' : 'mark';
    if (this.editingId === a.id) bar.dataset.editing = '1'; else delete bar.dataset.editing;
    if (a.type === 'image' && !this._imgTipShown && this.onFirstImageSelect) { this._imgTipShown = true; this.onFirstImageSelect(); }
    $('#sel-swatch').style.background = a.color || '#111';
    bar.querySelector('[data-act="bold"]').style.opacity = a.bold ? 1 : .55;
  }
  selAction(act) {
    const a = this.selectedId && this.getAnnot(this.selectedId); if (!a) return;
    const pg = this.doc.pages[a.page];
    if (act === 'done') { this.stopEditing(); this.updateSelBar(); return; }
    if (act === 'delete') return this.deleteAnnot(a.id);
    if (act === 'dup') { const c = { ...a, id: uid(), x: clamp(a.x + 12, 0, pg.w - a.w), y: clamp(a.y + 12, 0, pg.h - a.h) }; delete c.sigField; return this.addAnnot(c); }
    this.pushHistory();
    if (act === 'smaller' || act === 'bigger') {
      const d = act === 'bigger' ? 1 : -1;
      if (a.type === 'text') { a.size = clamp((a.size || 12) + d, 6, 72); a.h = Math.max(a.h, a.size * 1.2 + 4); }
      else if (a.type === 'ink') { const f = d > 0 ? 1.15 : 1 / 1.15; a.w *= f; a.h *= f; a.width = (a.width || 2) * f; }
      else { const s = clamp(a.w + d * 3, 6, 80); a.w = s; a.h = s; }
    } else if (act === 'bold') a.bold = !a.bold;
    else if (act === 'color') {
      a.color = COLORS[(COLORS.indexOf(a.color || '#111111') + 1) % COLORS.length];
      if (a.type === 'image') { this.recolorImage(a); return; }
    }
    this.renderAnnot(a); this.updateSelBar(); this.onChange();
    if (a.type === 'text') this.autogrow(a);
  }
  // Change the ink of everything on the document (one undo step).
  async applyInkColor(color) {
    for (const el of this.root.querySelectorAll('.fld')) el.style.color = color;
    if (!this.doc.annots.length) return 0;
    this.pushHistory();
    let n = 0;
    for (const a of this.doc.annots) {
      if (a.color === color && a.type !== 'image') continue;
      a.color = color; n++;
      if (a.type === 'image') {
        if (!a.srcImgId) a.srcImgId = a.imgId;
        const src = (this.doc.images && this.doc.images[a.srcImgId]) || a.dataUrl; if (!src) continue;
        a.imgId = this.storeImage(await tintDataUrl(src, color)); delete a.dataUrl;
      }
    }
    this.renderAllAnnots(); this.onChange();
    return n;
  }
  // Re-tint a placed signature/initials/image from its original pixels (never from a previous tint).
  async recolorImage(a) {
    if (!a.srcImgId) a.srcImgId = a.imgId;
    const src = (this.doc.images && this.doc.images[a.srcImgId]) || a.dataUrl; if (!src) return;
    const tinted = await tintDataUrl(src, a.color);
    a.imgId = this.storeImage(tinted); delete a.dataUrl;
    this.renderAnnot(a); this.updateSelBar(); this.onChange();
  }
  autogrow(a) {
    const el = this.annotEl(a.id); if (!el) return;
    const t = el.querySelector('.txt');
    const need = t.scrollHeight / this.zoom;
    if (need > a.h + 1) { a.h = need; el.style.setProperty('--h', a.h); }
  }

  // ---------------- events ----------------
  _wirePage(el, i) {
    let down = null;
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const annotEl = e.target.closest('.annot');
      if (annotEl) {
        if (e.target.closest('.h-del')) { e.preventDefault(); this.deleteAnnot(annotEl.dataset.id); return; }
        if (e.target.closest('.h-rs')) { e.preventDefault(); this._startResize(e, annotEl.dataset.id); return; }
        if (annotEl.classList.contains('editing')) return; // let the caret work
        e.preventDefault();
        this._startDrag(e, annotEl.dataset.id);
        return;
      }
      if (this.tool === 'draw') { e.preventDefault(); this._startInk(e, el, i); return; }
      down = { x: e.clientX, y: e.clientY, t: Date.now() };
    });
    el.addEventListener('pointerup', e => {
      if (!down || this.pinching) { down = null; return; }
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8; const d = down; down = null;
      if (moved) return;
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / this.zoom, py = (e.clientY - r.top) / this.zoom;
      if (this.tool) { this.placeAt(i, px, py); return; }
      // Double-tap on empty page = new text box (the most common action).
      const last = this._lastTap;
      if (last && d.t - last.t < 350 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 24) {
        this._lastTap = null; this.tool = 'text'; this.placeAt(i, px, py); return;
      }
      this._lastTap = { t: d.t, x: e.clientX, y: e.clientY };
      this.deselect();
    });
    el.addEventListener('pointercancel', () => { down = null; });
    // Text editing: input → autogrow + model update
    el.addEventListener('input', e => {
      const t = e.target.closest('.txt'); if (!t) return;
      const a = this.getAnnot(t.closest('.annot').dataset.id); if (!a) return;
      a.text = t.innerText.replace(/\n$/, '');
      this.autogrow(a);
    });
    el.addEventListener('focusout', e => {
      const t = e.target.closest && e.target.closest('.txt'); if (!t) return;
      const id = t.closest('.annot').dataset.id;
      setTimeout(() => { if (this.editingId === id && document.activeElement !== t) this.stopEditing(); }, 50);
    });
    el.addEventListener('paste', e => {
      const t = e.target.closest('.txt'); if (!t) return;
      e.preventDefault(); const txt = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, txt);
    });
  }

  _startInk(e, pageEl, pageIdx) {
    const r = pageEl.getBoundingClientRect(); const z = this.zoom; const pg = this.doc.pages[pageIdx];
    const pts = [[(e.clientX - r.left) / z, (e.clientY - r.top) / z]];
    const layer = pageEl.querySelector('.pg-annots');
    const live = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    live.setAttribute('class', 'ink-live'); live.setAttribute('viewBox', `0 0 ${pg.w} ${pg.h}`);
    live.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const color = store.prefs.color, width = store.prefs.inkWidth || 2;
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', color); path.setAttribute('stroke-width', width);
    path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
    live.appendChild(path); layer.appendChild(live);
    const draw = () => { path.setAttribute('d', pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')); };
    draw();
    pageEl.setPointerCapture(e.pointerId);
    const move = ev => {
      const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
      for (const c of evs) {
        const x = clamp((c.clientX - r.left) / z, 0, pg.w), y = clamp((c.clientY - r.top) / z, 0, pg.h);
        const last = pts[pts.length - 1];
        if (Math.hypot(x - last[0], y - last[1]) > 0.7) pts.push([x, y]);
      }
      draw();
    };
    const up = () => {
      pageEl.removeEventListener('pointermove', move); pageEl.removeEventListener('pointerup', up); pageEl.removeEventListener('pointercancel', up);
      try { pageEl.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      live.remove();
      if (pts.length < 2) pts.push([pts[0][0] + 0.5, pts[0][1] + 0.5]); // a dot
      const pad = width;
      const minX = Math.min(...pts.map(p => p[0])) - pad, maxX = Math.max(...pts.map(p => p[0])) + pad;
      const minY = Math.min(...pts.map(p => p[1])) - pad, maxY = Math.max(...pts.map(p => p[1])) + pad;
      const w = Math.max(2, maxX - minX), h = Math.max(2, maxY - minY);
      const points = pts.map(p => [+((p[0] - minX) / w).toFixed(4), +((p[1] - minY) / h).toFixed(4)]);
      this.addAnnot({ id: uid(), page: pageIdx, type: 'ink', x: minX, y: minY, w, h, points, color, width }, { select: false });
    };
    pageEl.addEventListener('pointermove', move); pageEl.addEventListener('pointerup', up); pageEl.addEventListener('pointercancel', up);
  }

  _startDrag(e, id) {
    const a = this.getAnnot(id); if (!a) return;
    const el = this.annotEl(id); const pg = this.doc.pages[a.page];
    const sx = e.clientX, sy = e.clientY, ox = a.x, oy = a.y; let moved = false; const wasSelected = this.selectedId === id;
    const snapshot = JSON.stringify(this.doc.annots);
    el.setPointerCapture(e.pointerId);
    const move = ev => {
      const dx = (ev.clientX - sx) / this.zoom, dy = (ev.clientY - sy) / this.zoom;
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      if (!moved) { moved = true; this.select(id); }
      a.x = clamp(ox + dx, -a.w * 0.5, pg.w - a.w * 0.5); a.y = clamp(oy + dy, -a.h * 0.5, pg.h - a.h * 0.5);
      el.style.setProperty('--x', a.x); el.style.setProperty('--y', a.y);
    };
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (moved) { this.history.push(snapshot); this.future = []; this.trimHistory(); this.updateUndoButtons(); this.onChange(); }
      else if (wasSelected && a.type === 'text') this.startEditing(id);
      else this.select(id);
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  }

  _startResize(e, id) {
    const a = this.getAnnot(id); if (!a) return;
    const el = this.annotEl(id); const pg = this.doc.pages[a.page]; const handle = el.querySelector('.h-rs');
    const sx = e.clientX, sy = e.clientY, ow = a.w, oh = a.h, os = a.size || 12, oInk = a.width || 2; const ar = ow / oh;
    const snapshot = JSON.stringify(this.doc.annots); let moved = false;
    this.select(id);
    handle.setPointerCapture(e.pointerId);
    const move = ev => {
      moved = true;
      const dx = (ev.clientX - sx) / this.zoom, dy = (ev.clientY - sy) / this.zoom;
      if (a.type === 'text') { a.w = clamp(ow + dx, 30, pg.w - a.x); a.h = clamp(oh + dy, (a.size || 12) * 1.2 + 4, pg.h - a.y); }
      else if (a.type === 'image' || a.type === 'ink') { a.w = clamp(ow + dx, 6, pg.w - a.x); a.h = a.w / ar; if (a.type === 'ink') a.width = (a.width || 2) * (a.w / ow); }
      else { const s = clamp(ow + Math.max(dx, dy), 6, 120); a.w = s; a.h = s; }
      el.style.setProperty('--w', a.w); el.style.setProperty('--h', a.h);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (moved) { this.history.push(snapshot); this.future = []; this.trimHistory(); this.updateUndoButtons(); if (a.type === 'text') { a.size = os; this.autogrow(a); } if (a.type === 'ink') a.width = oInk * (a.w / ow); this.onChange(); }
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  }

  _wireGlobal() {
    // Pinch zoom (touch) + ctrl/cmd wheel (desktop)
    // Pinch: scale the page stack with a CSS transform while the fingers move (cheap), then commit
    // one real zoom on release. While pinching, taps are ignored so a pinch never places a mark.
    let pinch = null;
    this.pinching = false;
    this.wrap.addEventListener('touchstart', e => {
      if (e.touches.length >= 2) {
        const [a, b] = e.touches;
        const r = this.wrap.getBoundingClientRect();
        const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
        pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: this.zoom, f: 1, mx, my,
          ox: this.wrap.scrollLeft + mx - r.left, oy: this.wrap.scrollTop + my - r.top };
        this.pinching = true;
        this.root.style.transformOrigin = `${pinch.ox}px ${pinch.oy}px`;
      }
    }, { passive: true });
    this.wrap.addEventListener('touchmove', e => {
      if (e.touches.length >= 2 && pinch) {
        e.preventDefault();
        const [a, b] = e.touches;
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        pinch.f = clamp(pinch.z * d / pinch.d, 0.25, 5) / pinch.z;
        this.root.style.transform = `scale(${pinch.f})`;
      }
    }, { passive: false });
    const endPinch = e => {
      if (!pinch) return;
      if (e.touches.length > 0) return;
      const p = pinch; pinch = null;
      this.root.style.transform = ''; this.root.style.transformOrigin = '';
      this.setZoom(p.z * p.f, { x: p.mx, y: p.my });
      setTimeout(() => { this.pinching = false; }, 80);
    };
    this.wrap.addEventListener('touchend', endPinch);
    this.wrap.addEventListener('touchcancel', endPinch);
    this.wrap.addEventListener('wheel', e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.01), { x: e.clientX, y: e.clientY });
    }, { passive: false });
    document.addEventListener('gesturestart', e => e.preventDefault());

    $('#sel-bar').addEventListener('pointerdown', e => e.preventDefault());
    $('#sel-bar').addEventListener('click', e => { const b = e.target.closest('button[data-act]'); if (b) this.selAction(b.dataset.act); });

    document.addEventListener('keydown', e => {
      if (!this.doc || $('#editor').hidden) return;
      const typing = e.target.closest && (e.target.closest('.txt') || e.target.matches('input, textarea, select'));
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { if (typing && this.editingId) return; e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
      if (e.key === 'Escape' && this.editingId) { e.preventDefault(); this.stopEditing(); return; }
      if (typing) return;
      if (!this.selectedId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteAnnot(this.selectedId); }
      else if (e.key === 'Escape') this.deselect();
      else if (e.key.startsWith('Arrow')) {
        e.preventDefault(); const a = this.getAnnot(this.selectedId); const s = e.shiftKey ? 10 : 1;
        this.pushHistory();
        if (e.key === 'ArrowLeft') a.x -= s; if (e.key === 'ArrowRight') a.x += s; if (e.key === 'ArrowUp') a.y -= s; if (e.key === 'ArrowDown') a.y += s;
        this.renderAnnot(a); this.onChange();
      } else if (e.key === 'Enter') { const a = this.getAnnot(this.selectedId); if (a.type === 'text') { e.preventDefault(); this.startEditing(a.id); } }
    });
    window.addEventListener('resize', () => { if (this.doc && !$('#editor').hidden) this.scheduleRerender(); });
  }

  // ---------------- pages ----------------
  addPages(pages) {
    for (const pg of pages) { pg.added = true; this.doc.pages.push(pg); }
    this.destroyPages();
    this.buildPages();
    this.renderHotspots();
    this.onChange();
    requestAnimationFrame(() => this.pageEls[this.pageEls.length - 1].scrollIntoView({ behavior: 'smooth' }));
  }
}
