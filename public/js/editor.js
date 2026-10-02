import { analyzeTune, buildDisplayAbc, bestTranspose, whistleStats, cleanAbc, tabDocument, transposedKeyName } from './core.js';
import { TabView, Player, whistleNote, defaultBpm } from './render.js';
import { renderPages, pagesToImages, showPages, ACCEPTED } from './originals.js';
import { $, api, apiUrl, esc, topbar, renderNow, originalSources, tabStyleControl } from './ui.js';

$('#top').innerHTML = topbar('new');

const EXAMPLES = [
  `X:1
T:Ode to Joy
C:L. van Beethoven
M:4/4
L:1/4
Q:1/4=100
K:C
EEFG|GFED|CCDE|E3/2D/2 D2|
EEFG|GFED|CCDE|D3/2C/2 C2|
DDEC|DE/F/ EC|DE/F/ ED|CDG,2|
EEFG|GFED|CCDE|D3/2C/2 C2|]
`,
  `X:1
T:The Kesh
R:jig
M:6/8
L:1/8
K:G
|:"G"GAG GAB|"D"ABA ABd|"G"edd gdd|"C"edB "D"dBA|
"G"GAG GAB|"D"ABA ABd|"G"edd gdB|"D"AGF "G"G3:|
|:"G"BAB dBd|"C"ege "G"dBA|"G"BAB dBG|"D"ABA AGA|
"G"BAB dBd|"C"ege "G"dBd|"C"gfg "D"aga|"G"bgf g3:|
`,
];

const params = new URLSearchParams(location.search);
const editId = params.get('id');
let existing = null;
let files = []; // newly chosen File objects (replace originals on save)
let pages = []; // rendered canvases of the current original music
let lastDisplay = '';
let lastGenerated = false;
let srcData = null;
let transcription = null;
let showOriginal = false;

const view = new TabView($('#preview'), {
  onSelect: (item, i, ctx) => {
    renderNow($('#now'), item, ctx);
    if (ctx.source !== 'play' && item.type === 'note') whistleNote(item.midi, undefined, Math.min(0.7, 0.3 + item.beats * 0.12));
  },
});
const player = new Player(view, { onStop: () => { $('#play').textContent = '▶ Play'; } });
renderNow($('#now'), null);
tabStyleControl($('#style'), () => { if (lastDisplay) view.render(lastDisplay); });

// ------------------------------------------------------------ settings

function settings() {
  return { transpose: Number($('#transpose').value) || 0, chordMode: $('#chords').value };
}

function fillTranspose(keySig) {
  const sel = $('#transpose');
  const cur = sel.value || '0';
  sel.innerHTML = '';
  for (let n = -12; n <= 12; n++) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = keySig ? `${transposedKeyName(keySig, n)} (${n === 0 ? 'as written' : (n > 0 ? '+' : '') + n})` : (n === 0 ? 'as written' : String(n));
    sel.appendChild(o);
  }
  sel.value = cur;
}
fillTranspose(null);

// ------------------------------------------------------------ preview

let timer = null;
const schedule = () => { clearTimeout(timer); timer = setTimeout(update, 350); };

function update() {
  const src = $('#abc').value;
  $('#abc-error').textContent = '';
  if (!/^K:/m.test(src)) {
    $('#preview').innerHTML = '<div class="tabview"><p class="muted" style="padding:20px">The tab will appear here once the music has been read (or you enter ABC notation below).</p></div>';
    $('#stats').innerHTML = '';
    $('#save').disabled = true;
    srcData = null;
    return;
  }
  try {
    const tune = ABCJS.parseOnly(src)[0];
    srcData = analyzeTune(tune).data;
    const keySig = srcData.keySignature;
    if ($('#transpose').dataset.key !== JSON.stringify(keySig)) { fillTranspose(keySig); $('#transpose').dataset.key = JSON.stringify(keySig); }
    if (!$('#title').value && srcData.title && srcData.title !== 'Untitled') $('#title').value = srcData.title;

    const built = buildDisplayAbc(src, settings());
    lastDisplay = built.abc;
    lastGenerated = built.generated;
    const r = view.render(lastDisplay);
    if (!r) throw new Error('No music found in the notation.');
    drawStats();
    if (tune.warnings && tune.warnings.length) $('#abc-error').innerHTML = tune.warnings.slice(0, 5).map((w) => esc(String(w).replace(/<[^>]+>/g, ''))).join('<br>');
    $('#save').disabled = false;
    if (!$('#tempo').dataset.touched) {
      $('#tempo').value = defaultBpm(view.visual);
      $('#tempo-v').textContent = $('#tempo').value;
    }
  } catch (e) {
    $('#abc-error').textContent = 'Could not read the notation: ' + e.message;
    $('#save').disabled = true;
  }
}

function drawStats() {
  const s = whistleStats(srcData, settings().transpose);
  const chips = [
    `<span class="stat">${s.notes} notes · ${srcData.measures.length} bars</span>`,
    s.outOfRange ? `<span class="stat warn">${s.outOfRange} out of whistle range</span>` : '<span class="stat good">All notes in range</span>',
    s.halfHoles ? `<span class="stat warn">${s.halfHoles} half-hole notes</span>` : '<span class="stat good">No half-holing</span>',
    s.cross ? `<span class="stat">${s.cross} C-natural (cross fingering)</span>` : '',
    s.hard ? `<span class="stat warn">${s.hard} very high notes</span>` : '',
    `<span class="stat">${lastGenerated ? 'Chords suggested by the app' : 'Chords from the score'}</span>`,
  ];
  $('#stats').innerHTML = chips.join('');
  const best = bestTranspose(srcData);
  const cur = settings().transpose;
  const curPenalty = s.outOfRange * 10 + s.halfHoles * 1.5;
  const box = $('#suggest');
  if (best.shift !== cur && curPenalty - best.penalty >= 3) {
    box.hidden = false;
    box.innerHTML = `This tune is easier on a D whistle in <b>${esc(transposedKeyName(srcData.keySignature, best.shift))}</b> (${best.stats.outOfRange} out of range, ${best.stats.halfHoles} half-holes). <button class="btn" id="apply-best" type="button">Use ${esc(transposedKeyName(srcData.keySignature, best.shift))}</button>`;
    $('#apply-best').onclick = () => { $('#transpose').value = best.shift; update(); };
  } else box.hidden = true;
}

$('#abc').addEventListener('input', schedule);
$('#transpose').addEventListener('change', update);
$('#chords').addEventListener('change', update);
$('#bestfit').addEventListener('click', () => {
  if (!srcData) return;
  $('#transpose').value = bestTranspose(srcData).shift;
  update();
});
$('#title').addEventListener('change', () => {
  const t = $('#title').value.trim();
  const abc = $('#abc').value;
  if (!t) return;
  $('#abc').value = /^T:.*$/m.test(abc) ? abc.replace(/^T:.*$/m, 'T:' + t) : abc.replace(/^(X:.*\n)/m, `$1T:${t}\n`);
  update();
});
// Re-lay out only when the width changes (phones fire resize as the address bar slides).
let resizeTimer;
let lastWidth = $('#preview').clientWidth;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const w = $('#preview').clientWidth;
    if (w !== lastWidth && lastDisplay) { lastWidth = w; view.render(lastDisplay); }
  }, 250);
});

// playback
$('#tempo').addEventListener('input', () => { $('#tempo').dataset.touched = '1'; $('#tempo-v').textContent = $('#tempo').value; });
$('#play').addEventListener('click', () => {
  if (player.playing) { player.stop(); return; }
  player.play(Number($('#tempo').value), view.selected);
  $('#play').textContent = '■ Stop';
});
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  if (e.key === 'ArrowRight') { view.step(1); e.preventDefault(); }
  if (e.key === 'ArrowLeft') { view.step(-1); e.preventDefault(); }
});

// ------------------------------------------------------------ original music

function setOriginalVisible(v) {
  showOriginal = v;
  const has = pages.length > 0;
  $('#toggle-original').hidden = !has;
  $('#toggle-original').setAttribute('aria-pressed', String(v));
  $('#toggle-original').textContent = v ? 'Hide original' : 'Show original';
  $('#original').hidden = !(v && has);
  $('#split').classList.toggle('with-original', v && has);
  if (lastDisplay) view.render(lastDisplay);
}
$('#toggle-original').addEventListener('click', () => setOriginalVisible(!showOriginal));

async function loadPages(sources) {
  $('#status').innerHTML = '<span class="spinner"></span> Loading pages…';
  try {
    pages = await renderPages(sources);
    showPages($('#original'), pages);
    // thumbnails share the same canvases' images
    $('#thumbs').innerHTML = pages.map((p) => `<figure class="page"><img alt="${esc(p.label)}" src="${p.canvas.toDataURL('image/jpeg', 0.6)}"><figcaption>${esc(p.label)}</figcaption></figure>`).join('');
    $('#status').textContent = `${pages.length} page${pages.length === 1 ? '' : 's'} ready.`;
    $('#read').disabled = !pages.length || !window.__canTranscribe;
    setOriginalVisible(false);
  } catch (e) {
    $('#status').innerHTML = `<span class="error">Could not open that file: ${esc(e.message)}</span>`;
  }
}

function chooseFiles(list) {
  const chosen = [...list];
  const bad = chosen.filter((f) => !ACCEPTED.includes(f.type));
  files = chosen.filter((f) => ACCEPTED.includes(f.type));
  if (bad.length) $('#status').innerHTML = `<span class="error">Skipped unsupported file(s): ${bad.map((f) => esc(f.name)).join(', ')}. Use PDF, PNG, JPG or WebP.</span>`;
  if (files.length) loadPages(files);
}
const drop = $('#drop');
drop.addEventListener('click', () => $('#file').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } });
$('#file').addEventListener('change', (e) => chooseFiles(e.target.files));
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); chooseFiles(e.dataTransfer.files); });

$('#example').addEventListener('click', () => {
  const ex = EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)];
  $('#abc').value = ex;
  $('#title').value = '';
  $('#transpose').value = '0';
  $('#step-review details').open = true;
  update();
  $('#step-review').scrollIntoView({ behavior: 'smooth' });
});

// ------------------------------------------------------------ transcription

$('#read').addEventListener('click', async () => {
  if (!pages.length) return;
  const btn = $('#read');
  btn.disabled = true;
  const started = Date.now();
  let statusText = 'Sending pages to Claude…';
  const tick = () => { $('#status').innerHTML = `<span class="spinner"></span> ${esc(statusText)} <span class="muted">${Math.round((Date.now() - started) / 1000)}s</span>`; };
  tick();
  const clock = setInterval(tick, 1000);
  let text = '';
  try {
    const res = await fetch(apiUrl('transcribe'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages: pagesToImages(pages), hint: $('#hint').value }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let done = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'status') statusText = ev.text;
        if (ev.type === 'delta') { text += ev.text; $('#abc').value = text; $('#step-review details').open = true; }
        if (ev.type === 'error') throw new Error(ev.message);
        if (ev.type === 'done') done = ev;
      }
    }
    if (!done) throw new Error('The connection closed before the transcription finished.');
    $('#abc').value = cleanAbc(done.abc);
    transcription = { model: done.model, at: new Date().toISOString() };
    $('#title').value = '';
    $('#transpose').value = '0';
    update();
    const secs = Math.round((Date.now() - started) / 1000);
    $('#status').innerHTML = `Done in ${secs}s.${done.truncated ? ' <span class="error">The output was cut short; check the last bars.</span>' : ''} Compare the tab with the original, fix anything in the notation box, then approve.`;
    $('#step-review').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    $('#status').innerHTML = `<span class="error">${esc(e.message)}</span>`;
  } finally {
    clearInterval(clock);
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ save

$('#save').addEventListener('click', async () => {
  if (!srcData || !view.data) return;
  const btn = $('#save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const body = {
      title: $('#title').value.trim() || srcData.title,
      composer: srcData.composer,
      abc: $('#abc').value,
      displayAbc: lastDisplay,
      settings: settings(),
      tab: tabDocument(view.data, { generatedChords: lastGenerated }),
      transcription,
    };
    // multipart: JSON metadata plus the original files
    const form = new FormData();
    form.append('meta', JSON.stringify(body));
    for (const f of files) form.append('originals[]', f, f.name);
    const rec = await api(existing ? `tunes/${existing.id}` : 'tunes', { method: 'POST', body: form });
    location.href = `tune.html?id=${encodeURIComponent(rec.id)}`;
  } catch (e) {
    alert('Could not save: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Approve & save';
  }
});

// ------------------------------------------------------------ init

(async () => {
  try {
    const cfg = await api('config');
    window.__canTranscribe = cfg.transcribe;
    if (!cfg.transcribe) {
      $('#read').title = 'Set ANTHROPIC_API_KEY on the server to enable reading music';
      $('#status').innerHTML = '<span class="muted">Reading music with Claude is not configured on this server (ANTHROPIC_API_KEY). You can still enter ABC notation by hand.</span>';
    }
  } catch { window.__canTranscribe = false; }

  if (editId) {
    try {
      existing = await api(`tunes/${editId}`);
      document.title = `Edit ${existing.title}`;
      $('#heading').textContent = `Edit “${existing.title}”`;
      $('#cancel').href = `tune.html?id=${encodeURIComponent(existing.id)}`;
      $('#abc').value = existing.abc;
      $('#title').value = existing.title;
      $('#chords').value = existing.settings?.chordMode || 'auto';
      transcription = existing.transcription || null;
      update();
      $('#transpose').value = existing.settings?.transpose || 0;
      update();
      if (existing.originals?.length) await loadPages(originalSources(existing));
    } catch (e) {
      $('#status').innerHTML = `<span class="error">Could not load that tune: ${esc(e.message)}</span>`;
    }
  } else update();
})();
