import { holesSVG, beatsLabel, getTabStyle, setTabStyle } from './render.js';
import { fingerNumbers, markFor } from './core.js';
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
    const mark = markFor(item.holes, item.register);
    const breath = item.register === 3 ? `<span class="upper">Blow much harder (3rd octave)${mark ? ' ' + mark : ''}</span>`
      : item.register === 2 ? `<span class="upper">Blow harder (high octave)${mark ? ' ' + mark : ''}</span>` : 'Gentle breath (low octave)';
    const extras = [
      item.halfHole ? 'Half-cover the marked hole' : '',
      item.cross ? 'Cross fingering' : '',
      item.octaveShift ? `Out of range: played ${item.octaveShift > 0 ? 'an octave higher' : 'an octave lower'}` : '',
      item.tie ? 'Tied: keep holding into the next note' : '',
    ].filter(Boolean).map((t) => `<div class="hint">${t}</div>`).join('');
    desc = `<div class="desc"><div class="name">${pretty(item.name)}<span class="muted small"> (${esc(item.pitch)})</span></div><div class="fingers" title="Holes to cover">${fingerNumbers(item.holes, item.register)}</div><div>${breath}</div><div class="hint">Length: ${len} ${beatWord}</div>${extras}</div>`;
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

/** "Tab: Numbers | Hole diagrams" switch. onChange re-renders the tab. */
export function tabStyleControl(el, onChange) {
  el.innerHTML = `<label for="tab-style">Tab</label> <select id="tab-style"><option value="numbers">Numbers</option><option value="holes">Hole diagrams</option></select>`;
  const sel = el.querySelector('select');
  sel.value = getTabStyle();
  sel.addEventListener('change', () => { setTabStyle(sel.value); onChange(); });
}

// ---- light / dark theme (light by default; the choice is remembered)
const THEME_KEY = 'pw-theme';
const isDark = () => document.documentElement.dataset.theme === 'dark';
function themeButton() {
  const dark = isDark();
  return `<button class="btn theme-toggle" id="theme-toggle" type="button" aria-pressed="${dark}" title="Switch to ${dark ? 'light' : 'dark'} mode" aria-label="Dark mode">${dark ? '☀' : '☾'}</button>`;
}
// Player collapse: shrink the player to a small button; the choice is remembered.
const PLAYER_KEY = 'pw-player-collapsed';
function setPlayerCollapsed(player, collapsed) {
  player.classList.toggle('collapsed', collapsed);
  document.body.classList.toggle('player-collapsed', collapsed);
  const btn = player.querySelector('.player-collapse');
  if (!btn) return;
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.textContent = collapsed ? '▶ Player' : '▾';
  btn.title = collapsed ? 'Show player' : 'Hide player';
  btn.setAttribute('aria-label', btn.title);
}
document.querySelectorAll('.player').forEach((p) => {
  let collapsed = false;
  try { collapsed = localStorage.getItem(PLAYER_KEY) === '1'; } catch { /* storage unavailable */ }
  setPlayerCollapsed(p, collapsed);
});
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.player-collapse');
  if (!btn) return;
  const player = btn.closest('.player');
  const collapsed = !player.classList.contains('collapsed');
  setPlayerCollapsed(player, collapsed);
  try { localStorage.setItem(PLAYER_KEY, collapsed ? '1' : '0'); } catch { /* storage unavailable */ }
});

// Small-screen helpers: player settings toggle, and closing the "More" menu on outside taps.
document.addEventListener('click', (e) => {
  const st = e.target.closest('.settings-toggle');
  if (st) {
    const player = st.closest('.player');
    const open = !player.classList.contains('show-settings');
    player.classList.toggle('show-settings', open);
    st.setAttribute('aria-expanded', String(open));
  }
  document.querySelectorAll('details.more[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('#theme-toggle');
  if (!btn) return;
  const dark = !isDark();
  if (dark) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch { /* storage blocked */ }
  btn.outerHTML = themeButton();
});

export function topbar(active) {
  return `<header class="topbar">
    <a class="brand" href="./" aria-label="Penny Whistle Tabs: library"><svg viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="13" width="26" height="6" rx="3" fill="var(--accent)"/><circle cx="12" cy="16" r="1.6" fill="var(--surface)"/><circle cx="17" cy="16" r="1.6" fill="var(--surface)"/><circle cx="22" cy="16" r="1.6" fill="var(--surface)"/><rect x="3" y="13" width="5" height="6" rx="2" fill="var(--ink)"/></svg><span class="brand-long">Penny Whistle Tabs</span><span class="brand-short">Whistle Tabs</span></a>
    <nav><a class="btn ${active === 'library' ? 'primary' : ''}" href="./">Library</a><a class="btn ${active === 'new' ? 'primary' : ''}" href="editor.html"><span class="brand-long">+ New tab</span><span class="brand-short">+ New</span></a>${themeButton()}</nav>
  </header>`;
}

export function originalSources(tune) {
  return (tune.originals || []).map((o) => ({ url: apiUrl(`tunes/${tune.id}/files/${o.file}`), type: o.type, name: o.originalName }));
}
