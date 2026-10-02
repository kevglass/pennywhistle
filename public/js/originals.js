// Loading and displaying the original sheet music (PDF or images).

let pdfjsPromise = null;
function pdfjs() {
  pdfjsPromise ??= import(new URL('../vendor/pdf.min.mjs', import.meta.url).href).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
    return lib;
  });
  return pdfjsPromise;
}

export const ACCEPTED = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Render every page of the given sources (File/Blob or {url,type}) to canvases. */
export async function renderPages(sources, { maxSide = 2200 } = {}) {
  const pages = [];
  for (const src of sources) {
    const type = src.type;
    const buf = src.url ? await (await fetch(src.url)).arrayBuffer() : await src.arrayBuffer();
    if (type === 'application/pdf') {
      const lib = await pdfjs();
      const doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const v1 = page.getViewport({ scale: 1 });
        const scale = Math.min(4, maxSide / Math.max(v1.width, v1.height));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        pages.push({ canvas, label: `${src.name || 'PDF'} · page ${n}` });
      }
    } else {
      const img = await createImageBitmap(new Blob([buf], { type }));
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      pages.push({ canvas, label: src.name || 'Image' });
    }
  }
  return pages;
}

/** JPEG page images for sending to Claude. */
export function pagesToImages(pages, maxSide = 2000) {
  return pages.map(({ canvas }) => {
    let c = canvas;
    const s = maxSide / Math.max(canvas.width, canvas.height);
    if (s < 1) {
      c = document.createElement('canvas');
      c.width = Math.round(canvas.width * s);
      c.height = Math.round(canvas.height * s);
      c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    }
    return { mediaType: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.88).split(',')[1] };
  });
}

export function showPages(container, pages) {
  container.innerHTML = '';
  for (const p of pages) {
    const fig = document.createElement('figure');
    fig.className = 'page';
    p.canvas.setAttribute('role', 'img');
    p.canvas.setAttribute('aria-label', p.label);
    fig.appendChild(p.canvas);
    const cap = document.createElement('figcaption');
    cap.textContent = p.label;
    fig.appendChild(cap);
    container.appendChild(fig);
  }
}
