import { holesSVG, beatsLabel } from './render.js';
import { chordDiagramSVG } from './guitar.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** URL of an API route, relative to the page (works when hosted in a sub-folder). */
export const apiUrl = (route) => `api/index.php?r=${route.split('/').map(encodeURIComponent).join('/')}`;

export async function api(route, opts = {}) {
  const json = opts.body && !(opts.body instanceof FormData);
  const res = await fetch(apiUrl(route), {
    ...opts,
    headers: json ? { 'Content-Type': 'application/json', ...(opts.headers || {}) } : opts.headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const pretty = (n) => n.replace('#', '♯').replace(/b(\d|$)/, '♭$1');

/** The big "current note" read-out shown above the tab. */
export function renderNow(el, item, { chord } = {}) {
  if (!item) {
    el.innerHTML = '<div class="empty-now">Click a note in the music or the tab to see its fingering.</div>';
    return;
  }
  const len = beatsLabel(item.beats);
  const beatWord = item.beats === 1 ? 'beat' : 'beats';
  let holes = '', desc = '';
  if (item.type === 'note') {
    holes = `<div class="big-holes">${holesSVG(item.holes, { r: 8, gap: 18, groupGap: 8, label: 'Fingering for ' + item.pitch })}</div>`;
    const breath = item.register === 3 ? '<span class="upper">Blow much harder (3rd octave)</span>'
      : item.register === 2 ? '<span class="upper">Blow harder (2nd octave) +</span>' : 'Gentle breath (low octave)';
    const extras = [
      item.halfHole ? 'Half-cover the marked hole' : '',
      item.cross ? 'Cross fingering' : '',
      item.octaveShift ? `Out of range: played ${item.octaveShift > 0 ? 'an octave higher' : 'an octave lower'}` : '',
      item.tie ? 'Tied: keep holding into the next note' : '',
    ].filter(Boolean).map((t) => `<div class="hint">${t}</div>`).join('');
    desc = `<div class="desc"><div class="name">${pretty(item.name)}<span class="muted small"> (${esc(item.pitch)})</span></div><div>${breath}</div><div class="hint">Length: ${len} ${beatWord}</div>${extras}</div>`;
  } else if (item.type === 'rest') {
    desc = `<div class="desc"><div class="name">Rest</div><div class="hint">Silence for ${len} ${beatWord}. Take a breath.</div></div>`;
  } else {
    desc = `<div class="desc"><div class="name">Hold</div><div class="hint">Keep the previous note sounding for ${len} more ${beatWord}.</div></div>`;
  }
  const ch = chord ? `<div class="chord" title="Guitar chord">${chordDiagramSVG(chord)}</div>` : '';
  el.innerHTML = holes + desc + ch;
}

export function renderChordList(el, names) {
  el.innerHTML = names.length
    ? names.map((n) => `<figure>${chordDiagramSVG(n)}</figure>`).join('')
    : '<p class="muted">No chords.</p>';
}

export function renderLegend(el) {
  el.innerHTML = `
    <div class="item"><span class="sw">${holesSVG('XXXOOO')}</span><span>Holes from the mouthpiece (top) down. <b>●</b> cover, <b>○</b> open. Left hand covers the top three.</span></div>
    <div class="item"><span class="sw">${holesSVG('XXHOOO')}</span><span>Half-filled hole = half-cover it (for notes outside the key).</span></div>
    <div class="item"><span class="sw" style="color:var(--upper);font-weight:800;font-size:18px">+</span><span>Blow harder for the second octave (same fingering). <b>++</b> = harder still.</span></div>
    <div class="item"><span class="sw" style="width:46px;position:relative;height:14px"><span class="sustain" style="left:0;width:44px;bottom:0"><span>1½</span></span></span><span>Bar under each note = how long it lasts, with its count in beats.</span></div>
    <div class="item"><span class="sw rest-mark" style="height:auto;writing-mode:horizontal-tb">rest</span><span>Rest: stop blowing for the length shown.</span></div>
    <div class="item"><span class="sw hold-mark" style="height:auto;writing-mode:horizontal-tb">hold</span><span>Hold: a tied note, keep the previous note going.</span></div>
    <div class="item"><span class="sw" style="color:var(--accent);font-weight:700">G&nbsp;D7</span><span>Guitar chords appear above the music where they change.</span></div>
    <div class="item"><span class="sw" style="color:var(--warn);font-weight:700;font-size:11px">8↑</span><span>Note was too low/high for the whistle, so it's shown an octave up/down.</span></div>`;
}

export function topbar(active) {
  return `<header class="topbar">
    <a class="brand" href="./"><svg viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="13" width="26" height="6" rx="3" fill="var(--accent)"/><circle cx="12" cy="16" r="1.6" fill="var(--surface)"/><circle cx="17" cy="16" r="1.6" fill="var(--surface)"/><circle cx="22" cy="16" r="1.6" fill="var(--surface)"/><rect x="3" y="13" width="5" height="6" rx="2" fill="var(--ink)"/></svg>Penny Whistle Tabs</a>
    <nav><a class="btn ${active === 'library' ? 'primary' : ''}" href="./">Library</a><a class="btn ${active === 'new' ? 'primary' : ''}" href="editor.html">+ New tab</a></nav>
  </header>`;
}

export function originalSources(tune) {
  return (tune.originals || []).map((o) => ({ url: apiUrl(`tunes/${tune.id}/files/${o.file}`), type: o.type, name: o.originalName }));
}
