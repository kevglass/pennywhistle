// "Download PDF": the score with the whistle number tab under every line (vector),
// guitar chord diagrams, and the plain-text tab. Built in the browser with jsPDF + svg2pdf.
import { TabView, beatsLabel, getTabStyle } from './render.js';
import { fingerNumbers, markFor } from './core.js';
import { chordDiagramSVG } from './guitar.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const LAYOUT_WIDTH = 900; // px; scaled to the A4 text width
const C = { ink: '#000000', muted: '#555555', faint: '#bbbbbb', upper: '#6741d9', warn: '#b35c00', accent: '#1f6f5c' };

const loaded = {};
function loadScript(rel) {
  const url = new URL(rel, import.meta.url).href;
  loaded[url] ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${rel}`));
    document.head.appendChild(s);
  });
  return loaded[url];
}

function el(name, attrs = {}, text) {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

// Standard PDF fonts only cover Latin-1, so swap symbols they lack.
const pdfText = (s) => String(s ?? '')
  .replace(/♯/g, '#').replace(/♭/g, 'b').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/⅓/g, '1/3').replace(/⅔/g, '2/3').replace(/⅛/g, '1/8').replace(/⅙/g, '1/6').replace(/·/g, '-');

/** Draw one tab row (numbers or hole diagrams, plus note-length bars) into an SVG. */
function drawTabRow(svg, view, box, width) {
  const y0 = box.tabTop;
  const bottom = box.bottom;
  svg.appendChild(el('line', { x1: 0, y1: y0, x2: width, y2: y0, stroke: C.faint, 'stroke-width': 0.7, 'stroke-dasharray': '3 3' }));
  const holesStyle = getTabStyle() === 'holes';
  const font = { 'font-family': 'helvetica', 'text-anchor': 'middle' };
  for (const r of box.refs) {
    const it = r.item;
    if (r.tabX == null || it.invisible) continue;
    const x = r.tabX;
    const upper = it.type === 'note' && it.register > 1;
    if (it.type === 'note') {
      svg.appendChild(el('text', { ...font, x, y: y0 + 12, 'font-size': 9, 'font-weight': 'bold', fill: upper ? C.upper : C.muted }, pdfText(it.name)));
      if (holesStyle) {
        [...it.holes].forEach((h, i) => {
          const cy = y0 + 22 + i * 10.6 + (i >= 3 ? 5 : 0);
          svg.appendChild(el('circle', { cx: x, cy, r: 4.4, fill: h === 'X' ? C.ink : '#ffffff', stroke: C.ink, 'stroke-width': 1.1 }));
          if (h === 'H') svg.appendChild(el('path', { d: `M ${x} ${cy - 4.4} A 4.4 4.4 0 0 0 ${x} ${cy + 4.4} Z`, fill: C.ink }));
        });
        if (markFor(it.holes, it.register)) svg.appendChild(el('text', { ...font, x, y: y0 + 98, 'font-size': 14, 'font-weight': 'bold', fill: C.upper }, markFor(it.holes, it.register)));
      } else {
        const t = el('text', { ...font, x, y: y0 + 31, 'font-size': 14, 'font-weight': 'bold', fill: C.ink });
        const tok = fingerNumbers(it.holes);
        const m = tok.match(/^0\/(.+)$/);
        if (m) {
          t.appendChild(el('tspan', { 'font-size': 9.5, fill: C.warn }, '0/'));
          t.appendChild(el('tspan', {}, pdfText(m[1])));
        } else t.appendChild(el('tspan', {}, pdfText(tok)));
        if (markFor(it.holes, it.register)) t.appendChild(el('tspan', { fill: C.upper }, markFor(it.holes, it.register)));
        svg.appendChild(t);
      }
    } else {
      svg.appendChild(el('text', { ...font, x, y: y0 + (holesStyle ? 50 : 30), 'font-size': 9, 'font-style': 'italic', fill: C.muted }, it.type === 'rest' ? 'rest' : 'hold'));
    }
    // note length bar
    const by = holesStyle ? bottom - 6 : y0 + 44;
    const color = it.type === 'rest' ? C.muted : C.accent;
    const x2 = Math.max(x + 4, r.tabNext - 2);
    svg.appendChild(el('line', { x1: x - 6, y1: by - 5, x2: x - 6, y2: by + 5, stroke: color, 'stroke-width': 1.4 }));
    svg.appendChild(el('line', { x1: x - 6, y1: by, x2, y2: by, stroke: color, 'stroke-width': 1.6, 'stroke-opacity': it.type === 'rest' ? 0.6 : 0.5, ...(it.type === 'rest' ? { 'stroke-dasharray': '3 2' } : {}) }));
    svg.appendChild(el('text', { 'font-family': 'helvetica', x: x2, y: by - 2.5, 'font-size': 7, 'text-anchor': 'end', fill: C.muted }, pdfText(beatsLabel(it.beats))));
  }
}

/** Chord box diagram with inline styling (the on-screen version styles via CSS classes). */
function chordSVG(name) {
  const wrap = document.createElement('div');
  wrap.innerHTML = chordDiagramSVG(pdfText(name));
  const svg = wrap.firstElementChild;
  const styles = {
    'cd-name': { fill: C.ink, 'font-family': 'helvetica', 'font-weight': 'bold', 'font-size': 12 },
    'cd-line': { stroke: '#777777', 'stroke-width': 1 },
    'cd-nut': { stroke: C.ink, 'stroke-width': 3 },
    'cd-dot': { fill: C.ink },
    'cd-open': { fill: 'none', stroke: C.ink, 'stroke-width': 1.2 },
    'cd-mark': { fill: C.muted, 'font-family': 'helvetica', 'font-size': 10 },
    'cd-fret': { fill: C.muted, 'font-family': 'helvetica', 'font-size': 10 },
    'cd-muted': { fill: C.muted, 'font-family': 'helvetica', 'font-size': 10 },
  };
  svg.querySelectorAll('[class]').forEach((n) => {
    for (const [k, v] of Object.entries(styles[n.getAttribute('class')] || {})) n.setAttribute(k, v);
    n.removeAttribute('class');
  });
  return svg;
}

export async function downloadPdf({ displayAbc, title, composer, key, meter, chords = [], textTab = '', filename = 'whistle-tab.pdf' }) {
  await loadScript('../vendor/jspdf.umd.min.js');
  await loadScript('../vendor/svg2pdf.umd.min.js');
  const { jsPDF } = window.jspdf;

  const host = document.createElement('div');
  host.style.cssText = `position:absolute;left:-30000px;top:0;width:${LAYOUT_WIDTH}px;color:#000`;
  document.body.appendChild(host);
  try {
    const view = new TabView(host);
    view.render(displayAbc);
    if (!view.lineBoxes?.length) throw new Error('Nothing to export');

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const M = 14, PW = 210, PH = 297, W = PW - 2 * M;
    let y = M;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text(pdfText(title), PW / 2, y + 6, { align: 'center' });
    y += 12;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(pdfText([composer, key && `Key ${key}`, meter && `Time ${meter}`, 'D tin whistle'].filter(Boolean).join('    ')), PW / 2, y, { align: 'center' });
    y += 6;
    doc.setFontSize(8.5);
    doc.setTextColor(85);
    const howTo = "Numbers = how many holes to hold down from the top (mouthpiece end): 3 = holes 1-3.  0/N = top hole open, hold the next N (0/2 = holes 2-3).  0 = all open.  ' = blow harder (high octave).  ½ = also half-cover the next hole.  Bars under the notes show how long each lasts (in beats).";
    const howLines = doc.splitTextToSize(pdfText(howTo), W);
    doc.text(howLines, PW / 2, y, { align: 'center' });
    y += howLines.length * 3.6 + 3;
    doc.setTextColor(0);

    const svgRect = view.svg.getBoundingClientRect();
    const base = view.wrap.getBoundingClientRect();
    const ox = svgRect.left - base.left;
    const oy = svgRect.top - base.top;
    const pxW = svgRect.width;
    const mmPerPx = W / pxW;

    for (const box of view.lineBoxes) {
      const top = box.top - 4;
      const hPx = box.bottom + 2 - top;
      const s = el('svg', { xmlns: SVGNS, width: pxW, height: hPx, viewBox: `0 ${top} ${pxW} ${hPx}` });
      const staff = view.svg.querySelector(`g.abcjs-staff-wrapper.abcjs-l${box.line}`).cloneNode(true);
      staff.querySelectorAll('.note-active').forEach((n) => n.classList.remove('note-active'));
      const holder = el('g', { transform: `translate(${ox} ${oy})`, fill: '#000000', color: '#000000' });
      holder.appendChild(staff);
      s.appendChild(holder);
      drawTabRow(s, view, box, pxW);
      host.appendChild(s); // svg2pdf measures text, so it must be in the document
      const hMm = hPx * mmPerPx;
      if (y + hMm > PH - M) { doc.addPage(); y = M; }
      await doc.svg(s, { x: M, y, width: W, height: hMm });
      s.remove();
      y += hMm + 1.5;
    }

    if (chords.length) {
      const size = 22, perRow = Math.floor(W / (size + 3));
      const rows = Math.ceil(chords.length / perRow);
      if (y + 8 + rows * (size * 92 / 74 + 2) > PH - M) { doc.addPage(); y = M; }
      y += 4;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('Guitar chords', M, y);
      y += 3;
      for (let i = 0; i < chords.length; i++) {
        const svg = chordSVG(chords[i]);
        host.appendChild(svg);
        const col = i % perRow;
        if (i && col === 0) y += size * 92 / 74 + 2;
        await doc.svg(svg, { x: M + col * (size + 3), y, width: size, height: size * 92 / 74 });
        svg.remove();
      }
      y += size * 92 / 74 + 4;
    }

    if (textTab) {
      const lines = pdfText(textTab).split('\n');
      const longest = Math.max(...lines.map((l) => l.length), 1);
      const fs = Math.min(8.5, W / (longest * 0.6 * 0.3528)); // Courier glyphs are 0.6em wide
      const lh = fs * 0.3528 * 1.35;
      if (y + 20 > PH - M) { doc.addPage(); y = M; }
      y += 4;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('Whistle tab (text)', M, y);
      y += 5;
      doc.setFont('courier', 'normal');
      doc.setFontSize(fs);
      for (const line of lines) {
        if (y + lh > PH - M) { doc.addPage(); y = M; }
        doc.text(line, M, y);
        y += lh;
      }
    }

    const pages = doc.internal.getNumberOfPages();
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120);
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.text(`${pdfText(title)}  -  page ${p} of ${pages}`, PW / 2, PH - 7, { align: 'center' });
    }
    doc.save(filename);
  } finally {
    host.remove();
  }
}
