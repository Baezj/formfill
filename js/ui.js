// Tiny UI helpers: sheets/modals, toasts, busy overlay, confirm/prompt.
const $ = s => document.querySelector(s);
const backdrop = () => $('#sheet-backdrop');
let openEl = null;
let onBackdrop = null;

export function showSheet(el, { onClose } = {}) {
  hideSheet();
  openEl = el; onBackdrop = onClose || null;
  el.hidden = false; backdrop().hidden = false;
}
export function hideSheet() {
  if (openEl) { openEl.hidden = true; const cb = onBackdrop; openEl = null; onBackdrop = null; backdrop().hidden = true; if (cb) cb(); }
  else backdrop().hidden = true;
}
export function isSheetOpen() { return !!openEl; }

document.addEventListener('click', e => {
  if (e.target.closest('[data-close]')) { e.preventDefault(); hideSheet(); }
  else if (e.target.id === 'sheet-backdrop') hideSheet();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && openEl) hideSheet(); });

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

export function busy(text) {
  const b = $('#busy');
  if (text === false || text == null) { b.hidden = true; return; }
  $('#busy-text').textContent = text; b.hidden = false;
}

export function confirmDialog(msg) { return Promise.resolve(window.confirm(msg)); }
export function promptDialog(msg, def = '') { return Promise.resolve(window.prompt(msg, def)); }

export function setupTabs(tabsEl, paneRoot, onChange) {
  tabsEl.addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    for (const x of tabsEl.querySelectorAll('button')) x.classList.toggle('on', x === b);
    for (const p of paneRoot.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== b.dataset.tab;
    if (onChange) onChange(b.dataset.tab);
  });
}
export function selectTab(tabsEl, name) {
  const b = tabsEl.querySelector(`button[data-tab="${name}"]`);
  if (b) b.click();
}

export function timeAgo(ts) {
  const d = Date.now() - ts, m = Math.round(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24); if (days < 7) return `${days} d ago`;
  return new Date(ts).toLocaleDateString();
}
