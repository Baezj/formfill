// Smart fill for flat PDFs: read the page text, find "Name: ______"-style labels and blanks, and
// propose where your details, today's date and your signature go.
import { store, formatDate } from './store.js';

const RULES = [
  // [regex on the label text, profile key or special, kind]
  [/\b(e-?mail)\b/i, 'email', 'text'],
  [/\b(phone|telephone|tel|mobile|cell)\b/i, 'phone', 'text'],
  [/\b(date of birth|birth ?date|dob)\b/i, 'dob', 'text'],
  [/\b(zip|postal)\b/i, 'zip', 'text'],
  [/\bcity\b/i, 'city', 'text'],
  [/\bstate\b/i, 'state', 'text'],
  [/\b(street|address)\b/i, 'address', 'text'],
  [/\b(company|employer|organization)\b/i, 'company', 'text'],
  [/\b(job title|position|occupation)\b/i, 'title', 'text'],
  [/\bfirst name\b/i, 'firstName', 'text'],
  [/\b(last|family) name\b/i, 'lastName', 'text'],
  [/\b(signature|signed|sign here)\b/i, 'signature', 'sign'],
  [/\b(initials?)\b/i, 'initials', 'initials'],
  [/\bdate\b/i, 'today', 'text'],
  [/\b(full name|print(ed)? name|your name|name of applicant|applicant|name)\b/i, 'fullName', 'text']
];
const BLANK = /^[\s_.—–-]{3,}$/;      // underscores / dots / dashes used as a blank
const LABEL = /[:：]\s*$|^[A-Za-z][A-Za-z0-9 /()'’.,&-]{1,60}$/;

function lineGroups(items) {
  // Group text items into lines by their vertical position.
  const lines = [];
  for (const it of items) {
    let line = lines.find(l => Math.abs(l.y - it.y) < Math.max(3, it.h * 0.5));
    if (!line) { line = { y: it.y, items: [] }; lines.push(line); }
    line.items.push(it);
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => a.y - b.y);
}

/**
 * @param pdfjsPage pdf.js page
 * @param pageIdx   index in doc.pages
 * @param pg        {w,h} display size
 * @returns [{kind:'text'|'sign'|'initials', text?, x, y, w, h, label}]
 */
export async function suggestForPage(pdfjsPage, pageIdx, pg) {
  if ((pdfjsPage.rotate % 360) !== 0) return [];
  const vp = pdfjsPage.getViewport({ scale: 1 });
  const tc = await pdfjsPage.getTextContent();
  const items = [];
  for (const t of tc.items) {
    if (!t.str || !t.str.trim() || !t.transform) continue;
    const [a, b, c, d, e, f] = t.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue; // rotated text
    const h = Math.abs(d) || Math.abs(a) || 10;
    const [x, yBase] = vp.convertToViewportPoint(e, f);
    items.push({ str: t.str, x, y: yBase - h, h, w: t.width || 0, right: x + (t.width || 0) });
  }
  const lines = lineGroups(items);
  const out = [];
  const used = new Set();
  const p = store.profile;
  const valueFor = key => key === 'today' ? formatDate() : (p[key] || '');

  lines.forEach((line, li) => {
    line.items.forEach((it0, idx) => {
      let it = it0; const text = it.str.trim();
      if (BLANK.test(text) || !LABEL.test(text) || text.length > 64) return;
      const rule = RULES.find(([re]) => re.test(text)); if (!rule) return;
      const [, key, kind] = rule;
      // "Employee's signature (This form is not valid unless you sign it.)": fold a parenthetical
      // continuation into the label so it isn't mistaken for a sentence.
      while (line.items[idx + 1] && /^\(/.test(line.items[idx + 1].str.trim()) && line.items[idx + 1].x - it.right < 30) {
        const n = line.items[idx + 1]; it = { ...it, right: n.right, w: n.right - it.x }; idx++;
      }
      // Where does the blank go? A run of underscores on the same line, the gap to the next item,
      // or — for caption-style labels ("Signature" under a rule, no colon) — the space above the caption.
      const next = line.items[idx + 1];
      const caption = !/[:：]\s*$/.test(text) && !(next && BLANK.test(next.str.trim()));
      const label = { x: it.x, right: it.right, y: it.y, h: it.h };
      let bx, bw, above = false;
      if (next && BLANK.test(next.str.trim())) { bx = next.x; bw = Math.max(40, next.w); used.add(next); }
      else if (caption) {
        if (next && next.x - it.right < 30) return;        // part of a sentence
        if (text.split(/\s+/).length > 3 || /[,;]/.test(text)) return; // captions are short ("Employee's signature", "Date")
        const prevLine = lines[li - 1];
        if (prevLine && prevLine.items.some(o => o.right > it.x - 4 && o.x < it.x + 200 && label.y - (o.y + o.h) < 10)) return; // text directly above: not a blank
        above = true; bx = label.x; bw = Math.min(240, (next ? next.x - 12 : pg.w - 36) - bx);
      }
      else if (!next) { bx = it.right + 4; bw = Math.min(260, pg.w - 36 - bx); }
      else if (next.x - it.right > 40) { bx = it.right + 4; bw = next.x - 6 - bx; }
      else return; // label followed closely by other text: already has a value or not a blank
      if (bw < 30) return;
      let by = label.y, bh = Math.max(12, label.h * 1.25);
      if (kind === 'sign' || kind === 'initials') {
        bh = Math.min(42, Math.max(26, label.h * 3));
        by = above ? label.y - bh - 2 : label.y + label.h - bh + 2;
        out.push({ kind, x: bx, y: Math.max(0, by), w: bw, h: bh, label: text });
        return;
      }
      const value = valueFor(key);
      if (!value) return;
      const size = Math.min(12, Math.max(10, Math.round(label.h)));
      const ty = above ? label.y - size * 1.2 - 6 : label.y + label.h - size * 0.92 - 2;
      out.push({ kind: 'text', text: value, x: bx, y: Math.max(0, ty), w: bw, h: size * 1.2 + 4, size, label: text });
    });
  });
  return out;
}
