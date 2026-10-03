import { holesSVG, beatsLabel, getTabStyle, setTabStyle, getShowNoteNames, setShowNoteNames } from './render.js';
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
  if (!res.ok) throw apiError(res, data);
  return data;
}

/** Error for a failed API response; signIn is set when the user needs to sign in (again). */
export function apiError(res, data = {}) {
  const e = new Error(data.error || `Request failed (${res.status})`);
  e.signIn = res.status === 401 && !!data.login;
  return e;
}

/** The sign-in page, coming back to this page afterwards (or, in a new tab, just closing). */
export const loginUrl = (newTab = false) => (newTab ? 'login.html?then=close'
  : `login.html?next=${encodeURIComponent(location.pathname.split('/').pop() + location.search)}`);

/**
 * An error message as HTML. When the user needs to sign in, says so with a button to the
 * sign-in page instead; newTab keeps this page (and any unsaved work) open.
 */
export function errorHTML(e, prefix = '', { newTab = false } = {}) {
  if (e?.signIn) {
    return `<div class="signin-needed"><span>${newTab ? 'Your sign-in has expired. Sign in again, then try again here.' : 'You need to sign in to see this.'}</span>`
      + `<a class="btn primary" href="${esc(loginUrl(newTab))}"${newTab ? ' target="_blank" rel="opener"' : ''}>Sign in</a></div>`;
  }
  return `<span class="error">${esc(prefix ? `${prefix}: ${e.message}` : e.message)}</span>`;
}

export async function signOut() {
  await fetch(apiUrl('auth/logout'), { method: 'POST' }).catch(() => {});
  try { window.google?.accounts.id.disableAutoSelect(); } catch { /* not loaded */ }
  location.href = 'login.html';
}

// Fill the topbar's account menu once the signed-in user is known (redirects to sign-in if not).
async function showUser() {
  const el = document.getElementById('account');
  if (!el) return;
  try {
    const u = await api('auth/me');
    el.hidden = false;
    el.querySelector('summary').innerHTML = u.picture
      ? `<img class="avatar" src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer" width="22" height="22">`
      : `<span class="avatar">${esc((u.name || u.email || '?').trim().charAt(0).toUpperCase())}</span>`;
    el.querySelector('summary').title = `Signed in as ${u.name || u.email}`;
    el.querySelector('summary').setAttribute('aria-label', el.querySelector('summary').title);
    el.querySelector('.who').innerHTML = `<strong>${esc(u.name)}</strong><span class="muted small">${esc(u.email)}</span>`;
  } catch (e) {
    if (e.signIn) location.replace(loginUrl()); // every page with a topbar needs a signed-in user
  }
}
document.addEventListener('click', (e) => { if (e.target.closest('#sign-out')) signOut(); });

const pretty = (n) => n.replace('#', '♯').replace(/b(\d|$)/, '♭$1');

/** Compact read-out of the selected note, shown in the player bar. */
export function renderNow(el, item, { chord } = {}) {
  if (!item) {
    el.innerHTML = '<span class="empty-now">Tap a note to see its fingering</span>';
    return;
  }
  const len = beatsLabel(item.beats);
  const beatWord = item.beats === 1 ? 'beat' : 'beats';
  let html = '';
  if (item.type === 'note') {
    const breath = item.register === 3 ? 'blow much harder' : item.register === 2 ? 'blow harder' : '';
    const extras = [
      item.halfHole ? 'half-cover the hole' : '',
      item.cross ? 'cross fingering' : '',
      item.octaveShift ? `played ${item.octaveShift > 0 ? 'an octave up' : 'an octave down'}` : '',
      item.tie ? 'tied: keep holding' : '',
    ].filter(Boolean);
    html = `<span class="mini-holes">${holesSVG(item.holes, { r: 3.3, gap: 6.4, groupGap: 3, pad: 1, label: 'Fingering for ' + item.pitch })}</span>`
      + `<span class="n-name">${pretty(item.name)}</span>`
      + `<span class="fingers" title="Holes to hold down">${fingerNumbers(item.holes, item.register)}</span>`
      + `<span class="n-sub">${[`${len} ${beatWord}`, breath, ...extras].filter(Boolean).join(' · ')}</span>`;
  } else if (item.type === 'rest') {
    html = `<span class="n-name">Rest</span><span class="n-sub">${len} ${beatWord}</span>`;
  } else {
    html = `<span class="n-name">Hold</span><span class="n-sub">keep the note going, ${len} ${beatWord}</span>`;
  }
  if (chord) html += `<span class="n-chord" title="Guitar chord">${esc(chord)}</span>`;
  el.innerHTML = html;
}

export function renderChordList(el, names) {
  el.innerHTML = names.length
    ? names.map((n) => `<figure>${chordDiagramSVG(n)}</figure>`).join('')
    : '<p class="muted">No chords.</p>';
}

/** "Tab: Numbers | Hole diagrams" switch. onChange re-renders the tab. */
export function tabStyleControl(el, onChange) {
  el.innerHTML = `<label for="tab-style">Tab</label> <select id="tab-style"><option value="numbers">Numbers</option><option value="holes">Hole diagrams</option></select>
    <label class="small check"><input type="checkbox" id="note-names"> Note names</label>`;
  const sel = el.querySelector('select');
  sel.value = getTabStyle();
  sel.addEventListener('change', () => { setTabStyle(sel.value); onChange(); });
  const names = el.querySelector('#note-names');
  names.checked = getShowNoteNames();
  names.addEventListener('change', () => { setShowNoteNames(names.checked); onChange(); });
}

// ---- light / dark theme (light by default; the choice is remembered)
const THEME_KEY = 'pw-theme';
const isDark = () => document.documentElement.dataset.theme === 'dark';
function themeButton() {
  const dark = isDark();
  return `<button class="btn theme-toggle" id="theme-toggle" type="button" aria-pressed="${dark}" title="Switch to ${dark ? 'light' : 'dark'} mode" aria-label="Dark mode">${dark ? '☀' : '☾'}</button>`;
}
// ---- player bar: collapses to an icon at the top left (remembered)
const PLAYER_KEY = 'pw-player-collapsed';
function setPlayerCollapsed(player, collapsed) {
  player.classList.toggle('collapsed', collapsed);
  player.classList.remove('show-settings');
  document.body.classList.toggle('player-collapsed', collapsed);
  const btn = player.querySelector('.player-toggle');
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.setAttribute('aria-label', collapsed ? 'Show player' : 'Hide player');
  btn.title = collapsed ? 'Show player' : 'Hide player';
  try { localStorage.setItem(PLAYER_KEY, collapsed ? '1' : '0'); } catch { /* storage blocked */ }
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.player-toggle');
  if (btn) { const p = btn.closest('.player'); setPlayerCollapsed(p, !p.classList.contains('collapsed')); }
});
{
  const player = document.querySelector('.player');
  let collapsed = false;
  try { collapsed = localStorage.getItem(PLAYER_KEY) === '1'; } catch { /* storage blocked */ }
  if (player) setPlayerCollapsed(player, collapsed);
}

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
    <nav><a class="btn nav-library ${active === 'library' ? 'primary' : ''}" href="./">Library</a><a class="btn ${active === 'new' ? 'primary' : ''}" href="editor.html"><span class="brand-long">+ New tab</span><span class="brand-short">+ New</span></a>${themeButton()}<details class="more account" id="account" hidden>
      <summary class="btn" aria-label="Account"></summary>
      <div class="menu"><div class="who"></div><button class="btn" id="sign-out" type="button">Sign out</button></div>
    </details></nav>
  </header>`;
}
// topbar() is called synchronously by each page right after import, so the slot exists by the next tick.
setTimeout(showUser);

export function originalSources(tune) {
  return (tune.originals || []).map((o) => ({ url: apiUrl(`tunes/${tune.id}/files/${o.file}`), type: o.type, name: o.originalName }));
}
