// The page viewer/editor: renders pages, native form fields, and free-floating marks.
import { pdfjsLib } from './loaders.js';
import { store, formatDate } from './store.js';
import { pickSignature } from './signature.js';
import { toast } from './ui.js';

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const MAX_CANVAS_PX = 14e6;
const COLORS = ['#111111', '#1d3fbf', '#c0392b'];

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
      for (const en of entries) if (en.isIntersecting) this.renderPage(+en.target.dataset.i);
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
  rerenderVisible() {
    const wr = this.wrap.getBoundingClientRect();
    this.pageEls.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (r.bottom > wr.top - 700 && r.top < wr.bottom + 700) this.renderPage(i, true);
      else el.dataset.scale = '';
    });
  }

  // ---------------- page rendering ----------------
  async renderPage(i, force = false) {
    const el = this.pageEls[i]; const pg = this.doc.pages[i];
    if (!el || !pg) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let scale = this.zoom * dpr;
    const px = pg.w * pg.h * scale * scale;
    if (px > MAX_CANVAS_PX) scale *= Math.sqrt(MAX_CANVAS_PX / px);
    const key = scale.toFixed(3);
    if (!force && el.dataset.scale === key) return;
    if (el.dataset.scale === key && this.renderTasks.has(i)) return;
    el.dataset.scale = key;
    const canvas = el.querySelector('canvas');
    const w = Math.round(pg.w * scale), h = Math.round(pg.h * scale);

    if (this.doc.kind === 'pdf' && !pg.added) {
      const prev = this.renderTasks.get(i); if (prev) { try { prev.cancel(); } catch { /* ignore */ } }
      try {
        const page = await this.pdf.getPage(i + 1);
        const vp = page.getViewport({ scale });
        const off = document.createElement('canvas'); off.width = w; off.height = h;
        const task = page.render({ canvasContext: off.getContext('2d'), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS });
        this.renderTasks.set(i, task);
        await task.promise;
        this.renderTasks.delete(i);
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(off, 0, 0);
      } catch (e) {
        this.renderTasks.delete(i);
        if (!(e && e.name === 'RenderingCancelledException')) console.warn('render', e);
      }
    } else {
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      if (pg.image) {
        let bmp = this.bitmaps.get(i);
        if (!bmp) { bmp = await createImageBitmap(pg.image); this.bitmaps.set(i, bmp); }
        ctx.drawImage(bmp, 0, 0, w, h);
      }
    }
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
        const bmp = this.bitmaps.get(0) || await createImageBitmap(pg.image);
        ctx.drawImage(bmp, 0, 0, W, H);
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
        el.addEventListener('input', () => { vals[f.name] = el.value; this.onChange(); });
        if (f.multiLine) el.rows = 1;
      } else if (f.type === 'checkbox' || f.type === 'radio') {
        el = document.createElement('input');
        el.type = f.type; el.dataset.export = f.exportValue;
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
          this.onChange();
        });
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
      if (f.readOnly) el.disabled = true;
      el.style.left = `calc(var(--z) * ${f.x}px)`; el.style.top = `calc(var(--z) * ${f.y}px)`;
      el.style.width = `calc(var(--z) * ${f.w}px)`; el.style.height = `calc(var(--z) * ${f.h}px)`;
      el.addEventListener('pointerdown', e => e.stopPropagation());
      layer.appendChild(el);
    }
    this.syncSigFields();
  }
  syncSigFields() {
    const signed = new Set((this.doc.annots || []).map(a => a.sigField).filter(Boolean));
    for (const el of this.root.querySelectorAll('.sig-field')) el.style.display = signed.has(el.dataset.name) ? 'none' : '';
  }
  fitImageInto(sig, box) {
    const ar = sig.w / sig.h;
    let w = box.w - 4, h = w / ar;
    if (h > box.h - 2) { h = box.h - 2; w = h * ar; }
    return { id: uid(), type: 'image', page: box.page, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h, dataUrl: sig.dataUrl };
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
      const t = el.querySelector('.txt'); if (t.textContent !== a.text) t.textContent = a.text || '';
    } else if (a.type === 'image') {
      const img = el.querySelector('img'); if (img.getAttribute('src') !== a.dataUrl) img.src = a.dataUrl;
    } else {
      const p = el.querySelector('path');
      p.setAttribute('d', a.type === 'check' ? 'M3 13.2l6.7 6.5L21.6 4.3' : 'M3.6 3.6l16.8 16.8M20.4 3.6L3.6 20.4');
      p.setAttribute('stroke', a.color || '#111'); p.setAttribute('stroke-width', '2.9');
    }
  }
  getAnnot(id) { return this.doc.annots.find(a => a.id === id); }
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
    const sel = window.getSelection(); if (sel && t.lastChild) { const r = document.createRange(); r.selectNodeContents(t); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
    this._editStart = a.text;
  }
  stopEditing() {
    if (!this.editingId) return;
    const id = this.editingId; this.editingId = null;
    const a = this.getAnnot(id); const el = this.annotEl(id);
    if (el) { el.classList.remove('editing'); const t = el.querySelector('.txt'); t.contentEditable = 'false'; t.blur(); }
    if (!a) return;
    if (!a.text || !a.text.trim()) { this.doc.annots = this.doc.annots.filter(x => x.id !== id); if (el) el.remove(); if (this.selectedId === id) this.select(null); this.onChange(); }
    else if (a.text !== this._editStart) { this.history.push(JSON.stringify(this.doc.annots.map(x => x.id === id ? { ...x, text: this._editStart } : x))); this.future = []; this.trimHistory(); this.updateUndoButtons(); this.onChange(); }
  }
  annotEl(id) { return this.root.querySelector(`.annot[data-id="${id}"]`); }

  addAnnot(a, { select = true, edit = false } = {}) {
    this.pushHistory();
    this.doc.annots.push(a);
    this.renderAnnot(a);
    if (select) this.select(a.id);
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
    for (const b of document.querySelectorAll('#toolbar .tool[data-tool]')) b.classList.toggle('on', b.dataset.tool === this.tool);
    $('#editor').classList.toggle('tool-active', !!this.tool);
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
      this.addAnnot({ ...base, type: 'image', x: clamp(x - w / 2, 0, pg.w - w), y: clamp(y - h / 2, 0, pg.h - h), w, h, dataUrl: sig.dataUrl });
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
    this.addAnnot({ id: uid(), page: pageIdx, type: 'image', x: clamp(x - w / 2, 0, pg.w - w), y: clamp(y - h / 2, 0, pg.h - h), w, h, dataUrl });
  }

  // ---------------- selection toolbar ----------------
  updateSelBar() {
    const bar = $('#sel-bar'); const a = this.selectedId && this.getAnnot(this.selectedId);
    if (!a) { bar.hidden = true; return; }
    bar.hidden = false; bar.dataset.kind = a.type === 'text' ? 'text' : a.type === 'image' ? 'image' : 'mark';
    $('#sel-swatch').style.background = a.color || '#111';
    bar.querySelector('[data-act="bold"]').style.opacity = a.bold ? 1 : .55;
  }
  selAction(act) {
    const a = this.selectedId && this.getAnnot(this.selectedId); if (!a) return;
    const pg = this.doc.pages[a.page];
    if (act === 'delete') return this.deleteAnnot(a.id);
    if (act === 'dup') { const c = { ...a, id: uid(), x: clamp(a.x + 12, 0, pg.w - a.w), y: clamp(a.y + 12, 0, pg.h - a.h) }; delete c.sigField; return this.addAnnot(c); }
    this.pushHistory();
    if (act === 'smaller' || act === 'bigger') {
      const d = act === 'bigger' ? 1 : -1;
      if (a.type === 'text') { a.size = clamp((a.size || 12) + d, 6, 72); a.h = Math.max(a.h, a.size * 1.2 + 4); }
      else { const s = clamp(a.w + d * 3, 6, 80); a.w = s; a.h = s; }
    } else if (act === 'bold') a.bold = !a.bold;
    else if (act === 'color') { a.color = COLORS[(COLORS.indexOf(a.color || '#111111') + 1) % COLORS.length]; }
    this.renderAnnot(a); this.updateSelBar(); this.onChange();
    if (a.type === 'text') this.autogrow(a);
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
      down = { x: e.clientX, y: e.clientY, t: Date.now() };
    });
    el.addEventListener('pointerup', e => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8; down = null;
      if (moved) return;
      if (this.tool) {
        const r = el.getBoundingClientRect();
        this.placeAt(i, (e.clientX - r.left) / this.zoom, (e.clientY - r.top) / this.zoom);
      } else this.deselect();
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
    const sx = e.clientX, sy = e.clientY, ow = a.w, oh = a.h, os = a.size || 12; const ar = ow / oh;
    const snapshot = JSON.stringify(this.doc.annots); let moved = false;
    this.select(id);
    handle.setPointerCapture(e.pointerId);
    const move = ev => {
      moved = true;
      const dx = (ev.clientX - sx) / this.zoom, dy = (ev.clientY - sy) / this.zoom;
      if (a.type === 'text') { a.w = clamp(ow + dx, 30, pg.w - a.x); a.h = clamp(oh + dy, (a.size || 12) * 1.2 + 4, pg.h - a.y); }
      else if (a.type === 'image') { a.w = clamp(ow + dx, 12, pg.w - a.x); a.h = a.w / ar; }
      else { const s = clamp(ow + Math.max(dx, dy), 6, 120); a.w = s; a.h = s; }
      el.style.setProperty('--w', a.w); el.style.setProperty('--h', a.h);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (moved) { this.history.push(snapshot); this.future = []; this.trimHistory(); this.updateUndoButtons(); if (a.type === 'text') { a.size = os; this.autogrow(a); } this.onChange(); }
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  }

  _wireGlobal() {
    // Pinch zoom (touch) + ctrl/cmd wheel (desktop)
    let pinch = null;
    this.wrap.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        const [a, b] = e.touches;
        pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: this.zoom };
      }
    }, { passive: true });
    this.wrap.addEventListener('touchmove', e => {
      if (e.touches.length === 2 && pinch) {
        e.preventDefault();
        const [a, b] = e.touches;
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        this.setZoom(pinch.z * d / pinch.d, { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
      }
    }, { passive: false });
    this.wrap.addEventListener('touchend', () => { if (pinch) { pinch = null; this.scheduleRerender(); } });
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
    this.onChange();
    requestAnimationFrame(() => this.pageEls[this.pageEls.length - 1].scrollIntoView({ behavior: 'smooth' }));
  }
}
