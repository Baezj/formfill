# FormFill

A personal, browser-only form filler. Open a PDF, a photo of a form, or a Word file; type into it, tick boxes, drop in your signature and today's date; then download, share or print the finished PDF.

**Nothing is uploaded anywhere.** Files, your saved details and signatures live only in your browser (IndexedDB / localStorage). It works offline after the first visit, and you can add it to your phone's home screen like an app.

## What it does

- **PDF** — fillable fields are detected and become real inputs; non-fillable PDFs get free-floating text, check marks, X marks, dates, images and signatures anywhere on the page.
- **Photos / scans** — open an image (or take one with the camera) and fill it like a page.
- **Word (.docx)** — converted in the browser to pages you can fill and sign (layout is approximate).
- **Signatures & initials** — draw, type in a script font, or upload a photo of your signature (white background removed). Saved for one-tap reuse.
- **Smart fill** — keep your name, address, phone, email, etc. in Settings. One tap fills matching PDF form fields, and on flat PDFs it reads the page text, finds "Name: ____", "Date", "Signature" and the like, and places your details, today's date and your saved signature in the right spots. **My info** chips drop any single detail wherever you tap.
- **Next field** — jumps through empty fields on long forms, zooming in so they're readable on a phone.
- **Finish** — flatten and download, share (Save to Files / AirDrop / email on iOS), print, or open in a new tab. Undo/redo, pinch to zoom, multi-page, add blank or photo pages.

## Notes

- **iPhone/iPad:** add it to the Home Screen. Safari can clear a website's saved data after 7 days without a visit; home-screen apps are exempt. Share → Save to Files keeps a permanent copy of any finished PDF.
- **"Secured" / password PDFs** are opened as page images (the detected fields still work); the result is a flat PDF.
- **Word files** are rendered in the browser (mammoth + html2canvas); layout is approximate.
- **Updating:** bump `VERSION` in `sw.js` whenever anything under `vendor/` changes, or installed copies keep serving the old pdf.js worker with a new main script.

## Run it

It is plain static files: open `index.html` from any web server (GitHub Pages works as-is). No build step.

Libraries (vendored in `vendor/`): [pdf.js](https://mozilla.github.io/pdf.js/) for rendering, [pdf-lib](https://pdf-lib.js.org/) for writing, [signature_pad](https://github.com/szimek/signature_pad), [mammoth](https://github.com/mwilliamson/mammoth.js) + [html2canvas](https://html2canvas.hertzen.com/) for Word files.
