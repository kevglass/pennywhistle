import { analyzeTune, buildDisplayAbc, bestTranspose, whistleStats, cleanAbc, tabDocument, transposedKeyName } from './core.js';
import { TabView, Player, tone, defaultBpm } from './render.js';
import { renderPages, pagesToImages, showPages, ACCEPTED } from './originals.js';
import { $, api, apiUrl, apiError, errorHTML, esc, topbar, renderNow, originalSources, tabStyleControl, instrumentControl, chordInstrumentControl, isMuted, messageDialog } from './ui.js';

$('#top').insertAdjacentHTML('afterbegin', topbar());

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
let pages = []; // rendered canvases of the current original music
let originalFiles = []; // the files those pages came from (File, or {url, type} for a saved tune)
let lastDisplay = '';
let lastGenerated = false;
let srcData = null;
let transcription = null;
let showOriginal = false;

const view = new TabView($('#preview'), {
  onSelect: (item, i, ctx) => {
    renderNow($('#now'), item, ctx);
    if (ctx.source !== 'play' && item.type === 'note') tone(item.midi, undefined, Math.min(0.7, 0.3 + item.beats * 0.12));
  },
});
const player = new Player(view, { onStop: () => { $('#play').textContent = '▶ Play'; } });
renderNow($('#now'), null);
tabStyleControl($('#style'), () => { if (lastDisplay) view.render(lastDisplay); });

// ------------------------------------------------------------ steps
// Three blocks (upload, convert, tab). Only one is open at a time; a block can
// be reopened once the flow has reached it.
const STEPS = ['#step-upload', '#step-convert', '#step-review'];
let reached = 1;

function openStep(n, { scroll = true } = {}) {
  reached = Math.max(reached, n);
  STEPS.forEach((sel, i) => {
    const el = $(sel);
    const num = i + 1;
    const open = num === n;
    el.classList.toggle('open', open);
    el.classList.toggle('done', num < reached && !open);
    el.querySelector('.step-head').disabled = num > reached;
    el.querySelector('.step-head').setAttribute('aria-expanded', String(open));
    el.querySelector('.step-body').hidden = !open;
  });
  // The player bar is fixed to the top of the page, so only show it with the tab.
  document.body.classList.toggle('has-player', n === 3);
  if (n === 3) update(); // lay the tab out now that it has a width
  if (scroll) $(STEPS[n - 1]).scrollIntoView({ behavior: 'smooth', block: 'start' });
}
STEPS.forEach((sel, i) => $(sel).querySelector('.step-head').addEventListener('click', () => openStep(i + 1)));

function summary(step, html) { $(`#sum-${step}`).innerHTML = html; }
openStep(1, { scroll: false });

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
    $('#preview').innerHTML = '<div class="tabview"><p class="muted" style="padding:20px">The tab will appear here once the music has been processed.</p></div>';
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
    $('#save').disabled = false;
    if (!$('#tempo').dataset.touched) {
      $('#tempo').value = defaultBpm(view.visual);
      $('#tempo-v').textContent = $('#tempo').value;
    }
  } catch (e) {
    $('#abc-error').textContent = 'Could not build the tab from this music: ' + e.message + '. Try processing it again.';
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
// The Play button starts from the top; changing a setting mid-tune carries on from the current note.
function startPlay(from = view.selected) {
  player.play(Number($('#tempo').value), from, { muted: isMuted(), chords: $('#guitar').checked });
  $('#play').textContent = '■ Stop';
}
$('#play').addEventListener('click', () => (player.playing ? player.stop() : startPlay(-1)));
document.addEventListener('pw-mute', () => { if (player.playing) startPlay(); }); // carry on from the current note
$('#guitar').addEventListener('change', () => { if (player.playing) startPlay(); });
instrumentControl($('#instrument'), () => { if (player.playing) startPlay(); });
chordInstrumentControl($('#guitar'), $('#chord-instrument'), () => { if (player.playing) startPlay(); });
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

async function loadPages(sources, label) {
  $('#upload-status').innerHTML = '<span class="spinner"></span> Loading pages…';
  try {
    pages = await renderPages(sources);
    originalFiles = sources;
    showPages($('#original'), pages);
    // thumbnails share the same canvases' images
    $('#thumbs').innerHTML = pages.map((p) => `<figure class="page"><img alt="${esc(p.label)}" src="${p.canvas.toDataURL('image/jpeg', 0.6)}"><figcaption>${esc(p.label)}</figcaption></figure>`).join('');
    $('#upload-status').textContent = `${pages.length} page${pages.length === 1 ? '' : 's'}. Choose another file to replace ${pages.length === 1 ? 'it' : 'them'}.`;
    $('#read').disabled = !pages.length || !(window.__canTranscribe || singlePdf());
    setOriginalVisible(false);
    if (label) {
      summary('upload', esc(label));
      summary('convert', '');
      $('#status').innerHTML = '';
      openStep(2);
    }
  } catch (e) {
    $('#upload-status').innerHTML = `<span class="error">Could not open that file: ${esc(e.message)}</span>`;
  }
}

function chooseFiles(list) {
  const chosen = [...list];
  const bad = chosen.filter((f) => !ACCEPTED.includes(f.type));
  if (bad.length) $('#upload-status').innerHTML = `<span class="error">Skipped unsupported file(s): ${bad.map((f) => esc(f.name)).join(', ')}. Use PDF, PNG, JPG or WebP.</span>`;
  // The pages are only needed while transcribing; they aren't saved with the tune.
  const accepted = chosen.filter((f) => ACCEPTED.includes(f.type));
  if (!accepted.length) return;
  const label = accepted[0].type === 'application/pdf' ? 'PDF uploaded'
    : accepted.length === 1 ? 'Image uploaded' : `${accepted.length} images uploaded`;
  loadPages(accepted, label);
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
  summary('convert', 'Example tune');
  openStep(3);
});

// ------------------------------------------------------------ transcription

// A single PDF is also sent as-is: if MuseScore made it, the server reads the notes straight
// from the PDF (no AI); otherwise Claude reads the page images.
const singlePdf = () => originalFiles.length === 1 && originalFiles[0].type === 'application/pdf';

async function pdfPayload() {
  if (!singlePdf()) return [];
  const src = originalFiles[0];
  const buf = new Uint8Array(src.url ? await (await fetch(src.url)).arrayBuffer() : await src.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return [{ name: src.name || 'music.pdf', data: btoa(bin) }];
}

$('#read').addEventListener('click', async () => {
  if (!pages.length) return;
  const btn = $('#read');
  btn.disabled = true;
  const started = Date.now();
  let statusText = 'Reading the music…';
  const tick = () => { $('#status').innerHTML = `<span class="spinner"></span> ${esc(statusText)} <span class="muted">${Math.round((Date.now() - started) / 1000)}s</span>`; };
  tick();
  const clock = setInterval(tick, 1000);
  try {
    const res = await fetch(apiUrl('transcribe'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages: pagesToImages(pages), pdfs: await pdfPayload(), sourceCount: originalFiles.length, hint: $('#hint').value }),
    });
    if (!res.ok) throw apiError(res, await res.json().catch(() => ({})));
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
        if (ev.type === 'error') throw new Error(ev.message);
        if (ev.type === 'done') done = ev;
      }
    }
    if (!done) throw new Error('The connection closed before the transcription finished.');
    $('#abc').value = cleanAbc(done.abc);
    transcription = { model: done.model, at: new Date().toISOString() };
    $('#title').value = '';
    $('#transpose').value = '0';
    const secs = Math.round((Date.now() - started) / 1000);
    $('#status').innerHTML = done.model === 'musescore-pdf'
      ? 'Read straight from the MuseScore PDF (no AI needed).'
        + (done.warnings?.length ? ` <span class="error">${esc(done.warnings.join(' '))}</span>` : '')
      : `Done in ${secs}s. Process it again to get a fresh reading.`;
    summary('convert', 'Music processed');
    $('#review-hint').innerHTML = (done.truncated ? '<span class="error">The output was cut short; check the last bars.</span> ' : '')
      + 'Compare the tab with the original, pick a key and chords, then approve.';
    openStep(3);
  } catch (e) {
    $('#status').innerHTML = errorHTML(e, '', { newTab: true });
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
  $('#save-status').innerHTML = '';
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
    const rec = await api(existing ? `tunes/${existing.id}` : 'tunes', { method: 'POST', body: JSON.stringify(body) });
    location.href = `tune.html?id=${encodeURIComponent(rec.id)}`;
  } catch (e) {
    // fetch() throws a TypeError when the request never got a response
    const msg = e instanceof TypeError
      ? `the request did not reach the server (${e.message}). Check your connection and try again.`
      : e.message;
    const dup = e.data?.duplicate; // the same piece is already in the library
    if (e.signIn) $('#save-status').innerHTML = errorHTML(e, '', { newTab: true });
    else if (dup) $('#save-status').innerHTML = `<span class="error">Not saved: ${esc(msg)}, and a piece is kept only once.</span> <a href="tune.html?id=${encodeURIComponent(dup.id)}" target="_blank" rel="noopener">Open “${esc(dup.title)}”</a>`;
    else messageDialog('Could not save', msg.charAt(0).toUpperCase() + msg.slice(1));
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
      $('#read').title = 'Only PDFs exported from MuseScore can be read without ANTHROPIC_API_KEY on the server';
      $('#status').innerHTML = '<span class="muted">Reading music with Claude is not configured on this server (ANTHROPIC_API_KEY). PDFs exported from MuseScore can still be read.</span>';
    }
  } catch { window.__canTranscribe = false; }

  const me = editId ? {} : await api('auth/me').catch(() => ({}));
  if (me.uploadsBlocked) {
    document.querySelectorAll('.step').forEach((el) => { el.hidden = true; });
    const requested = (at) => `<p class="muted" style="margin:0">You asked for upload access on ${new Date(at).toLocaleDateString()}. The site owner has been emailed and will review it.</p>`;
    $('#heading').parentElement.insertAdjacentHTML('afterend', `<section class="card stack" id="upload-access">
      <p style="margin:0">Adding new tunes is turned off for your account. You can still open, edit and delete the tunes you have.</p>
      ${me.uploadRequestedAt ? requested(me.uploadRequestedAt) : '<div><button class="btn primary" id="request-uploads" type="button">Request upload access</button></div>'}
    </section>`);
    $('#request-uploads')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const { requestedAt } = await api('auth/upload-request', { method: 'POST' });
        e.target.parentElement.outerHTML = requested(requestedAt);
      } catch (err) {
        e.target.disabled = false;
        messageDialog('Could not send the request', err.message);
      }
    });
    return;
  }

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
      summary('upload', existing.originals?.length ? 'Original pages' : 'No original pages kept');
      summary('convert', 'Saved notation');
      update();
      $('#transpose').value = existing.settings?.transpose || 0;
      openStep(3, { scroll: false });
      if (existing.originals?.length) await loadPages(originalSources(existing));
    } catch (e) {
      $('#status').innerHTML = errorHTML(e, 'Could not load that tune');
    }
  } else update();
})();
