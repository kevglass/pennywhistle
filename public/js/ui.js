import { holesSVG, beatsLabel, getTabStyle, setTabStyle, getShowNoteNames, setShowNoteNames, INSTRUMENTS, getInstrument, setInstrument } from './render.js';
import { fingerNumbers, markFor } from './core.js';
import { chordDiagramSVG, CHORD_INSTRUMENTS, getChordInstrument, setChordInstrument } from './guitar.js';

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

/** Error for a failed API response; signIn is set when the user needs to sign in (again), data is the response body. */
export function apiError(res, data = {}) {
  const e = new Error(data.error || `Request failed (${res.status})`);
  e.signIn = res.status === 401 && !!data.login;
  e.data = data;
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

/** App pages start hidden (class auth-pending, set in their head) until the user is known to be signed in. */
const reveal = () => document.documentElement.classList.remove('auth-pending');

// Fill the topbar's account menu once the signed-in user is known (redirects to sign-in if not).
async function showUser() {
  const el = document.getElementById('account');
  if (!el) return reveal();
  try {
    const u = await api('auth/me');
    reveal();
    el.hidden = false;
    el.querySelector('summary').innerHTML = u.picture
      ? `<img class="avatar" src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer" width="22" height="22">`
      : `<span class="avatar">${esc((u.name || u.email || '?').trim().charAt(0).toUpperCase())}</span>`;
    el.querySelector('summary').title = `Signed in as ${u.name || u.email}`;
    el.querySelector('summary').setAttribute('aria-label', el.querySelector('summary').title);
    el.querySelector('.who').innerHTML = `<strong>${esc(u.name)}</strong><span class="muted small">${esc(u.email)}</span>`;
    if (u.friendRequests) {
      const n = u.friendRequests;
      el.querySelector('summary').insertAdjacentHTML('beforeend', `<span class="dot" aria-hidden="true"></span>`);
      el.querySelector('summary').title += ` (${n} friend request${n === 1 ? '' : 's'})`;
      el.querySelector('#friends-link').insertAdjacentHTML('beforeend', ` <span class="badge accent">${n}</span>`);
    }
    if (u.admin) el.querySelector('#friends-link').insertAdjacentHTML('afterend', '<a class="btn" href="users.html">Users</a>');
  } catch (e) {
    if (e.signIn) location.replace(loginUrl()); // every page with a topbar needs a signed-in user; it stays hidden
    else reveal(); // the server couldn't be reached: show the page, whose own requests will say so
  }
}
document.addEventListener('click', (e) => { if (e.target.closest('#sign-out')) signOut(); });

const pretty = (n) => n.replace('#', '♯').replace(/b(\d|$)/, '♭$1');

/** Compact read-out of the selected note, shown in the player bar. */
/** Load a classic script (a vendor library) once; rel is relative to this folder. */
const loaded = {};
export function loadScript(rel) {
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
  if (chord) html += `<span class="n-chord" title="Chord">${esc(chord)}</span>`;
  el.innerHTML = html;
}

/** Diagrams of the chords on the chosen chord instrument. */
export function renderChordList(el, names) {
  const inst = getChordInstrument();
  el.innerHTML = names.length
    ? names.map((n) => `<figure>${chordDiagramSVG(n, inst)}</figure>`).join('')
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

/** The instrument that plays the chords, picked beside the Chords box and shown while it is ticked; the choice is remembered. */
export function chordInstrumentControl(box, sel, onChange) {
  sel.innerHTML = Object.entries(CHORD_INSTRUMENTS).map(([id, i]) => `<option value="${id}">${esc(i.label)}</option>`).join('');
  sel.value = getChordInstrument();
  const show = () => { sel.hidden = !box.checked; };
  show();
  box.addEventListener('change', show);
  sel.addEventListener('change', () => { setChordInstrument(sel.value); onChange(); });
}

/** The player's instrument picker (the penny whistle first); the choice is remembered. */
export function instrumentControl(sel, onChange) {
  sel.innerHTML = INSTRUMENTS.map(([group, list]) => {
    const options = list.map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('');
    return group ? `<optgroup label="${esc(group)}">${options}</optgroup>` : options;
  }).join('');
  sel.value = getInstrument();
  sel.addEventListener('change', () => { setInstrument(sel.value); onChange(); });
}

// ---- light / dark theme (light by default; the choice is remembered)
const THEME_KEY = 'pw-theme';
const isDark = () => document.documentElement.dataset.theme === 'dark';
function themeButton() {
  const dark = isDark();
  return `<button class="btn" id="theme-toggle" type="button">${dark ? '☀ Light mode' : '☾ Dark mode'}</button>`;
}
// ---- player bar: shown under the top bar, hidden and shown with the ♪ button in the top bar (remembered)
const PLAYER_KEY = 'pw-player-collapsed';
const playerCollapsed = () => document.body.classList.contains('player-collapsed');
function setPlayerCollapsed(collapsed) {
  const player = document.querySelector('.player');
  player?.classList.toggle('collapsed', collapsed);
  player?.classList.remove('show-settings');
  document.body.classList.toggle('player-collapsed', collapsed);
  const btn = document.querySelector('.player-toggle');
  if (btn) {
    btn.setAttribute('aria-pressed', String(!collapsed));
    btn.title = collapsed ? 'Show player' : 'Hide player';
    btn.setAttribute('aria-label', btn.title);
  }
  try { localStorage.setItem(PLAYER_KEY, collapsed ? '1' : '0'); } catch { /* storage blocked */ }
}
function playerToggle() {
  const collapsed = playerCollapsed(), label = collapsed ? 'Show player' : 'Hide player';
  return `<button class="btn player-toggle" type="button" aria-pressed="${!collapsed}" aria-label="${label}" title="${label}">♪ Player</button>`;
}
document.addEventListener('click', (e) => {
  if (e.target.closest('.player-toggle')) setPlayerCollapsed(!playerCollapsed());
});
if (document.querySelector('.player')) {
  let collapsed = false;
  try { collapsed = localStorage.getItem(PLAYER_KEY) === '1'; } catch { /* storage blocked */ }
  setPlayerCollapsed(collapsed);
}

// ---- mute: play silently, the notes still highlight and the page scrolls in time (remembered)
const MUTE_KEY = 'pw-muted';
const SPEAKER = '<path d="M4 9h3l5-4v14l-5-4H4z" fill="currentColor"/>';
const muteIcon = (muted) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none">${SPEAKER}${
  muted ? '<path d="M16 9l5 6M21 9l-5 6"/>' : '<path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'}</svg>`;
export const isMuted = () => document.querySelector('.mute-toggle')?.getAttribute('aria-pressed') === 'true';
function setMuted(btn, muted) {
  btn.setAttribute('aria-pressed', String(muted));
  btn.title = muted ? 'Muted: notes highlight without sound' : 'Mute (follow along without sound)';
  btn.innerHTML = muteIcon(muted);
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.mute-toggle');
  if (!btn) return;
  const muted = btn.getAttribute('aria-pressed') !== 'true';
  setMuted(btn, muted);
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* storage blocked */ }
  document.dispatchEvent(new Event('pw-mute'));
});
{
  const btn = document.querySelector('.mute-toggle');
  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* storage blocked */ }
  if (btn) setMuted(btn, muted);
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
    <nav>${playerToggle()}<a class="btn nav-library ${active === 'library' ? 'primary' : ''}" href="./">Library</a><details class="more account" id="account" hidden>
      <summary class="btn" aria-label="Account"></summary>
      <div class="menu"><div class="who"></div><a class="btn" id="friends-link" href="friends.html">Friends</a>${themeButton()}<button class="btn" id="sign-out" type="button">Sign out</button></div>
    </details></nav>
  </header>`;
}
// topbar() is called synchronously by each page right after import, so the slot exists by the next tick.
setTimeout(showUser);

// The header (top bar, plus the player on tune pages) sticks to the top; publish its height so
// sticky panes and scrolling into view keep clear of it.
{
  const head = document.getElementById('top');
  if (head) new ResizeObserver(() => document.documentElement.style.setProperty('--head-h', `${head.offsetHeight}px`)).observe(head);
}

/** API route of a tune: your own, or a friend's (read-only, tune.owner is set). */
export const tuneRoute = (id, owner) => (owner ? `friends/${owner}/tunes/${id}` : `tunes/${id}`);

/** Link to a tune's page; owner is the friend's account id for a friend's tune. */
export const tuneHref = (id, owner) => `tune.html?id=${encodeURIComponent(id)}${owner ? `&owner=${encodeURIComponent(owner)}` : ''}`;

export function originalSources(tune) {
  const base = tuneRoute(tune.id, tune.owner?.sub);
  return (tune.originals || []).map((o) => ({ url: apiUrl(`${base}/files/${o.file}`), type: o.type, name: o.originalName }));
}

// ------------------------------------------------------------ license check

/** What each license status means for using the tune in a game or video. */
export const LICENSE_STATUS = {
  free: { label: 'Free to use', title: 'Public domain or free license: can be used in games and videos' },
  attribution: { label: 'Free with credit', title: 'Can be used in games and videos if the conditions (e.g. a credit) are met' },
  restricted: { label: 'Copyrighted', title: 'Needs permission or a paid license to use in a game or video' },
  unknown: { label: 'Unclear', title: 'The license could not be established' },
};

export const COPYRIGHT_STATE = {
  active: 'Still under copyright',
  expired: 'Copyright has expired',
  traditional: 'Traditional: no known author, never under copyright',
  unknown: 'Not known',
};

/** A badge for a tune's license status (the summary on hover); a button that opens the details when clickable. */
export function licenseBadge(license, { button = false } = {}) {
  const s = LICENSE_STATUS[license?.status] || LICENSE_STATUS.unknown;
  const tip = [license?.license, license?.summary || s.title].filter(Boolean).join(': ');
  const cls = `badge lic lic-${esc(license?.status || 'unknown')}`;
  return button
    ? `<button type="button" class="${cls} show-license" title="${esc(tip)} (click for details)">${s.label}</button>`
    : `<span class="${cls}" title="${esc(tip)}">${s.label}</span>`;
}

/** Everything a license check found: who owns the copyright, when it runs out, and the sources. */
export function licenseDetailsHTML(lic) {
  const row = (k, v) => (v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : '');
  let expiry = lic.copyrightExpires;
  if (expiry && /^\d{4}$/.test(expiry)) expiry = `${lic.copyright === 'active' ? 'Runs until the end of' : 'Expired at the end of'} ${expiry}`;
  const sources = (lic.sources || []).map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a>${x.supports ? `<div class="muted">${esc(x.supports)}</div>` : ''}</li>`).join('');
  return `<p>${esc(lic.summary)}</p>
    <h3>Use in games and videos</h3>
    <dl>${row('Can I use it?', LICENSE_STATUS[lic.status]?.title)}${row('License', lic.license)}${row('Conditions', lic.conditions)}</dl>
    <h3>Copyright</h3>
    <dl>${row('Copyright', COPYRIGHT_STATE[lic.copyright])}${row('Written by', lic.composer)}${row('Written', lic.written)}${row('Composer died', lic.composerDied)}${row('Owned by', lic.rightsHolder)}${row('Copyright term', expiry)}${row('How we know', lic.copyrightBasis)}${row('Confidence', lic.confidence)}</dl>
    ${lic.copyright ? '' : '<p class="muted small">This check was made before copyright dates were recorded. Check again to add them.</p>'}
    ${lic.notes ? `<h3>Notes</h3><p class="small">${esc(lic.notes)}</p>` : ''}
    ${sources ? `<h3>Where this came from</h3><ul class="small lic-sources">${sources}</ul>` : ''}
    <p class="muted small">Checked ${new Date(lic.checkedAt).toLocaleDateString()}${lic.checkedBy ? ` for ${esc(lic.checkedBy)}` : ''} by Claude searching the web${lic.model ? ` (${esc(lic.model)})` : ''}. This is research, not legal advice: confirm with the rights holder before publishing anything commercial. It covers the tune itself; a recording or published arrangement can have its own copyright.</p>`;
}

/**
 * A pop-up with a tune's license details. onCheck (optional) adds a Check again button;
 * it gets the dialog so it can show progress and the new result in it.
 */
export function showLicenseDialog(title, lic, { onCheck } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = 'license-dialog license-card';
  const fill = (l, extra = '') => {
    dlg.innerHTML = `<div class="lic-head"><h2>${esc(title)} ${licenseBadge(l)}</h2><button class="btn" type="button" data-close aria-label="Close">✕</button></div>
      ${extra}${licenseDetailsHTML(l)}
      ${onCheck ? '<div class="row"><button class="btn" type="button" data-check>Check again</button></div>' : ''}`;
  };
  fill(lic);
  dlg.addEventListener('click', async (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    if (e.target.closest('[data-check]')) {
      e.target.closest('[data-check]').outerHTML = '<p class="lic-checking muted"><span class="spinner" aria-hidden="true"></span>Searching the web… (10–30 seconds)</p>';
      try { fill(await onCheck()); } catch (err) { fill(lic, `<p>${errorHTML(err, 'Could not check the license', { newTab: true })}</p>`); }
    }
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

/**
 * Find a tune's license and save it with the tune; owner is set for a friend's tune. Reuses the answer
 * if anyone has already checked the same piece; otherwise, or with again, Claude searches the web (10–30 s).
 */
export const checkLicense = (id, owner, { again = false } = {}) =>
  api(`${tuneRoute(id, owner)}/license`, { method: 'POST', body: JSON.stringify({ again }) });
