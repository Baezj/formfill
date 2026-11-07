// Signatures: create (draw / type / upload), edit existing ones (draw over, erase strokes, retype,
// recolor, resize) with undo/redo, and the picker sheet.
import { store } from './store.js';
import { showSheet, hideSheet, setupTabs, selectTab, toast } from './ui.js';

const $ = s => document.querySelector(s);
const FONTS = [
  ['"Great Vibes", cursive', 'Great Vibes'],
  ['"Allura", cursive', 'Allura'],
  ['"Sacramento", cursive', 'Sacramento'],
  ['"Dancing Script", cursive', 'Dancing Script'],
  ['"Homemade Apple", cursive', 'Homemade Apple'],
  ['"Caveat", cursive', 'Caveat']
];
const PAD_RATIO = Math.max(window.devicePixelRatio || 1, 2);

let pad = null, padColor = '#111111', typeFont = 0, uploadCanvas = null, resolver = null, currentKind = 'signature';
let editing = null;        // the saved signature being edited, or null when creating
let base = null;           // {canvas, w, h} image drawn under the pad's strokes (edit mode)
let history = [], future = [];   // snapshots of {base dataUrl|null, strokes, color} for undo/redo
let tool = 'pen';          // 'pen' | 'erase'

// ---------- pad ----------
function ensurePad() {
  const canvas = $('#sig-pad');
  if (!pad) {
    pad = new window.SignaturePad(canvas, { minWidth: 1, maxWidth: 2.6, penColor: padColor, throttle: 8, velocityFilterWeight: 0.6 });
    pad.addEventListener('endStroke', onStrokeEnd);
    // The library ends a stroke only on pointerup. iOS can finish a finger stroke with pointercancel
    // instead; the stroke then stays "open" and the library's document-level pointerup handler
    // calls preventDefault() on the next tap anywhere (e.g. on Undo), which cancels that click.
    const finish = ev => { if (pad && pad._drawingStroke) { pad._drawingStroke = false; pad.dispatchEvent(new CustomEvent('endStroke', { detail: ev })); } };
    canvas.addEventListener('pointercancel', finish);
    canvas.addEventListener('lostpointercapture', finish);
    window.addEventListener('pointerup', ev => { if (pad && pad._drawingStroke && ev.target !== canvas) finish(ev); }, true);
    window.addEventListener('pointerdown', ev => { if (pad && pad._drawingStroke && ev.target !== canvas) finish(ev); }, true);
  }
  const r = canvas.getBoundingClientRect();
  const W = Math.round(r.width * PAD_RATIO), H = Math.round(r.height * PAD_RATIO);
  if (canvas.width !== W || canvas.height !== H) {
    const data = pad.toData();
    canvas.width = W; canvas.height = H;
    canvas.getContext('2d').scale(PAD_RATIO, PAD_RATIO);
    pad.clear(); redrawBase();
    if (data.length) pad.fromData(data, { clear: false });
  }
}
function padSize() { const r = $('#sig-pad').getBoundingClientRect(); return { w: r.width, h: r.height }; }

// Where the base image sits inside the pad (CSS px), centred and scaled to fit with margins.
function baseRect() {
  if (!base) return null;
  const { w, h } = padSize();
  const maxW = w - 32, maxH = h - 40;
  const s = Math.min(maxW / base.w, maxH / base.h, 1.5);
  const bw = base.w * s, bh = base.h * s;
  return { x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh };
}
function redrawBase() {
  const canvas = $('#sig-pad'); const ctx = canvas.getContext('2d');
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore();
  if (!base) return;
  const r = baseRect();
  ctx.drawImage(base.canvas, r.x, r.y, r.w, r.h);
}

// Erase mode: a stroke removes any pen stroke it crosses; if it crosses the base image, it
// punches a transparent hole in it (lets you clean up an uploaded photo signature).
function onStrokeEnd() {
  if (!pad) return;
  if (tool === 'erase') {
    const data = copyStrokes(pad.toData()); const eraser = data.pop();
    const pts = eraser.points;
    const near = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) < 9;
    const kept = data.filter(s => !s.points.some(p => pts.some(q => near(p, q)))).map(st => ({ ...st, penColor: padColor }));
    if (base) {
      const r = baseRect(); const bctx = base.canvas.getContext('2d');
      bctx.save(); bctx.globalCompositeOperation = 'destination-out'; bctx.lineCap = 'round'; bctx.lineJoin = 'round';
      bctx.lineWidth = 14 * (base.w / r.w); bctx.beginPath();
      pts.forEach((p, i) => { const x = (p.x - r.x) * (base.w / r.w), y = (p.y - r.y) * (base.h / r.h); i ? bctx.lineTo(x, y) : bctx.moveTo(x, y); });
      bctx.stroke(); bctx.restore();
    }
    pad.clear(); redrawBase(); pad.fromData(kept, { clear: false });
  }
  pushHistory();
}

// ---------- history ----------
// SignaturePad.toData() returns its live internal array, so snapshots must be deep copies.
function copyStrokes(groups) { return (groups || []).map(g => ({ ...g, points: g.points.map(p => ({ ...p })) })); }
function snapshot() {
  return { base: base ? base.canvas.toDataURL('image/png') : null, bw: base ? base.w : 0, bh: base ? base.h : 0, strokes: copyStrokes(pad ? pad.toData() : []), color: padColor };
}
function pushHistory() { history.push(snapshot()); if (history.length > 40) history.shift(); future = []; updateHistoryButtons(); }
async function restore(s) {
  padColor = s.color; setColorUI();
  if (s.base) { const img = new Image(); img.src = s.base; await img.decode(); const c = document.createElement('canvas'); c.width = s.bw; c.height = s.bh; c.getContext('2d').drawImage(img, 0, 0); base = { canvas: c, w: s.bw, h: s.bh }; }
  else base = null;
  const strokes = copyStrokes(s.strokes).map(st => ({ ...st, penColor: s.color }));
  pad.clear(); redrawBase(); pad.fromData(strokes, { clear: false });
}
async function undo() { if (history.length < 2) return; future.push(history.pop()); await restore(history[history.length - 1]); updateHistoryButtons(); }
async function redo() { if (!future.length) return; const s = future.pop(); history.push(s); await restore(s); updateHistoryButtons(); }
function updateHistoryButtons() { $('#sig-undo').disabled = history.length < 2; $('#sig-redo').disabled = !future.length; }

// ---------- helpers ----------
// Trim transparent edges; returns {dataUrl, w, h} or null if empty.
function trimCanvas(src, padPx = 6) {
  const ctx = src.getContext('2d');
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 10) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX < 0) return null;
  minX = Math.max(0, minX - padPx); minY = Math.max(0, minY - padPx);
  maxX = Math.min(width - 1, maxX + padPx); maxY = Math.min(height - 1, maxY + padPx);
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  out.getContext('2d').drawImage(src, minX, minY, w, h, 0, 0, w, h);
  return { dataUrl: out.toDataURL('image/png'), w, h };
}

async function renderTyped(text, fontIdx, color = padColor) {
  const family = FONTS[fontIdx][0];
  try { await document.fonts.load(`80px ${family}`); } catch { /* fallback font */ }
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `80px ${family}`;
  const m = ctx.measureText(text);
  c.width = Math.ceil(m.width + 60); c.height = 160;
  const ctx2 = c.getContext('2d');
  ctx2.font = `80px ${family}`; ctx2.fillStyle = color; ctx2.textBaseline = 'middle';
  ctx2.fillText(text, 30, 80);
  return trimCanvas(c);
}

function removeWhite(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
    const a = lum > 235 ? 0 : lum > 150 ? Math.round(255 * (235 - lum) / 85) : 255;
    d[i + 3] = Math.min(d[i + 3], a);
  }
  ctx.putImageData(img, 0, 0);
}
// Recolor every opaque pixel (keeps anti-aliasing via alpha).
function tint(canvas, hex) {
  const ctx = canvas.getContext('2d');
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex); if (!m) return;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height); const d = img.data;
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 0) { d[i] = r; d[i + 1] = g; d[i + 2] = b; } }
  ctx.putImageData(img, 0, 0);
}
async function dataUrlToCanvas(dataUrl) {
  const img = new Image(); img.src = dataUrl; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0); return c;
}

async function handleUpload(file) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) { toast('Could not read that image'); return; }
  const scale = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  uploadCanvas = c;
  refreshUploadPreview();
}
function refreshUploadPreview() {
  if (!uploadCanvas) return;
  const c = document.createElement('canvas'); c.width = uploadCanvas.width; c.height = uploadCanvas.height;
  c.getContext('2d').drawImage(uploadCanvas, 0, 0);
  if ($('#sig-remove-bg').checked) removeWhite(c);
  const t = trimCanvas(c);
  $('#sig-upload-preview').src = t ? t.dataUrl : '';
}

function setColorUI() {
  for (const x of $('#sig-colors').children) x.classList.toggle('on', x.dataset.c === padColor);
  if (pad) pad.penColor = padColor;
}
function setTool(t) {
  tool = t;
  $('#sig-pen').classList.toggle('on', t === 'pen'); $('#sig-erase').classList.toggle('on', t === 'erase');
  $('#sig-pad').classList.toggle('erasing', t === 'erase');
  if (pad) { pad.penColor = t === 'erase' ? 'rgba(255,80,80,0.35)' : padColor; pad.minWidth = t === 'erase' ? 6 : 1; pad.maxWidth = t === 'erase' ? 8 : 2.6; }
}

// Buttons next to the drawing pad act on the pointer tap itself. After a drawing gesture on the
// canvas, browsers may not synthesize a click for the very next tap, so a click listener alone
// would silently miss it.
function onTap(el, fn) {
  let down = null;
  el.addEventListener('pointerdown', e => { if (el.disabled) return; down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now() }; });
  el.addEventListener('pointerup', e => {
    if (!down || down.id !== e.pointerId) return;
    const ok = Date.now() - down.t < 800 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 14; down = null;
    if (!ok || el.disabled) return;
    e.preventDefault(); el.dataset.tapped = '1'; fn(e);
    setTimeout(() => { delete el.dataset.tapped; }, 400);
  });
  el.addEventListener('pointercancel', () => { down = null; });
  // Keyboard / assistive tech still get the click; a click right after our tap is ignored.
  el.addEventListener('click', e => { if (el.dataset.tapped) { e.preventDefault(); return; } fn(e); });
}

// ---------- wiring ----------
let wired = false;
function wire() {
  if (wired) return; wired = true;
  setupTabs($('#sig-tabs'), $('#sig-modal'), tab => { if (tab === 'draw') ensurePad(); });
  for (const b of $('#sig-colors').querySelectorAll('button[data-c]')) onTap(b, () => {
    padColor = b.dataset.c; setColorUI();
    if (tool === 'erase') setTool('pen');
    // Recolor what is already on the pad (strokes and base) so the whole signature changes together.
    if (pad && (!pad.isEmpty() || base)) {
      const d = copyStrokes(pad.toData()); d.forEach(s => { s.penColor = padColor; });
      if (base) tint(base.canvas, padColor);
      pad.clear(); redrawBase(); pad.fromData(d, { clear: false });
      pushHistory();
    }
    renderFontList();
  });
  onTap($('#sig-pen'), () => setTool('pen'));
  onTap($('#sig-erase'), () => setTool(tool === 'erase' ? 'pen' : 'erase'));
  onTap($('#sig-undo'), undo);
  onTap($('#sig-redo'), redo);
  onTap($('#sig-clear'), () => { if (!pad) return; base = null; pad.clear(); pushHistory(); });
  $('#sig-type-text').addEventListener('input', renderFontList);
  $('#sig-fonts').addEventListener('click', e => {
    const b = e.target.closest('button[data-f]'); if (!b) return;
    typeFont = +b.dataset.f;
    for (const x of $('#sig-fonts').children) x.classList.toggle('on', x === b);
  });
  $('#sig-upload').addEventListener('change', e => { if (e.target.files[0]) handleUpload(e.target.files[0]); });
  $('#sig-remove-bg').addEventListener('change', refreshUploadPreview);
  $('#sig-save').addEventListener('click', save);
  $('#sig-delete').addEventListener('click', async () => {
    if (!editing) return;
    if (!window.confirm('Delete this ' + (editing.kind === 'initials' ? 'initials' : 'signature') + '?')) return;
    await store.removeSignature(editing.id);
    const r = resolver; resolver = null; hideSheet(); if (r) r(null);
    document.dispatchEvent(new CustomEvent('signatures-changed'));
  });
  window.addEventListener('resize', () => { if (!$('#sig-modal').hidden) ensurePad(); });
  document.addEventListener('keydown', e => {
    if ($('#sig-modal').hidden) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.target.matches('input')) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  });
}

function renderFontList() {
  const text = $('#sig-type-text').value || (store.profile.fullName || 'Your Name');
  const box = $('#sig-fonts'); box.innerHTML = '';
  FONTS.forEach((f, i) => {
    const b = document.createElement('button'); b.dataset.f = i; b.className = i === typeFont ? 'on' : '';
    b.style.fontFamily = f[0]; b.style.color = padColor; b.textContent = text; box.appendChild(b);
  });
}

// Compose base + strokes into one trimmed PNG at the base's native resolution.
function composePad() {
  if (!pad) return null;
  const strokes = pad.toData();
  if (!base && !strokes.length) return null;
  const { w: pw, h: ph } = padSize();
  // Scale factor: keep base pixels sharp (base px per CSS px), at least the pad's own ratio.
  const r = base ? baseRect() : null;
  // Pixel density: the base's native density when editing (no upscaling of an existing signature),
  // otherwise the pad's ratio; never beyond 3x the on-screen size.
  const k = Math.min(3, base ? Math.max(1, base.w / r.w) : PAD_RATIO);
  const c = document.createElement('canvas'); c.width = Math.round(pw * k); c.height = Math.round(ph * k);
  const ctx = c.getContext('2d'); ctx.scale(k, k);
  if (base) ctx.drawImage(base.canvas, r.x, r.y, r.w, r.h);
  // Re-render strokes at this scale with a throwaway SignaturePad.
  if (strokes.length) {
    const tmp = document.createElement('canvas'); tmp.width = c.width; tmp.height = c.height;
    tmp.getContext('2d').scale(k, k);
    const p2 = new window.SignaturePad(tmp, { minWidth: 1, maxWidth: 2.6 });
    p2.fromData(strokes); p2.off();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(tmp, 0, 0);
  }
  return trimCanvas(c, Math.round(6 * k));
}

async function save() {
  const active = $('#sig-tabs button.on').dataset.tab;
  let result = null, meta = {};
  if (active === 'draw') {
    if (tool === 'erase') { setTool('pen'); }
    result = composePad();
    if (!result) { toast('Draw your signature first'); return; }
    meta = { source: 'draw' };
  } else if (active === 'type') {
    const text = $('#sig-type-text').value.trim() || store.profile.fullName;
    if (!text) { toast('Type your name first'); return; }
    result = await renderTyped(text, typeFont);
    meta = { source: 'type', text, font: typeFont, color: padColor };
  } else {
    if (!uploadCanvas) { toast('Choose an image first'); return; }
    const c = document.createElement('canvas'); c.width = uploadCanvas.width; c.height = uploadCanvas.height;
    c.getContext('2d').drawImage(uploadCanvas, 0, 0);
    if ($('#sig-remove-bg').checked) removeWhite(c);
    result = trimCanvas(c);
    meta = { source: 'upload' };
  }
  if (!result) { toast('Nothing to save'); return; }
  const r = resolver; resolver = null;
  hideSheet();
  let sig;
  if (editing) {
    sig = await store.updateSignature(editing.id, { ...result, ...meta });
    toast('Signature updated');
  } else {
    sig = await store.addSignature({ kind: currentKind, ...result, ...meta });
  }
  document.dispatchEvent(new CustomEvent('signatures-changed'));
  if (r) r(sig);
}

function resetModal(kind) {
  wire();
  if (resolver) { const r = resolver; resolver = null; r(null); }
  currentKind = kind; base = null; history = []; future = []; tool = 'pen';
  uploadCanvas = null; $('#sig-upload').value = ''; $('#sig-upload-preview').removeAttribute('src');
  $('#sig-modal').classList.toggle('editing', !!editing);
  $('#sig-delete').hidden = !editing;
}
function openModal(startTab) {
  return new Promise(resolve => {
    resolver = resolve;
    showSheet($('#sig-modal'), { onClose: () => { if (resolver) { const r = resolver; resolver = null; r(null); } } });
    selectTab($('#sig-tabs'), startTab);
    requestAnimationFrame(async () => {
      ensurePad(); pad.clear(); setTool('pen'); setColorUI(); redrawBase();
      if (editing && editing.dataUrl && startTab === 'draw') { pad.clear(); redrawBase(); }
      history = [snapshot()]; future = []; updateHistoryButtons();
    });
  });
}

/** Opens the creator. Resolves with the saved signature, or null if cancelled. */
export function createSignature(kind = 'signature') {
  editing = null;
  resetModal(kind);
  $('#sig-modal-title').textContent = kind === 'initials' ? 'New initials' : 'New signature';
  $('#sig-save').textContent = 'Save & use';
  $('#sig-type-text').value = kind === 'initials' ? initialsOf(store.profile.fullName) : (store.profile.fullName || '');
  renderFontList();
  return openModal('draw');
}

/** Opens an existing signature for editing. Resolves with the updated signature, or null. */
export async function editSignature(sig) {
  editing = sig;
  resetModal(sig.kind);
  $('#sig-modal-title').textContent = sig.kind === 'initials' ? 'Edit initials' : 'Edit signature';
  $('#sig-save').textContent = 'Save changes';
  if (sig.color) padColor = sig.color;
  if (sig.source === 'type') {
    typeFont = sig.font || 0;
    $('#sig-type-text').value = sig.text || '';
    renderFontList();
    // The typed version is also loaded onto the pad so it can be touched up by hand.
  } else {
    $('#sig-type-text').value = sig.kind === 'initials' ? initialsOf(store.profile.fullName) : (store.profile.fullName || '');
    renderFontList();
  }
  const c = await dataUrlToCanvas(sig.dataUrl);
  base = { canvas: c, w: c.width, h: c.height };
  return openModal(sig.source === 'type' ? 'type' : 'draw');
}

function initialsOf(name) {
  return (name || '').split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join('');
}

export function renderSigGrid(el, kind, { manage = false, onPick } = {}) {
  const sigs = store.sigsOf(kind);
  el.classList.toggle('manage', manage);
  if (!sigs.length) { el.innerHTML = `<div class="sig-empty">No ${kind === 'initials' ? 'initials' : 'signatures'} saved yet.</div>`; return; }
  el.innerHTML = sigs.map(s => `<div class="sig-item" data-id="${s.id}"><img src="${s.dataUrl}" alt="">${manage ? '<span class="edit-hint">Edit</span>' : ''}<button class="del" data-del="${s.id}" aria-label="Delete">&times;</button></div>`).join('');
  el.onclick = e => {
    const del = e.target.closest('[data-del]');
    if (del) { if (window.confirm('Delete this signature?')) store.removeSignature(del.dataset.del).then(() => renderSigGrid(el, kind, { manage, onPick })); return; }
    const item = e.target.closest('.sig-item');
    if (item && onPick) onPick(store.signatures.find(s => s.id === item.dataset.id));
  };
}

/** Picker sheet: resolves with a signature (saved or newly created), or null. */
export function pickSignature(kind = 'signature', opts = {}) {
  wire();
  const sheet = $('#sig-picker');
  $('#sig-picker-title').textContent = kind === 'initials' ? 'Choose initials' : 'Choose a signature';
  const sigs = store.sigsOf(kind);
  if (!sigs.length) return createSignature(kind);
  if (sigs.length === 1 && !opts.choose) return Promise.resolve(sigs[0]);
  return new Promise(resolve => {
    let manage = false, done = false;
    const finish = v => { if (done) return; done = true; resolve(v); };
    const grid = $('#sig-grid');
    const draw = () => renderSigGrid(grid, kind, { manage, onPick: async s => {
      if (!manage) { finish(s); hideSheet(); return; }
      done = true; hideSheet(); resolve(await editSignature(s));
    } });
    draw();
    $('#sig-manage').onclick = () => { manage = !manage; $('#sig-manage').textContent = manage ? 'Done' : 'Edit'; draw(); };
    $('#sig-manage').textContent = 'Edit';
    $('#sig-new').onclick = async () => { done = true; hideSheet(); resolve(await createSignature(kind)); };
    showSheet(sheet, { onClose: () => finish(null) });
  });
}
