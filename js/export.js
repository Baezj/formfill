// Builds the final PDF with pdf-lib: fills AcroForm fields, draws marks/text/signatures.
import { openPdfJs } from './loaders.js';

const { PDFDocument, StandardFonts, rgb, degrees, PDFName, LineCapStyle,
        PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = window.PDFLib;

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '#111111');
  if (!m) return rgb(0, 0, 0);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

// Characters Helvetica (WinAnsi) can't encode become '?'.
function winAnsiSafe(s) {
  return (s || '').replace(/[^\u0000-ÿ‘’“”–—…€•™]/g, '?').replace(/\t/g, '    ');
}

function wrapLines(text, font, size, maxW) {
  const out = [];
  for (const para of winAnsiSafe(text).split(/\r?\n/)) {
    const words = para.split(' ');
    let line = '';
    for (const w of words) {
      const probe = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(probe, size) <= maxW || !line) {
        // A single word wider than the box: hard-break it.
        if (!line && font.widthOfTextAtSize(probe, size) > maxW) {
          let chunk = '';
          for (const ch of probe) {
            if (font.widthOfTextAtSize(chunk + ch, size) > maxW && chunk) { out.push(chunk); chunk = ''; }
            chunk += ch;
          }
          line = chunk;
        } else line = probe;
      } else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

async function dataUrlToBytes(dataUrl) {
  const res = await fetch(dataUrl);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * @param doc  the document object (pages, annots, fields, source)
 * @param opts { flatten: boolean, fieldDefs: [...] }
 * @returns Uint8Array of the finished PDF
 */
export async function buildPdf(doc, opts = {}) {
  const flatten = opts.flatten !== false;
  let pdfDoc, mappers;

  if (doc.kind === 'pdf') {
    pdfDoc = await PDFDocument.load(doc.source, { ignoreEncryption: true, updateMetadata: false });
    const pdfjs = await openPdfJs(new Uint8Array(doc.source), doc.password || undefined);
    mappers = [];
    const orig = pdfDoc.getPageCount();
    for (let i = 0; i < orig; i++) {
      const p = await pdfjs.getPage(i + 1);
      const vp = p.getViewport({ scale: 1 });
      const rot = ((p.rotate % 360) + 360) % 360;
      mappers.push({
        toPdf: (x, y) => { const [px, py] = vp.convertToPdfPoint(x, y); return { x: px, y: py }; },
        rot
      });
    }
    try { pdfjs.destroy(); } catch { /* ignore */ }
    await fillFields(pdfDoc, doc, opts.fieldDefs || [], flatten);
    // Pages the user appended (photos / blank pages) after the original ones.
    for (let i = orig; i < doc.pages.length; i++) {
      const pg = doc.pages[i];
      const page = pdfDoc.addPage([pg.w, pg.h]);
      if (pg.image) await drawPageImage(pdfDoc, page, pg);
      mappers.push({ toPdf: (x, y) => ({ x, y: pg.h - y }), rot: 0 });
    }
  } else {
    pdfDoc = await PDFDocument.create();
    mappers = [];
    for (const pg of doc.pages) {
      const page = pdfDoc.addPage([pg.w, pg.h]);
      if (pg.image) await drawPageImage(pdfDoc, page, pg);
      mappers.push({ toPdf: (x, y) => ({ x, y: pg.h - y }), rot: 0 });
    }
  }

  if (doc.kind !== 'pdf' && doc.fieldDefs && doc.fieldDefs.length) await drawRasterFields(pdfDoc, doc, mappers);
  await drawAnnots(pdfDoc, doc, mappers);
  pdfDoc.setModificationDate(new Date());
  return pdfDoc.save({ useObjectStreams: false });
}

async function drawPageImage(pdfDoc, page, pg) {
  const bytes = new Uint8Array(await pg.image.arrayBuffer());
  const img = pg.image.type === 'image/png' ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
  page.drawImage(img, { x: 0, y: 0, width: pg.w, height: pg.h });
}

async function fillFields(pdfDoc, doc, fieldDefs, flatten) {
  let form;
  try { form = pdfDoc.getForm(); } catch (e) { console.warn('no form', e); return; }
  const values = doc.fields || {};
  const byName = new Map();
  for (const f of fieldDefs) { if (!byName.has(f.name)) byName.set(f.name, []); byName.get(f.name).push(f); }

  for (const [name, defs] of byName) {
    if (!(name in values)) continue;
    const v = values[name];
    let field;
    try { field = form.getFieldMaybe(name); } catch { field = null; }
    if (!field) continue;
    try {
      if (field instanceof PDFTextField) {
        let text = winAnsiSafe(String(v ?? ''));
        const max = field.getMaxLength();
        if (max && text.length > max) text = text.slice(0, max);
        field.setText(text);
      } else if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
        // v is false/"Off" (nothing on), true (checkbox on), or the on-state name of the widget that should be on.
        // Always go through the widgets' on-state names: option labels in /Opt can collide with them.
        const onVals = field.acroField.getWidgets().map(w => { const n = w.getOnValue(); return n ? n.decodeText() : null; });
        if (v === false || v === '' || v == null || v === 'Off') {
          if (field instanceof PDFCheckBox) field.uncheck(); else { try { field.clear(); } catch { /* ignore */ } }
        } else if (v === true) {
          if (field instanceof PDFCheckBox) field.check(); else if (onVals[0]) field.acroField.setValue(PDFName.of(onVals[0]));
        } else if (onVals.includes(String(v))) {
          field.acroField.setValue(PDFName.of(String(v)));
        } else if (field instanceof PDFRadioGroup) {
          try { field.select(String(v)); } catch { /* unknown value */ }
        } else field.check();
      } else if (field instanceof PDFDropdown) {
        if (v != null && v !== '') {
          try { field.select(String(v)); }
          catch { field.setOptions([...new Set([...field.getOptions(), String(v)])]); field.select(String(v)); }
        } else field.clear();
      } else if (field instanceof PDFOptionList) {
        const arr = (Array.isArray(v) ? v : (v ? [v] : [])).map(String);
        try {
          if (flatten && arr.length) {
            // pdf-lib draws the list from the top, so a one-line list box would show the first option
            // instead of the chosen one; once flattened the order no longer matters.
            const rest = field.getOptions().filter(o => !arr.includes(o));
            field.setOptions([...arr, ...rest]);
          }
          field.select(arr);
        } catch { /* ignore */ }
      }
    } catch (e) { console.warn('field', name, e); }
  }

  if (flatten) {
    try {
      const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
      try { form.updateFieldAppearances(helv); } catch (e) { console.warn('appearances', e); }
      form.flatten();
    } catch (e) {
      console.warn('flatten failed, leaving fields live', e);
    }
  } else {
    try {
      const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
      form.updateFieldAppearances(helv);
    } catch (e) { console.warn('appearances', e); }
  }
}

// For PDFs opened as images (encrypted/unwritable): paint the field values onto the page images.
async function drawRasterFields(pdfDoc, doc, mappers) {
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const black = rgb(0, 0, 0);
  const vals = doc.fields || {};
  for (const f of doc.fieldDefs) {
    const page = pages[f.page]; const m = mappers[f.page]; if (!page || !m) continue;
    const v = f.name in vals ? vals[f.name] : f.value;
    if (v == null || v === '' || v === false || v === 'Off') continue;
    if (f.type === 'checkbox' || f.type === 'radio') {
      if (v !== true && String(v) !== String(f.exportValue)) continue;
      const s = Math.min(f.w, f.h);
      if (f.type === 'radio') {
        const c = m.toPdf(f.x + f.w / 2, f.y + f.h / 2);
        page.drawCircle({ x: c.x, y: c.y, size: s * 0.22, color: black });
      } else {
        const t = Math.max(1, s * 0.12); let prev = null;
        for (const p of [[0.2, 0.55], [0.42, 0.78], [0.82, 0.22]]) {
          const cur = m.toPdf(f.x + (f.w - s) / 2 + p[0] * s, f.y + (f.h - s) / 2 + p[1] * s);
          if (prev) page.drawLine({ start: prev, end: cur, thickness: t, color: black, lineCap: LineCapStyle.Round });
          prev = cur;
        }
      }
      continue;
    }
    let text = Array.isArray(v) ? v.join(', ') : String(v);
    if (f.type === 'combo' || f.type === 'list') { const o = (f.options || []).find(o => o.v === text); if (o && o.label) text = o.label; }
    const size = f.multiLine ? 9 : Math.max(5, Math.min(12, f.h * 0.62));
    const lines = wrapLines(text, font, size, Math.max(4, f.w - 4));
    const lineH = size * 1.2;
    const maxLines = Math.max(1, Math.floor((f.h - 2) / lineH));
    lines.slice(0, f.multiLine ? maxLines : 1).forEach((line, i) => {
      if (!line) return;
      const by = f.multiLine ? f.y + 2 + size * 0.92 + i * lineH : f.y + f.h / 2 + size * 0.35;
      let bx = f.x + 2;
      if (!f.multiLine && f.align) { const tw = font.widthOfTextAtSize(line, size); bx = f.align === 1 ? f.x + (f.w - tw) / 2 : f.x + f.w - 2 - tw; }
      const { x, y } = m.toPdf(bx, by);
      page.drawText(line, { x, y, size, font, color: black, rotate: degrees(m.rot) });
    });
  }
}

async function drawAnnots(pdfDoc, doc, mappers) {
  const pages = pdfDoc.getPages();
  const fonts = {};
  const fontFor = async bold => {
    const k = bold ? 'b' : 'r';
    if (!fonts[k]) fonts[k] = await pdfDoc.embedFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
    return fonts[k];
  };
  const imgCache = new Map();

  for (const a of doc.annots || []) {
    const page = pages[a.page]; const m = mappers[a.page];
    if (!page || !m) continue;
    const rotate = degrees(m.rot);

    if (a.type === 'text') {
      if (!a.text || !a.text.trim()) continue;
      const font = await fontFor(a.bold);
      const size = a.size || 12, pad = 2, padX = 3;
      const lines = wrapLines(a.text, font, size, Math.max(4, a.w - padX * 2));
      const lineH = size * 1.2;
      const color = hexToRgb(a.color);
      lines.forEach((line, i) => {
        if (!line) return;
        // Baseline of line i in display space (top-aligned, matching the on-screen box).
        const bx = a.x + padX, by = a.y + pad + size * 0.92 + i * lineH;
        const { x, y } = m.toPdf(bx, by);
        page.drawText(line, { x, y, size, font, color, rotate });
      });
    } else if (a.type === 'check' || a.type === 'cross') {
      const color = hexToRgb(a.color);
      const t = Math.max(1.2, Math.min(a.w, a.h) * 0.12);
      const pts = a.type === 'check'
        ? [[0.12, 0.55], [0.4, 0.82], [0.9, 0.18]]
        : [[0.15, 0.15], [0.85, 0.85], null, [0.85, 0.15], [0.15, 0.85]];
      let prev = null;
      for (const p of pts) {
        if (!p) { prev = null; continue; }
        const cur = m.toPdf(a.x + p[0] * a.w, a.y + p[1] * a.h);
        if (prev) page.drawLine({ start: prev, end: cur, thickness: t, color, lineCap: LineCapStyle.Round });
        prev = cur;
      }
    } else if (a.type === 'ink' && a.points && a.points.length > 1) {
      const color = hexToRgb(a.color); const t = a.width || 2;
      let prev = null;
      for (const p of a.points) {
        const cur = m.toPdf(a.x + p[0] * a.w, a.y + p[1] * a.h);
        if (prev) page.drawLine({ start: prev, end: cur, thickness: t, color, lineCap: LineCapStyle.Round });
        prev = cur;
      }
    } else if (a.type === 'image' && a.dataUrl) {
      let img = imgCache.get(a.dataUrl);
      if (!img) {
        const bytes = await dataUrlToBytes(a.dataUrl);
        img = a.dataUrl.startsWith('data:image/png') ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
        imgCache.set(a.dataUrl, img);
      }
      const { x, y } = m.toPdf(a.x, a.y + a.h);
      page.drawImage(img, { x, y, width: a.w, height: a.h, rotate });
    }
  }
}
