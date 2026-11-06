// Turns files into document objects, and documents into pdf.js handles.
import * as pdfjsLib from '../vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
const CMAPS = new URL('../vendor/cmaps/', import.meta.url).href;
const STD_FONTS = new URL('../vendor/standard_fonts/', import.meta.url).href;

export { pdfjsLib };

export const LETTER = { w: 612, h: 792 };
const MAX_IMAGE_PX = 2600;

export function newId() {
  return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function baseDoc(name, kind) {
  const now = Date.now();
  return { id: newId(), name, kind, createdAt: now, updatedAt: now, source: null, pages: [], fields: {}, annots: [], thumb: null };
}

export function stripExt(name) { return (name || 'Document').replace(/\.[^.]+$/, ''); }

// ---------- PDF ----------
export async function openPdfJs(bytes, password) {
  const task = pdfjsLib.getDocument({
    data: bytes.slice(0), cMapUrl: CMAPS, cMapPacked: true, standardFontDataUrl: STD_FONTS,
    password, isEvalSupported: false
  });
  return task.promise;
}

export async function loadPdfFile(file, askPassword) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let pdf, password;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { pdf = await openPdfJs(bytes, password); break; }
    catch (e) {
      if (e && e.name === 'PasswordException' && askPassword) {
        password = await askPassword(attempt > 0);
        if (password == null) throw new Error('Password required');
      } else throw e;
    }
  }
  // pdf-lib must be able to load the file to write it back later. Encrypted ("secured") PDFs and
  // some damaged files can't be, so those are opened as page images instead, with the detected
  // form fields drawn onto the images at export time.
  let writable = true;
  try { await window.PDFLib.PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (e) { console.warn('pdf-lib cannot load this file, rasterizing:', e && e.message); writable = false; }
  if (!writable) return { doc: await rasterizePdf(pdf, stripExt(file.name), !!password), pdf: null };

  const doc = baseDoc(stripExt(file.name), 'pdf');
  doc.source = bytes.buffer;
  doc.password = password || null;
  const n = pdf.numPages;
  for (let i = 1; i <= n; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    doc.pages.push({ w: vp.width, h: vp.height, rotation: page.rotate, image: null });
  }
  return { doc, pdf };
}

async function rasterizePdf(pdf, name, hadPassword) {
  const doc = baseDoc(name, 'image');
  const SCALE = 2; // 144 dpi
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: SCALE });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS }).promise;
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
    doc.pages.push({ w: vp1.width, h: vp1.height, rotation: 0, image: blob, pxW: c.width, pxH: c.height });
  }
  doc.fieldDefs = await extractFields(pdf);
  doc.note = (hadPassword ? 'Password-protected' : 'Protected') + ' PDF — opened as page images. Fields still work; the result is a flat PDF.';
  try { pdf.destroy(); } catch { /* ignore */ }
  return doc;
}

// Widget annotations (AcroForm fields) with display-space rects, per page.
export async function extractFields(pdf) {
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    let annots = [];
    try { annots = await page.getAnnotations({ intent: 'display' }); } catch { continue; }
    for (const a of annots) {
      if (a.subtype !== 'Widget' || !a.fieldName || a.hidden || a.pushButton) continue;
      const r = vp.convertToViewportRectangle(a.rect);
      const x = Math.min(r[0], r[2]), y = Math.min(r[1], r[3]);
      const w = Math.abs(r[2] - r[0]), h = Math.abs(r[3] - r[1]);
      if (w < 2 || h < 2) continue;
      let type = a.fieldType; // Tx, Btn, Ch, Sig
      if (type === 'Btn') type = a.radioButton ? 'radio' : 'checkbox';
      else if (type === 'Tx') type = 'text';
      else if (type === 'Ch') type = a.combo ? 'combo' : 'list';
      else if (type === 'Sig') type = 'sig';
      else continue;
      out.push({
        name: a.fieldName, type, page: i - 1, x, y, w, h,
        value: a.fieldValue, exportValue: a.exportValue ?? a.buttonValue ?? 'Yes',
        options: (a.options || []).map(o => ({ v: o.exportValue, label: o.displayValue })),
        multiLine: !!a.multiLine, readOnly: !!a.readOnly, maxLen: a.maxLen || 0,
        align: a.textAlignment || 0, comb: !!a.comb
      });
    }
  }
  return out;
}

// ---------- Images ----------
async function decodeImage(file) {
  // createImageBitmap handles orientation on modern browsers; fall back to <img>.
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this image')); };
      img.src = url;
    });
  }
}

export async function imageToPage(file) {
  const bmp = await decodeImage(file);
  const iw = bmp.width || bmp.naturalWidth, ih = bmp.height || bmp.naturalHeight;
  const scale = Math.min(1, MAX_IMAGE_PX / Math.max(iw, ih));
  const cw = Math.round(iw * scale), ch = Math.round(ih * scale);
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(bmp, 0, 0, cw, ch);
  if (bmp.close) bmp.close();
  const isPng = /png/i.test(file.type);
  const blob = await new Promise(r => c.toBlob(r, isPng ? 'image/png' : 'image/jpeg', 0.9));
  // Page is letter-width; height keeps the photo's aspect ratio.
  const w = LETTER.w, h = Math.round(LETTER.w * ch / cw);
  return { w, h, rotation: 0, image: blob, pxW: cw, pxH: ch };
}

export async function loadImageFiles(files) {
  const doc = baseDoc(stripExt(files[0].name) || 'Scan', 'image');
  for (const f of files) doc.pages.push(await imageToPage(f));
  return doc;
}

export function blankDoc(name = 'Blank page') {
  const doc = baseDoc(name, 'image');
  doc.pages.push({ w: LETTER.w, h: LETTER.h, rotation: 0, image: null });
  return doc;
}

// ---------- Word (.docx) ----------
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

export async function loadDocxFile(file) {
  if (!window.mammoth) await loadScript('vendor/mammoth.browser.min.js');
  if (!window.html2canvas) await loadScript('vendor/html2canvas.min.js');
  const buf = await file.arrayBuffer();
  const res = await window.mammoth.convertToHtml({ arrayBuffer: buf }, { convertImage: window.mammoth.images.imgElement(img => img.read('base64').then(b => ({ src: `data:${img.contentType};base64,${b}` }))) });

  // Lay the HTML out on an off-screen US-Letter page and rasterize it.
  const PAGE_W = 816, PAGE_H = 1056, MARGIN = 72;
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${PAGE_W}px;background:#fff;padding:${MARGIN}px;box-sizing:border-box;font-family:"Times New Roman",Times,serif;font-size:16px;line-height:1.35;color:#000;`;
  host.innerHTML = `<style>
    .docx img{max-width:100%;height:auto} .docx table{border-collapse:collapse;width:100%} .docx td,.docx th{border:1px solid #999;padding:3px 6px;vertical-align:top}
    .docx p{margin:0 0 8px} .docx h1{font-size:26px} .docx h2{font-size:22px} .docx h3{font-size:18px}
  </style><div class="docx">${res.value}</div>`;
  document.body.appendChild(host);
  await new Promise(r => setTimeout(r, 50));
  const canvas = await window.html2canvas(host, { scale: 2, backgroundColor: '#fff', useCORS: true, logging: false });
  host.remove();

  const doc = baseDoc(stripExt(file.name), 'image');
  const sliceH = PAGE_H * 2, totalH = canvas.height, srcCtx = canvas.getContext('2d');
  // Prefer cutting on a blank row so lines of text aren't sliced in half.
  const isBlankRow = y => { const d = srcCtx.getImageData(0, y, canvas.width, 1).data; for (let i = 0; i < d.length; i += 4) if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) return false; return true; };
  let y = 0;
  while (y < totalH && doc.pages.length < 60) {
    let end = Math.min(y + sliceH, totalH);
    if (end < totalH) { for (let r = end; r > end - 260; r--) if (isBlankRow(r)) { end = r; break; } }
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = sliceH;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(canvas, 0, y, canvas.width, end - y, 0, 0, canvas.width, end - y);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
    doc.pages.push({ w: LETTER.w, h: LETTER.h, rotation: 0, image: blob, pxW: c.width, pxH: c.height });
    y = end;
  }
  doc.note = 'Converted from Word — layout is approximate.';
  return doc;
}

// ---------- Dispatcher ----------
export function classify(file) {
  const n = (file.name || '').toLowerCase(), t = file.type || '';
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (t.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?)$/.test(n)) return 'image';
  if (n.endsWith('.docx') || t.includes('wordprocessingml')) return 'docx';
  if (n.endsWith('.doc')) return 'doc';
  return 'unknown';
}
