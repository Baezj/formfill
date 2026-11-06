// Signature creation (draw / type / upload) and the picker sheet.
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

let pad = null, padColor = '#111111', typeFont = 0, uploadCanvas = null, resolver = null, currentKind = 'signature';

function ensurePad() {
  const canvas = $('#sig-pad');
  if (!pad) {
    pad = new window.SignaturePad(canvas, { minWidth: 1, maxWidth: 2.6, penColor: padColor, throttle: 8, velocityFilterWeight: 0.6 });
  }
  const ratio = Math.max(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  if (canvas.width !== Math.round(r.width * ratio)) {
    canvas.width = Math.round(r.width * ratio); canvas.height = Math.round(r.height * ratio);
    canvas.getContext('2d').scale(ratio, ratio);
    pad.clear();
  }
}

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

async function renderTyped(text, fontIdx) {
  const family = FONTS[fontIdx][0];
  try { await document.fonts.load(`80px ${family}`); } catch { /* fallback font */ }
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `80px ${family}`;
  const m = ctx.measureText(text);
  c.width = Math.ceil(m.width + 60); c.height = 160;
  const ctx2 = c.getContext('2d');
  ctx2.font = `80px ${family}`; ctx2.fillStyle = padColor; ctx2.textBaseline = 'middle';
  ctx2.fillText(text, 30, 80);
  return trimCanvas(c);
}

function removeWhite(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
    // Fade out bright pixels; keep dark ink opaque.
    const a = lum > 235 ? 0 : lum > 150 ? Math.round(255 * (235 - lum) / 85) : 255;
    d[i + 3] = Math.min(d[i + 3], a);
  }
  ctx.putImageData(img, 0, 0);
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

let wired = false;
function wire() {
  if (wired) return; wired = true;
  setupTabs($('#sig-tabs'), $('#sig-modal'), tab => { if (tab === 'draw') ensurePad(); });
  $('#sig-colors').addEventListener('click', e => {
    const b = e.target.closest('button[data-c]'); if (!b) return;
    padColor = b.dataset.c;
    for (const x of $('#sig-colors').children) x.classList.toggle('on', x === b);
    if (pad) pad.penColor = padColor;
    renderFontList();
  });
  $('#sig-undo').addEventListener('click', () => { if (!pad) return; const d = pad.toData(); d.pop(); pad.fromData(d); });
  $('#sig-clear').addEventListener('click', () => pad && pad.clear());
  $('#sig-type-text').addEventListener('input', renderFontList);
  $('#sig-fonts').addEventListener('click', e => {
    const b = e.target.closest('button[data-f]'); if (!b) return;
    typeFont = +b.dataset.f;
    for (const x of $('#sig-fonts').children) x.classList.toggle('on', x === b);
  });
  $('#sig-upload').addEventListener('change', e => { if (e.target.files[0]) handleUpload(e.target.files[0]); });
  $('#sig-remove-bg').addEventListener('change', refreshUploadPreview);
  $('#sig-save').addEventListener('click', save);
  window.addEventListener('resize', () => { if (!$('#sig-modal').hidden) ensurePad(); });
}

function renderFontList() {
  const text = $('#sig-type-text').value || (store.profile.fullName || 'Your Name');
  const box = $('#sig-fonts'); box.innerHTML = '';
  FONTS.forEach((f, i) => {
    const b = document.createElement('button'); b.dataset.f = i; b.className = i === typeFont ? 'on' : '';
    b.style.fontFamily = f[0]; b.style.color = padColor; b.textContent = text; box.appendChild(b);
  });
}

async function save() {
  const active = $('#sig-tabs button.on').dataset.tab;
  let result = null;
  if (active === 'draw') {
    if (!pad || pad.isEmpty()) { toast('Draw your signature first'); return; }
    result = trimCanvas($('#sig-pad'));
  } else if (active === 'type') {
    const text = $('#sig-type-text').value.trim() || store.profile.fullName;
    if (!text) { toast('Type your name first'); return; }
    result = await renderTyped(text, typeFont);
  } else {
    if (!uploadCanvas) { toast('Choose an image first'); return; }
    const c = document.createElement('canvas'); c.width = uploadCanvas.width; c.height = uploadCanvas.height;
    c.getContext('2d').drawImage(uploadCanvas, 0, 0);
    if ($('#sig-remove-bg').checked) removeWhite(c);
    result = trimCanvas(c);
  }
  if (!result) { toast('Nothing to save'); return; }
  const r = resolver; resolver = null;
  hideSheet();
  const sig = await store.addSignature({ kind: currentKind, ...result });
  if (r) r(sig);
}

/** Opens the creator. Resolves with the saved signature, or null if cancelled. */
export function createSignature(kind = 'signature') {
  wire();
  if (resolver) { const r = resolver; resolver = null; r(null); }
  currentKind = kind;
  $('#sig-modal-title').textContent = kind === 'initials' ? 'New initials' : 'New signature';
  $('#sig-type-text').value = kind === 'initials' ? initialsOf(store.profile.fullName) : (store.profile.fullName || '');
  uploadCanvas = null; $('#sig-upload').value = ''; $('#sig-upload-preview').removeAttribute('src');
  renderFontList();
  return new Promise(resolve => {
    resolver = resolve;
    showSheet($('#sig-modal'), { onClose: () => { if (resolver) { const r = resolver; resolver = null; r(null); } } });
    selectTab($('#sig-tabs'), 'draw');
    requestAnimationFrame(() => { ensurePad(); pad.clear(); pad.penColor = padColor; });
  });
}

function initialsOf(name) {
  return (name || '').split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join('');
}

export function renderSigGrid(el, kind, { manage = false, onPick } = {}) {
  const sigs = store.sigsOf(kind);
  el.classList.toggle('manage', manage);
  if (!sigs.length) { el.innerHTML = `<div class="sig-empty">No ${kind === 'initials' ? 'initials' : 'signatures'} saved yet.</div>`; return; }
  el.innerHTML = sigs.map(s => `<div class="sig-item" data-id="${s.id}"><img src="${s.dataUrl}" alt=""><button class="del" data-del="${s.id}" aria-label="Delete">&times;</button></div>`).join('');
  el.onclick = e => {
    const del = e.target.closest('[data-del]');
    if (del) { store.removeSignature(del.dataset.del).then(() => renderSigGrid(el, kind, { manage, onPick })); return; }
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
    const draw = () => renderSigGrid(grid, kind, { manage, onPick: s => { if (!manage) { finish(s); hideSheet(); } } });
    draw();
    $('#sig-manage').onclick = () => { manage = !manage; $('#sig-manage').textContent = manage ? 'Done' : 'Manage'; draw(); };
    $('#sig-manage').textContent = 'Manage';
    $('#sig-new').onclick = async () => { done = true; hideSheet(); resolve(await createSignature(kind)); };
    showSheet(sheet, { onClose: () => finish(null) });
  });
}
