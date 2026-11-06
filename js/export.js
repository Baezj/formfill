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
        field.setText(winAnsiSafe(String(v ?? '')));
      } else if (field instanceof PDFCheckBox) {
        // v is either boolean or the export value of the widget that should be on.
        if (v === false || v === '' || v == null || v === 'Off') field.uncheck();
        else if (v === true) field.check();
        else field.acroField.setValue(PDFName.of(String(v)));
      } else if (field instanceof PDFRadioGroup) {
        if (v == null || v === '' || v === 'Off') { try { field.clear(); } catch { /* ignore */ } }
        else {
          try { field.select(String(v)); }
          catch { field.acroField.setValue(PDFName.of(String(v))); }
        }
      } else if (field instanceof PDFDropdown) {
        if (v != null && v !== '') {
          try { field.select(String(v)); }
          catch { field.setOptions([...new Set([...field.getOptions(), String(v)])]); field.select(String(v)); }
        } else field.clear();
      } else if (field instanceof PDFOptionList) {
        const arr = Array.isArray(v) ? v : (v ? [v] : []);
        try { field.select(arr.map(String)); } catch { /* ignore */ }
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
