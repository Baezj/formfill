// App shell: home list, opening files, editor session, export, settings.
import { db } from './db.js';
import { store, PROFILE_FIELDS, formatDate } from './store.js';
import { loadPdfFile, loadImageFiles, loadDocxFile, blankDoc, imageToPage, extractFields, openPdfJs, classify, LETTER } from './loaders.js';
import { Editor } from './editor.js';
import { buildPdf, lastBuild } from './export.js';
import { createSignature, editSignature, renderSigGrid } from './signature.js';
import { showSheet, hideSheet, toast, busy, confirmDialog, promptDialog, setupTabs, timeAgo } from './ui.js';

const $ = s => document.querySelector(s);
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const APP_VERSION = '1.9';
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const state = { doc: null, pdf: null, fieldDefs: [], saveTimer: null, dirty: false };
const editor = new Editor({ onChange: markDirty });
window.formfill = { editor, state }; // handy for debugging in the console

// ---------------- home ----------------
async function renderHome() {
  const list = await db.list();
  const grid = $('#recent'); grid.innerHTML = '';
  $('#recent-empty').hidden = list.length > 0;
  $('#recent-count').textContent = list.length ? `${list.length}` : '';
  for (const d of list) {
    const card = document.createElement('button');
    card.className = 'card'; card.dataset.id = d.id;
    const kind = d.kind === 'pdf' ? 'PDF' : 'Pages';
    card.innerHTML = `<div class="thumb">${d.thumb ? `<img src="${d.thumb}" alt="">` : ''}</div>
      ${d.exportedAt ? `<span class="badge">Sent ${timeAgo(d.exportedAt)}</span>` : ''}
      <div class="meta"><div class="name"></div><div class="when"><span class="kind">${kind}</span>${timeAgo(d.updatedAt)} · ${d.pageCount} page${d.pageCount === 1 ? '' : 's'}</div></div>
      <span class="card-menu" data-menu="${d.id}" role="button" aria-label="Options">⋯</span>`;
    card.querySelector('.name').textContent = d.name;
    grid.appendChild(card);
  }
}

$('#recent').addEventListener('click', async e => {
  const menu = e.target.closest('[data-menu]');
  if (menu) {
    e.stopPropagation();
    const id = menu.dataset.menu;
    $('#card-sheet-title').textContent = menu.closest('.card').querySelector('.name').textContent;
    $('#card-sheet').dataset.id = id;
    showSheet($('#card-sheet'));
    return;
  }
  const card = e.target.closest('.card');
  if (card) openSaved(card.dataset.id);
});
$('#card-sheet').addEventListener('click', async e => {
  const b = e.target.closest('button[data-card]'); if (!b) return;
  const id = $('#card-sheet').dataset.id; hideSheet();
  const d = await db.get(id); if (!d) return;
  const act = b.dataset.card;
  if (act === 'open') openSaved(id);
  else if (act === 'rename') { const n = await promptDialog('New name', d.name); if (n && n.trim()) { d.name = n.trim(); d.updatedAt = Date.now(); await db.put(d); renderHome(); } }
  else if (act === 'duplicate') { d.id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); d.name += ' (copy)'; d.createdAt = d.updatedAt = Date.now(); await db.put(d); renderHome(); }
  else if (act === 'delete') { if (await confirmDialog(`Delete "${d.name}"? This can't be undone.`)) { await db.delete(id); renderHome(); } }
});

$('#btn-open').addEventListener('click', () => $('#file-input').click());
$('#btn-camera').addEventListener('click', () => $('#camera-input').click());
$('#btn-blank').addEventListener('click', () => openDoc(blankDoc('Blank page')));
$('#file-input').addEventListener('change', e => { handleFiles([...e.target.files]); e.target.value = ''; });
$('#camera-input').addEventListener('change', async e => {
  const files = [...e.target.files]; e.target.value = ''; if (!files.length) return;
  busy('Preparing photo…');
  try { const d = await loadImageFiles(files); d.name = 'Scan ' + formatDate(); await openDoc(d); }
  catch (err) { toast('Could not read that photo'); } finally { busy(false); }
});

const dz = $('#dropzone');
for (const evn of ['dragenter', 'dragover']) document.addEventListener(evn, e => { e.preventDefault(); dz.classList.add('over'); });
for (const evn of ['dragleave', 'drop']) document.addEventListener(evn, e => { e.preventDefault(); dz.classList.remove('over'); });
document.addEventListener('drop', e => {
  const files = [...(e.dataTransfer?.files || [])]; if (!files.length) return;
  if ($('#editor').hidden) handleFiles(files);
  else if (state.doc && files.every(f => classify(f) === 'image')) addPhotoPages(files);
});
// ---------------- paste ----------------
const PASTE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
function pastedName(type) {
  const ext = type === 'application/pdf' ? 'pdf' : type.includes('wordprocessingml') ? 'docx' : (type.split('/')[1] || 'png');
  return `Pasted ${formatDate()}.${ext}`;
}
function filesFromClipboardData(cd) {
  const out = [];
  for (const f of cd?.files || []) if (classify(f) !== 'unknown') out.push(f.name ? f : new File([f], pastedName(f.type), { type: f.type }));
  if (!out.length) for (const it of cd?.items || []) {
    if (it.kind !== 'file') continue;
    const f = it.getAsFile(); if (f && classify(f) !== 'unknown') out.push(f.name ? f : new File([f], pastedName(f.type), { type: f.type }));
  }
  return out;
}
async function pasteFromClipboard() {
  // 1) Async clipboard API (Chrome/Edge/Android: files copied from Finder/Explorer/Files show up here).
  if (navigator.clipboard && navigator.clipboard.read) {
    try {
      const items = await navigator.clipboard.read();
      const files = [];
      for (const it of items) {
        const type = it.types.find(t => PASTE_TYPES.includes(t) || t.startsWith('image/'));
        if (!type) continue;
        const blob = await it.getType(type);
        files.push(new File([blob], pastedName(type), { type }));
      }
      if (files.length) { handleFiles(files); return; }
    } catch (e) { console.info('clipboard.read unavailable:', e && e.message); }
  }
  // 2) Paste gesture into a box (Safari/iOS only hand files over this way, if at all).
  $('#paste-zone').textContent = '';
  showSheet($('#paste-sheet'));
  setTimeout(() => $('#paste-zone').focus(), 50);
}
$('#btn-paste').addEventListener('click', pasteFromClipboard);
$('#paste-zone').addEventListener('paste', e => {
  e.preventDefault();
  const files = filesFromClipboardData(e.clipboardData);
  if (files.length) { hideSheet(); handleFiles(files); return; }
  const text = (e.clipboardData?.getData('text/plain') || '').trim();
  $('#paste-zone').textContent = '';
  toast(text ? 'That pasted as text, not a file. Use "Open a file" and pick it from Files.' : 'Nothing to paste. Copy a PDF or photo first, then try again.', 4500);
});
$('#paste-zone').addEventListener('input', () => { $('#paste-zone').textContent = ''; });
document.addEventListener('paste', e => {
  if (!$('#paste-sheet').hidden || !$('#editor').hidden || (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]'))) return;
  const files = filesFromClipboardData(e.clipboardData);
  if (files.length) { e.preventDefault(); handleFiles(files); }
});

async function handleFiles(files) {
  if (!files.length) return;
  const kinds = files.map(classify);
  try {
    if (kinds.every(k => k === 'image')) { busy('Preparing photo…'); await openDoc(await loadImageFiles(files)); return; }
    const f = files[0], k = kinds[0];
    if (files.length > 1) toast(`Opening ${f.name} — one document at a time.`, 3000);
    if (k === 'pdf') { busy('Opening PDF…'); const { doc, pdf } = await loadPdfFile(f, again => Promise.resolve(window.prompt(again ? 'Wrong password. Try again:' : 'This PDF is password protected. Enter the password:'))); await openDoc(doc, pdf); }
    else if (k === 'docx') { busy('Converting Word document…'); await openDoc(await loadDocxFile(f)); }
    else if (k === 'doc') toast('Old .doc files aren\'t supported — save it as .docx or PDF first.');
    else toast(`Can't open ${f.name}. Try a PDF, photo or .docx.`);
  } catch (e) {
    console.error(e); toast(e.message || 'Could not open that file.', 4000);
  } finally { busy(false); }
}

// ---------------- editor session ----------------
async function openSaved(id) {
  busy('Opening…');
  try {
    const doc = await db.get(id); if (!doc) { toast('Document not found'); return; }
    let pdf = null;
    if (doc.kind === 'pdf') pdf = await openPdfJs(new Uint8Array(doc.source), doc.password || undefined);
    await openDoc(doc, pdf);
  } catch (e) { console.error(e); toast('Could not open: ' + (e.message || e)); }
  finally { busy(false); }
}

async function openDoc(doc, pdf = null) {
  if (state.doc) await closeDoc();
  state.doc = doc; state.pdf = pdf; state.fieldDefs = pdf ? await extractFields(pdf) : (doc.fieldDefs || []);
  $('#ed-title').textContent = doc.name;
  refreshInkSwatch(); $('#ink-pop').hidden = true;
  const st = $('#ed-status');
  if (doc.note) { st.textContent = doc.note; st.hidden = false; } else st.hidden = true;
  $('#home').hidden = true; $('#editor').hidden = false;
  await editor.load(doc, pdf, state.fieldDefs);
  updateNextField();
  if (!doc.thumb) { doc.thumb = await editor.thumbnail(); }
  await save(true);
  if (pdf && pdf.isPureXfa) toast('This is an XFA form; it may show a placeholder page. Try "Print to PDF" from another app first.', 6000);
  else if (state.fieldDefs.length) toast(`${state.fieldDefs.length} fillable field${state.fieldDefs.length === 1 ? '' : 's'} found — tap them, or use Smart fill (More).`, 3600);
  else if (pdf && store.profile.fullName) toast('No form fields in this PDF — try Smart fill (More) to place your details.', 3600);
  history.pushState({ doc: doc.id }, '');
}

async function closeDoc() {
  if (!state.doc) return;
  editor.deselect();
  try { state.doc.thumb = await editor.thumbnail(); } catch { /* keep old */ }
  await save(true);
  editor.destroy();
  state.doc = null; state.pdf = null; state.fieldDefs = [];
}

function markDirty() {
  state.dirty = true;
  clearTimeout(state.nfTimer); state.nfTimer = setTimeout(updateNextField, 400);
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => save(), 300);
}
// Flush pending changes when the tab is backgrounded or closed.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
window.addEventListener('pagehide', () => save());
async function save(force = false) {
  if (!state.doc || (!state.dirty && !force)) return;
  state.dirty = false; clearTimeout(state.saveTimer);
  const d = state.doc; d.updatedAt = Date.now();
  try { await db.put(d); } catch (e) { console.warn('save failed', e); toast('Could not save (storage full?)'); }
}

$('#btn-home').addEventListener('click', goHome);
window.addEventListener('popstate', () => { if (state.doc) goHome(); });
async function goHome() {
  hideSheet();
  await closeDoc();
  $('#editor').hidden = true; $('#home').hidden = false;
  store.onSaveError = () => toast('Could not save settings — this browser\'s storage is full or blocked.', 5000);
store.init().then(() => { renderHome(); updateSetupHint(); });
}

$('#btn-undo').addEventListener('click', () => editor.undo());
// Ink color: header button → popover; applies to new marks and to what is already on the form.
const INK_NAMES = { '#111111': 'Black', '#1d3fbf': 'Blue', '#c0392b': 'Red' };
function refreshInkSwatch() {
  $('#ink-swatch').style.background = store.prefs.color;
  for (const b of $('#ink-pop').querySelectorAll('button[data-ink]')) b.classList.toggle('on', b.dataset.ink === store.prefs.color);
}
$('#btn-ink').addEventListener('click', e => { e.stopPropagation(); refreshInkSwatch(); $('#toast').hidden = true; $('#ink-pop').hidden = !$('#ink-pop').hidden; });
$('#ink-pop').addEventListener('click', async e => {
  const b = e.target.closest('button[data-ink]'); if (!b) return;
  $('#ink-pop').hidden = true;
  const color = b.dataset.ink;
  store.prefs.color = color; store.save(); refreshInkSwatch();
  const n = await editor.applyInkColor(color);
  toast(`Ink: ${INK_NAMES[color] || color}` + (n ? ` · ${n} item${n === 1 ? '' : 's'} on this form recolored` : ''), 2600);
});
document.addEventListener('pointerdown', e => { if (!$('#ink-pop').hidden && !e.target.closest('#ink-pop, #btn-ink')) $('#ink-pop').hidden = true; });
$('#btn-redo').addEventListener('click', () => editor.redo());
$('#ed-title').addEventListener('click', renameDoc);
async function renameDoc() {
  const n = await promptDialog('Document name', state.doc.name);
  if (n && n.trim()) { state.doc.name = n.trim(); $('#ed-title').textContent = state.doc.name; markDirty(); }
}

// toolbar
$('#toolbar').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tool) { const t = editor.setTool(b.dataset.tool); if (t) hintFor(t); }
  else if (b.id === 'tool-more') showSheet($('#tools-sheet'));
  else if (b.id === 'zoom-in') editor.zoomBy(1.25);
  else if (b.id === 'zoom-out') editor.zoomBy(0.8);
  else if (b.id === 'zoom-fit') editor.fitWidth();
});
$('#tools-sheet').addEventListener('click', e => {
  const b = e.target.closest('button[data-tool]'); if (!b) return;
  hideSheet();
  const t = editor.setTool(b.dataset.tool); if (t) hintFor(t);
  $('#tool-more').classList.toggle('on', !!t);
});
async function smartFill() {
  if (!state.doc) return;
  busy('Reading the form…');
  let msg;
  try {
    const n = editor.autofill();
    const r = await editor.smartFill();
    const parts = [];
    if (n) parts.push(`${n} field${n === 1 ? '' : 's'}`);
    if (r.placed) parts.push(`${r.placed} detail${r.placed === 1 ? '' : 's'}`);
    if (r.signs) parts.push(`${r.signs} signature${r.signs === 1 ? '' : 's'}`);
    msg = parts.length ? `Filled ${parts.join(', ')} — check them and adjust anything that landed off.`
      : r.already ? 'Everything that can be auto-filled is already in place.'
      : 'Nothing to fill automatically here. Tap Text / Sign to place things by hand.';
    if (r.needSig) msg += ' Add a signature (Settings) to place it automatically.';
    if (!store.profile.fullName && !n && !r.placed) msg = 'Add your details in Settings → My details, then Smart fill can place them for you.';
  } catch (e) { console.error(e); msg = 'Smart fill failed: ' + (e.message || e); }
  finally { busy(false); }
  toast(msg, 4500);
}
$('#tools-sheet').addEventListener('click', e => { const b = e.target.closest('button[data-action="smartfill"]'); if (b) { hideSheet(); smartFill(); } });
$('#next-field').addEventListener('click', () => { if (!editor.nextField()) toast('No text fields on this form'); updateNextField(); });
function updateNextField() {
  const pill = $('#next-field');
  const has = state.fieldDefs.some(f => f.type === 'text' || f.type === 'combo' || f.type === 'list');
  pill.hidden = !has;
  if (has) { const n = editor.emptyFieldCount(); $('#next-field-label').textContent = n ? `Next field · ${n} left` : 'Next field'; }
}
function hintFor(t) {
  const m = { text: 'Tap where the text should go', check: 'Tap to place check marks · tap Check again to stop', cross: 'Tap to place X marks · tap X again to stop', date: 'Tap where today\'s date goes', sign: 'Tap where to sign', initials: 'Tap where to initial', fill: 'Tap where to drop a detail', image: 'Tap where the image goes', draw: 'Draw with your finger or pen. Tap Draw again to stop.' };
  toast(m[t] || '', 1600);
}

editor.onFirstImageSelect = () => toast('Tip: the color dot changes this signature\'s ink.', 2600);
editor.onHotspots = n => {
  if (!n || !state.doc) return;
  const hasFields = state.fieldDefs.length > 0;
  toast(hasFields ? `${state.fieldDefs.length} fields found, plus a signature line — tap "Tap to sign" when you're ready.` : 'Found a signature line — tap "Tap to sign" to place your signature.', 4000);
};

// quick fill
editor.onQuickFill = (page, x, y) => {
  const chips = $('#quick-chips'); const p = store.profile;
  const items = [];
  for (const [k, label] of PROFILE_FIELDS) if (p[k]) items.push([label, p[k]]);
  items.push(['Today', formatDate()]);
  if (p.address && p.city) items.push(['Full address', `${p.address}, ${p.city}${p.state ? ', ' + p.state : ''} ${p.zip || ''}`.trim()]);
  for (const s of store.snippets) if (s.value) items.push([s.label || 'Snippet', s.value]);
  chips.innerHTML = '';
  items.forEach(([l, v], i) => {
    const b = document.createElement('button'); b.dataset.i = i;
    const lab = document.createElement('b'); lab.textContent = l; const val = document.createElement('span'); val.textContent = v;
    b.append(lab, val); chips.appendChild(b);
  });
  if (items.length <= 1) chips.insertAdjacentHTML('beforeend', `<p class="muted small">Add your details in Settings → My details to see them here.</p>`);
  chips.onclick = e => { const b = e.target.closest('button[data-i]'); if (!b) return; hideSheet(); editor.placeText(page, x, y, items[+b.dataset.i][1]); };
  showSheet($('#quick-sheet'));
};

// image annotation
let imgTarget = null;
editor.onImagePick = (page, x, y) => { imgTarget = { page, x, y }; $('#image-annot-input').click(); };
$('#image-annot-input').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (f && imgTarget) await editor.placeImageFile(imgTarget.page, imgTarget.x, imgTarget.y, f);
});

// more menu
$('#btn-more').addEventListener('click', () => {
  $('#more-sheet [data-more="autofill"]').hidden = state.doc.kind !== 'pdf' && !state.fieldDefs.length;
  showSheet($('#more-sheet'));
});
$('#more-sheet').addEventListener('click', async e => {
  const b = e.target.closest('button[data-more]'); if (!b) return;
  hideSheet();
  const act = b.dataset.more;
  if (act === 'rename') renameDoc();
  else if (act === 'autofill') smartFill();
  else if (act === 'addpage') $('#add-page-input').click();
  else if (act === 'addblank') editor.addPages([{ w: LETTER.w, h: LETTER.h, rotation: 0, image: null }]);
  else if (act === 'clear') { if (await confirmDialog('Remove all text, marks and signatures you added?')) editor.clearAnnots(); }
  else if (act === 'delete') {
    if (await confirmDialog(`Delete "${state.doc.name}"?`)) { const id = state.doc.id; editor.destroy(); state.doc = null; await db.delete(id); $('#editor').hidden = true; $('#home').hidden = false; renderHome(); }
  }
});
$('#add-page-input').addEventListener('change', async e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) addPhotoPages(files); });
async function addPhotoPages(files) {
  busy('Adding page…');
  try { const pages = []; for (const f of files) pages.push(await imageToPage(f)); editor.addPages(pages); }
  catch (err) { toast('Could not add that image'); }
  finally { busy(false); }
}

// ---------------- export ----------------
// The PDF is built as soon as the sheet opens, so the Share / Print / Open buttons can act
// synchronously inside the tap (Safari drops the user gesture after an async wait).
const exp = { token: 0, result: null };
function exportName() { return (state.doc.name.replace(/[\\/:*?"<>|]+/g, '-') || 'document') + '.pdf'; }
async function prepareExport() {
  const token = ++exp.token; exp.result = null;
  const btns = $('#export-sheet').querySelectorAll('button[data-export]');
  btns.forEach(b => { b.disabled = true; });
  $('#export-note').textContent = 'Preparing your PDF…';
  try {
    await save(true);
    const bytes = await buildPdf(state.doc, { flatten: $('#opt-flatten').checked, fieldDefs: state.fieldDefs, inkColor: store.prefs.color });
    if (token !== exp.token) return;
    const name = exportName();
    const blob = new Blob([bytes], { type: 'application/pdf' });
    exp.result = { blob, file: new File([blob], name, { type: 'application/pdf' }), name, url: URL.createObjectURL(blob) };
    btns.forEach(b => { b.disabled = false; });
    const kb = Math.round(blob.size / 1024);
    const warn = lastBuild.warnings.length ? ' · ' + lastBuild.warnings.join(' ') : '';
    $('#export-note').textContent = `Ready · ${kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB'}` + (isIOS ? ' · Share can save to Files, AirDrop, email or print.' : '') + warn;
  } catch (err) {
    console.error(err);
    if (token === exp.token) $('#export-note').textContent = 'Could not build the PDF: ' + (err.message || err);
  }
}
$('#btn-export').addEventListener('click', () => {
  editor.deselect();
  $('#opt-flatten').checked = store.prefs.flatten;
  $('#opt-flatten').closest('label').hidden = state.doc.kind !== 'pdf' || !state.fieldDefs.length;
  const canShare = !!(navigator.share && navigator.canShare);
  $('#export-sheet [data-export="share"]').hidden = !canShare;
  // In an iOS home-screen app, blob downloads / new tabs are unreliable: Share is the one that works.
  const iosApp = isIOS && standalone;
  for (const k of ['download', 'open', 'print']) $(`#export-sheet [data-export="${k}"]`).hidden = iosApp && canShare;
  $('#export-sheet').classList.toggle('share-only', iosApp && canShare);
  showSheet($('#export-sheet'), { onClose: () => { exp.token++; if (exp.result) { const u = exp.result.url; setTimeout(() => URL.revokeObjectURL(u), 120000); } } });
  prepareExport();
});
$('#opt-flatten').addEventListener('change', () => { if (!$('#export-sheet').hidden) prepareExport(); });
$('#export-sheet').addEventListener('click', e => {
  const b = e.target.closest('button[data-export]'); if (!b || !exp.result) return;
  const how = b.dataset.export; const { blob, file, name, url } = exp.result;
  try {
    if (how === 'share' && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file] }).catch(err => { if (err.name !== 'AbortError') { console.warn(err); downloadBlob(url, name); } });
    } else if (how === 'download' || how === 'share') {
      downloadBlob(url, name); toast('PDF downloaded');
    } else if (how === 'open') {
      const w = window.open(url, '_blank'); if (!w) toast('Pop-up blocked — allow pop-ups for this site.');
    } else if (how === 'print') {
      printBlob(blob, url);
    }
  } catch (err) { console.error(err); toast('Export failed: ' + (err.message || err), 5000); }
  state.doc.exportedAt = Date.now(); markDirty();
  hideSheet();
});
function downloadBlob(url, name) {
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
}
function printBlob(blob, url) {
  if (isIOS) {
    const w = window.open(url, '_blank');
    if (w) toast('Tap the Share button, then Print.', 4000); else toast('Allow pop-ups to print.');
    return;
  }
  const fr = document.createElement('iframe');
  fr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  fr.src = url; document.body.appendChild(fr);
  fr.onload = () => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch { window.open(url, '_blank'); } setTimeout(() => fr.remove(), 120000); };
}

// ---------------- settings ----------------
setupTabs($('#settings-tabs'), $('#settings-modal'), tab => { if (tab === 'sigs') renderSettingsSigs(); if (tab === 'prefs') renderStorage(); });
$('#btn-settings').addEventListener('click', () => { renderProfileForm(); renderSettingsSigs(); renderPrefs(); showSheet($('#settings-modal')); });

function renderProfileForm() {
  const form = $('#profile-form'); const p = store.profile;
  form.innerHTML = PROFILE_FIELDS.map(([k, label, cls, ac]) => `<label class="${cls || ''}">${label}<input data-k="${k}" autocomplete="${ac || 'off'}" name="${ac || k}"></label>`).join('');
  for (const inp of form.querySelectorAll('input')) {
    inp.value = p[inp.dataset.k] || '';
    inp.addEventListener('input', () => { p[inp.dataset.k] = inp.value; store.save(); });
  }
  renderSnippets();
}
function renderSnippets() {
  const box = $('#snippets');
  box.innerHTML = store.snippets.map((s, i) => `<div class="snip"><input placeholder="Label" data-i="${i}" data-f="label"><input placeholder="Value" data-i="${i}" data-f="value"><button data-del="${i}">&times;</button></div>`).join('');
  box.querySelectorAll('input').forEach(inp => { inp.value = store.snippets[+inp.dataset.i][inp.dataset.f] || ''; inp.addEventListener('input', () => { store.snippets[+inp.dataset.i][inp.dataset.f] = inp.value; store.save(); }); });
  box.onclick = e => { const b = e.target.closest('[data-del]'); if (!b) return; store.snippets.splice(+b.dataset.del, 1); store.save(); renderSnippets(); };
}
$('#snippet-add').addEventListener('click', () => { store.snippets.push({ label: '', value: '' }); store.save(); renderSnippets(); $('#snippets input:last-of-type')?.focus(); });

function renderSettingsSigs() {
  const edit = async s => { await editSignature(s); showSheet($('#settings-modal')); renderSettingsSigs(); };
  renderSigGrid($('#settings-sigs'), 'signature', { manage: true, onPick: edit });
  renderSigGrid($('#settings-initials'), 'initials', { manage: true, onPick: edit });
}
document.addEventListener('signatures-changed', () => { if (!$('#settings-modal').hidden) renderSettingsSigs(); updateSetupHint(); });
$('#settings-new-sig').addEventListener('click', async () => { await createSignature('signature'); showSheet($('#settings-modal')); renderSettingsSigs(); });
$('#settings-new-init').addEventListener('click', async () => { await createSignature('initials'); showSheet($('#settings-modal')); renderSettingsSigs(); });

function renderPrefs() {
  const p = store.prefs;
  $('#pref-date').value = p.dateFormat; $('#pref-size').value = p.fontSize; $('#pref-color').value = p.color; $('#pref-flatten').checked = p.flatten;
}
$('#pref-date').addEventListener('change', e => { store.prefs.dateFormat = e.target.value; store.save(); });
$('#pref-size').addEventListener('change', e => { store.prefs.fontSize = Math.max(6, Math.min(48, +e.target.value || 12)); store.save(); });
$('#pref-color').addEventListener('change', e => { store.prefs.color = e.target.value; store.save(); refreshInkSwatch(); });
$('#pref-flatten').addEventListener('change', e => { store.prefs.flatten = e.target.checked; store.save(); });
$('#pref-wipe').addEventListener('click', async () => { if (await confirmDialog('Delete every saved document? Your details and signatures are kept.')) { await db.clear(); renderHome(); renderStorage(); toast('All documents deleted'); } });
async function renderStorage() {
  const u = await db.usage(); const list = await db.list();
  const mb = u ? (u.usage / 1048576).toFixed(1) + ' MB used' : '';
  $('#storage-info').textContent = `${list.length} document${list.length === 1 ? '' : 's'} saved on this device. ${mb}`;
  $('#about-version').textContent = `Version ${APP_VERSION}` + (standalone ? ' · installed app' : '');
}

// ---------------- keyboard ----------------
// iOS doesn't shrink the layout viewport for the keyboard; track the visual viewport instead so the
// toolbar and the selection bar stay above it, and keep the window from being scrolled by Safari.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const onVV = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', kb + 'px');
    if (kb > 0 && window.scrollY) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', onVV); vv.addEventListener('scroll', onVV);
}

// ---------------- PWA ----------------
// On iOS Safari (not yet on the home screen) nudge once toward Add to Home Screen: that is what keeps
// IndexedDB from being evicted after a week of non-use, and what makes the app full-screen/offline.
if (isIOS && !standalone && !localStorage.getItem('formfill.installHintDismissed')) $('#install-hint').hidden = false;
function updateSetupHint() {
  const needs = !store.profile.fullName && !store.signatures.length && !localStorage.getItem('formfill.setupHintDismissed');
  $('#setup-hint').hidden = !needs;
}
$('#setup-hint-go').addEventListener('click', () => $('#btn-settings').click());
$('#setup-hint-close').addEventListener('click', () => { localStorage.setItem('formfill.setupHintDismissed', '1'); updateSetupHint(); });
$('#install-hint-close').addEventListener('click', () => { $('#install-hint').hidden = true; localStorage.setItem('formfill.installHintDismissed', '1'); });

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then(reg => { try { reg.update(); } catch { /* ignore */ } }).catch(() => {});
    // A new version took over: offer a reload so the page runs matching code everywhere.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      const bar = $('#update-bar'); bar.hidden = false;
    });
  });
  $('#update-bar').addEventListener('click', async () => { await save(true); location.reload(); });
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// Open a file shared/launched into the PWA (Chrome's file handling), if any.
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async params => {
    const files = []; for (const h of params.files || []) files.push(await h.getFile());
    if (files.length) handleFiles(files);
  });
}

store.onSaveError = () => toast('Could not save settings — this browser\'s storage is full or blocked.', 5000);
store.init().then(() => { renderHome(); updateSetupHint(); });
