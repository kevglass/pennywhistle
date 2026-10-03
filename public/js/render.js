// Renders the engraved score with a penny-whistle tab row under every line,
// links notes <-> fingerings for click highlighting, and plays the tune.
import { analyzeTune, fingerNumbers, markFor } from './core.js';
import { chordFrets, CHORD_INSTRUMENTS, getChordInstrument } from './guitar.js';

// vertical room reserved under each system for the tab row
const tabHeight = () => (getTabStyle() === 'holes' ? 103 : 45) + (getShowNoteNames() ? 15 : 0);

const FRACTIONS = { 0.25: '¼', 0.333: '⅓', 0.5: '½', 0.667: '⅔', 0.75: '¾', 0.125: '⅛', 0.167: '⅙' };
export function beatsLabel(b) {
  const r = Math.round(b * 1000) / 1000;
  const whole = Math.floor(r + 1e-6);
  const frac = Math.round((r - whole) * 1000) / 1000;
  if (!frac) return String(whole);
  const f = FRACTIONS[frac] || frac.toFixed(2).replace(/^0/, '');
  return (whole ? whole : '') + f;
}

/** Vertical whistle diagram: six holes, top hole first. */
export function holesSVG(holes, { r = 4.6, gap = 10.6, pad = 1.5, groupGap = 5, label = '' } = {}) {
  const w = r * 2 + pad * 2;
  const h = gap * 5 + r * 2 + pad * 2 + groupGap;
  let s = `<svg class="holes" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-label="${label || 'Fingering ' + holes}" role="img">`;
  [...holes].forEach((c, i) => {
    const cy = pad + r + i * gap + (i >= 3 ? groupGap : 0);
    const cx = w / 2;
    if (c === 'X') s += `<circle cx="${cx}" cy="${cy}" r="${r}" class="h-closed"/>`;
    else if (c === 'H') {
      s += `<circle cx="${cx}" cy="${cy}" r="${r}" class="h-open"/>`;
      s += `<path d="M ${cx} ${cy - r} A ${r} ${r} 0 0 0 ${cx} ${cy + r} Z" class="h-half"/>`;
    } else s += `<circle cx="${cx}" cy="${cy}" r="${r}" class="h-open"/>`;
  });
  return s + '</svg>';
}

/** The number-tab token for a note ("3", "0/2", "4½", "3'"). */
export function countHTML(holes, register = 1) {
  const t = fingerNumbers(holes);
  const mark = markFor(holes, register) ? `<span class="oct">${markFor(holes, register)}</span>` : '';
  const m = t.match(/^0\/(.+)$/);
  return m ? `<span class="count open-top" aria-hidden="true"><small>0/</small><span>${m[1]}${mark}</span></span>` : `<span class="count" aria-hidden="true">${t}${mark}</span>`;
}

const TAB_STYLE_KEY = 'pw-tab-style';
export function getTabStyle() { try { return localStorage.getItem(TAB_STYLE_KEY) || 'numbers'; } catch { return 'numbers'; } }
export function setTabStyle(v) { try { localStorage.setItem(TAB_STYLE_KEY, v); } catch { /* storage blocked */ } }
// optional note names above the fingerings (off by default)
const NOTE_NAMES_KEY = 'pw-note-names';
export function getShowNoteNames() { try { return localStorage.getItem(NOTE_NAMES_KEY) === '1'; } catch { return false; } }
export function setShowNoteNames(on) { try { localStorage.setItem(NOTE_NAMES_KEY, on ? '1' : '0'); } catch { /* storage blocked */ } }

const registerMark = (it) => markFor(it.holes, it.register);

export class TabView {
  constructor(container, { onSelect } = {}) {
    this.container = container;
    this.onSelect = onSelect || (() => {});
    this.selected = -1;
    this.items = [];
  }

  render(displayAbc) {
    const c = this.container;
    c.innerHTML = '';
    c.classList.add('tabview');
    const wrap = document.createElement('div');
    wrap.className = 'score-wrap';
    c.appendChild(wrap);
    const scoreEl = document.createElement('div');
    wrap.appendChild(scoreEl);

    const width = Math.max(300, c.clientWidth || 900);
    const perLine = width < 560 ? 2 : width < 860 ? 3 : 4;
    const visual = ABCJS.renderAbc(scoreEl, displayAbc, {
      add_classes: true,
      staffwidth: width - 24,
      paddingleft: 4,
      paddingright: 4,
      paddingbottom: 8,
      wrap: { minSpacing: 1, maxSpacing: 3, preferredMeasuresPerLine: perLine },
      selectionColor: 'currentColor',
      dragging: false,
    })[0];
    this.visual = visual;
    if (!visual || !visual.lines.length) {
      wrap.innerHTML = '<p class="muted">Nothing to show yet.</p>';
      this.items = [];
      return null;
    }

    const TAB_H = tabHeight();
    this.tabH = TAB_H;
    const names = getShowNoteNames();
    const spacer = names ? '<span class="nn">&nbsp;</span>' : '';
    const { data, refs } = analyzeTune(visual);
    this.data = data;
    this.refs = refs;
    this.items = refs.map((r) => r.item);

    // --- make room under each line of music by shifting later lines down
    const svg = scoreEl.querySelector('svg');
    this.svg = svg;
    this.wrap = wrap;
    let k = -1;
    const lineShift = new Map(); // abcjs line index -> shift in px
    for (const child of [...svg.children]) {
      const cls = child.getAttribute('class') || '';
      const m = cls.match(/abcjs-staff-wrapper abcjs-l(\d+)/);
      if (m) { k++; lineShift.set(Number(m[1]), k * TAB_H); }
      const dy = m ? k * TAB_H : Math.max(0, k + 1) * TAB_H;
      if (dy && child.tagName.toLowerCase() === 'g') child.setAttribute('transform', `translate(0 ${dy})`);
    }
    const svgH = parseFloat(svg.getAttribute('height')) || svg.getBoundingClientRect().height;
    svg.setAttribute('height', svgH + (k + 1) * TAB_H);
    svg.style.overflow = 'visible';
    scoreEl.style.height = 'auto'; // abcjs pins the container to the original height

    // --- tab rows
    const base = wrap.getBoundingClientRect();
    const lines = new Map(); // line -> { top, bottom, refs: [] }
    for (const child of svg.querySelectorAll('g.abcjs-staff-wrapper')) {
      const li = Number((child.getAttribute('class').match(/abcjs-l(\d+)/) || [])[1]);
      const rc = child.getBoundingClientRect();
      lines.set(li, { top: rc.top - base.top, bottom: rc.bottom - base.top, refs: [] });
    }
    refs.forEach((r, i) => { r.index = i; const L = lines.get(r.line); if (L) L.refs.push(r); });

    this.cells = [];
    this.lineBoxes = [];
    let chord = null;
    const chordAt = []; // active chord for every item
    refs.forEach((r) => {
      const m = data.measures[r.measureIndex];
      const ch = m.chords.filter((x) => x.at <= r.itemIndex).pop();
      if (ch) chord = ch.name;
      chordAt.push(chord);
    });
    this.chordAt = chordAt;

    for (const [li, L] of lines) {
      if (!L.refs.length) continue;
      const tabTop = L.bottom + 2;
      const row = document.createElement('div');
      row.className = 'tab-row';
      row.style.top = tabTop + 'px';
      row.style.height = TAB_H - 10 + 'px';
      wrap.appendChild(row);
      this.lineBoxes.push({ line: li, top: L.top, tabTop, bottom: tabTop + TAB_H - 10, refs: L.refs, row });

      const xs = L.refs.map((r) => {
        const g = r.el.abselem && r.el.abselem.elemset && r.el.abselem.elemset[0];
        r.svgEl = g;
        if (!g) return null;
        const head = g.querySelector('.abcjs-notehead') || g;
        const rc = head.getBoundingClientRect();
        return rc.left + rc.width / 2 - base.left;
      });
      const lineEnd = L.refs.length ? (() => {
        const st = svg.querySelector(`g.abcjs-staff-wrapper.abcjs-l${li}`);
        const rc = st.getBoundingClientRect();
        return rc.right - base.left;
      })() : 0;

      L.refs.forEach((r, j) => {
        const x = xs[j];
        if (x == null) return;
        const it = r.item;
        if (it.invisible) return;
        const next = xs.slice(j + 1).find((v) => v != null) ?? lineEnd;
        const prev = xs.slice(0, j).reverse().find((v) => v != null) ?? -Infinity;
        r.tabX = x;
        r.tabNext = next;
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = `cell ${it.type} style-${getTabStyle()}` + (it.halfHole ? ' half' : '') + (it.octaveShift ? ' shifted' : '') + (it.register > 1 ? ' upper' : '');
        cell.style.left = x + 'px';
        cell.dataset.i = r.index;
        const len = beatsLabel(it.beats);
        if (it.type === 'note') {
          // "0/2" is too wide for closely spaced short notes: stack the "0/" above instead
          if (Math.min(next - x, x - prev) < 30) cell.classList.add('tight');
          const shift = it.octaveShift ? `<span class="shift" title="Out of whistle range - played ${it.octaveShift > 0 ? 'an octave higher' : 'an octave lower'}">${it.octaveShift > 0 ? '8↑' : '8↓'}</span>` : '';
          const fingering = getTabStyle() === 'holes'
            ? `${holesSVG(it.holes)}<span class="reg">${registerMark(it) || '&nbsp;'}</span>`
            : countHTML(it.holes, it.register);
          cell.innerHTML = `${names ? `<span class="nn">${it.name.replace('#', '♯').replace(/b$/, '♭')}</span>` : ''}${fingering}${shift}`;
          cell.setAttribute('aria-label', `${it.pitch}, cover ${fingerNumbers(it.holes, it.register)}, ${len} beats${it.register > 1 ? ', blow harder' : ''}`);
        } else if (it.type === 'rest') {
          cell.innerHTML = `${spacer}<span class="rest-mark">rest</span>`;
          cell.setAttribute('aria-label', `Rest, ${len} beats`);
        } else {
          cell.innerHTML = `${spacer}<span class="hold-mark">hold</span>`;
          cell.setAttribute('aria-label', `Keep holding, ${len} beats`);
        }
        cell.addEventListener('click', (e) => { e.stopPropagation(); this.select(r.index, { source: 'tab' }); });
        row.appendChild(cell);

        this.cells[r.index] = cell;
      });
    }

    // click on the engraved score -> nearest note on that line
    svg.addEventListener('click', (e) => {
      const y = e.clientY - wrap.getBoundingClientRect().top;
      const x = e.clientX - wrap.getBoundingClientRect().left;
      const box = this.lineBoxes.find((b) => y >= b.top - 20 && y <= b.bottom);
      if (!box) return;
      let best = null;
      for (const r of box.refs) {
        const cell = this.cells[r.index];
        if (!cell) continue;
        const cx = parseFloat(cell.style.left);
        const d = Math.abs(cx - x);
        if (!best || d < best.d) best = { d, i: r.index };
      }
      if (best && best.d < 40) this.select(best.i, { source: 'score' });
    });

    if (this.selected >= 0 && this.selected < this.items.length) this.select(this.selected, { quiet: true });
    else this.selected = -1;
    return { data, visual };
  }

  select(i, { source, quiet, scroll } = {}) {
    if (this.selected >= 0) {
      const prev = this.refs[this.selected];
      if (prev && prev.svgEl) prev.svgEl.classList.remove('note-active');
      this.cells[this.selected]?.classList.remove('active');
    }
    this.selected = i;
    if (i < 0) return;
    const r = this.refs[i];
    if (!r) return;
    if (r.svgEl) r.svgEl.classList.add('note-active');
    const cell = this.cells[i];
    if (cell) {
      cell.classList.add('active');
      if (scroll) {
        const rc = cell.getBoundingClientRect();
        const head = document.getElementById('top'); // stuck over the top of the page
        const top = (head ? head.getBoundingClientRect().bottom : 0) + 30;
        if (rc.top < top || rc.bottom > window.innerHeight - 40) cell.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
    if (!quiet) this.onSelect(r.item, i, { chord: this.chordAt[i], source, measure: this.data.measures[r.measureIndex] });
  }

  step(delta) {
    if (!this.items.length) return;
    let i = this.selected < 0 ? (delta > 0 ? -1 : this.items.length) : this.selected;
    do { i += delta; } while (i >= 0 && i < this.items.length && this.items[i].invisible);
    if (i >= 0 && i < this.items.length) this.select(i, { source: 'key', scroll: true });
  }

  /** Item order for playback, following repeats and 1st/2nd endings. */
  playOrder() {
    const M = this.data.measures;
    const order = [];
    let repStart = 0, repEnd = -1, pass = 1, skipping = false, i = 0, guard = 0;
    while (i < M.length && guard++ < 4000) {
      const m = M[i];
      if (pass === 2 && i > repEnd) { pass = 1; repStart = i; skipping = false; }
      if (m.repeatStart && !(pass === 2 && i === repStart)) { repStart = i; pass = 1; }
      if (m.ending) skipping = pass === 2 && String(m.ending).trim().startsWith('1');
      if (!skipping) order.push(i);
      if (m.repeatEnd && pass === 1) { pass = 2; repEnd = i; i = repStart; skipping = false; continue; }
      i++;
    }
    const firstIndex = [];
    let n = 0;
    M.forEach((m, mi) => { firstIndex[mi] = n; n += m.items.length; });
    return order.flatMap((mi) => M[mi].items.map((_, j) => firstIndex[mi] + j));
  }
}

/** Tempo to start with: the printed Q: tempo, or a relaxed default. */
export function defaultBpm(visual) {
  const printed = visual && visual.metaText && visual.metaText.tempo;
  const bpm = printed && visual.getBpm ? Math.round(visual.getBpm()) : 90;
  return Math.min(220, Math.max(30, bpm || 90));
}

// ----------------------------------------------------------------- audio

let ctx = null;
function audio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// Shared white-noise buffer for breath and the attack "chiff".
let noiseBuf = null;
function noise(a) {
  if (!noiseBuf || noiseBuf.sampleRate !== a.sampleRate) {
    noiseBuf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = a.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  return src;
}

// Tin-whistle timbre: strong fundamental, weak upper partials.
let whistleWave = null;
function wave(a) {
  if (!whistleWave || whistleWave.context !== a) {
    const real = new Float32Array([0, 1, 0.16, 0.06, 0.025, 0.01]);
    whistleWave = a.createPeriodicWave(real, new Float32Array(real.length));
    whistleWave.context = a;
  }
  return whistleWave;
}

// Recorded tin-whistle notes, prepared by scripts/prepare-samples.py into
// public/sounds/whistle/: samples.json lists each file's measured pitch (fractional
// MIDI) and loop points. Every note is played from the nearest recording, retuned.
const SAMPLE_DIR = new URL('../sounds/whistle/', import.meta.url);
let samples = []; // { midi, loopStart, loopEnd, buffer }, sorted by pitch
let samplesLoading = null, samplesReady = false;
export function loadSamples() {
  if (!samplesLoading) {
    const decoder = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
    const get = (name, opts) => fetch(new URL(name, SAMPLE_DIR), opts).then((r) => (r.ok ? r : Promise.reject(new Error(`${name}: ${r.status}`))));
    const next = [];
    // the manifest is always revalidated; each file's ?v= changes whenever its content does
    samplesLoading = get('samples.json', { cache: 'no-cache' }).then((r) => r.json())
      .then((list) => Promise.all(list.map((s) => get(s.v ? `${s.file}?v=${s.v}` : s.file)
        .then((r) => r.arrayBuffer())
        .then((b) => decoder.decodeAudioData(b))
        .then((buffer) => { next.push({ ...s, buffer }); })
        .catch(() => { /* a missing file just leaves a gap the others cover */ }))))
      .then(() => { samples = next.sort((x, y) => x.midi - y.midi); })
      .catch(() => { /* no samples: the synth is used */ })
      .finally(() => { samplesReady = true; });
  }
  return samplesLoading;
}
loadSamples();

function nearestSample(midi) {
  let best = null;
  for (const s of samples) if (!best || Math.abs(s.midi - midi) < Math.abs(best.midi - midi)) best = s;
  return best;
}

// ---- other instruments: General MIDI notes from the soundfont abcjs uses, one MP3 per
// note, fetched the first time a tune needs them. The penny whistle stays the default.
const SOUNDFONT = 'https://paulrosen.github.io/midi-js-soundfonts/abcjs/';
export const WHISTLE = 'pennywhistle';
export const INSTRUMENTS = [ // [group, [[soundfont name, label], ...]]
  ['', [[WHISTLE, 'Penny Whistle']]],
  ['Pipes & flutes', [['flute', 'Flute'], ['piccolo', 'Piccolo'], ['recorder', 'Recorder'], ['pan_flute', 'Pan flute'],
    ['ocarina', 'Ocarina'], ['shakuhachi', 'Shakuhachi'], ['whistle', 'Whistle (General MIDI)'], ['blown_bottle', 'Blown bottle']]],
  ['Reeds', [['accordion', 'Accordion'], ['tango_accordion', 'Bandoneon'], ['harmonica', 'Harmonica'], ['bagpipe', 'Bagpipes'],
    ['clarinet', 'Clarinet'], ['oboe', 'Oboe'], ['english_horn', 'Cor anglais'], ['bassoon', 'Bassoon'],
    ['soprano_sax', 'Soprano sax'], ['alto_sax', 'Alto sax'], ['tenor_sax', 'Tenor sax'], ['shanai', 'Shehnai']]],
  ['Strings', [['fiddle', 'Fiddle'], ['violin', 'Violin'], ['viola', 'Viola'], ['cello', 'Cello'], ['contrabass', 'Double bass'],
    ['pizzicato_strings', 'Pizzicato strings'], ['string_ensemble_1', 'String ensemble'], ['orchestral_harp', 'Harp']]],
  ['Plucked', [['acoustic_guitar_nylon', 'Nylon guitar'], ['acoustic_guitar_steel', 'Steel guitar'], ['electric_guitar_clean', 'Electric guitar'],
    ['banjo', 'Banjo'], ['dulcimer', 'Dulcimer'], ['sitar', 'Sitar'], ['koto', 'Koto'], ['shamisen', 'Shamisen']]],
  ['Keyboards', [['acoustic_grand_piano', 'Piano'], ['bright_acoustic_piano', 'Bright piano'], ['honkytonk_piano', 'Honky-tonk piano'],
    ['electric_piano_1', 'Electric piano'], ['harpsichord', 'Harpsichord'], ['church_organ', 'Church organ'], ['reed_organ', 'Harmonium'],
    ['drawbar_organ', 'Drawbar organ']]],
  ['Bells & mallets', [['celesta', 'Celesta'], ['glockenspiel', 'Glockenspiel'], ['music_box', 'Music box'], ['vibraphone', 'Vibraphone'],
    ['marimba', 'Marimba'], ['xylophone', 'Xylophone'], ['tubular_bells', 'Tubular bells'], ['kalimba', 'Kalimba'], ['steel_drums', 'Steel drums']]],
  ['Brass', [['trumpet', 'Trumpet'], ['muted_trumpet', 'Muted trumpet'], ['trombone', 'Trombone'], ['french_horn', 'French horn'],
    ['tuba', 'Tuba'], ['brass_section', 'Brass section']]],
  ['Voices', [['choir_aahs', 'Choir'], ['voice_oohs', 'Voice']]],
  ['Synth', [['lead_1_square', 'Square lead'], ['lead_2_sawtooth', 'Sawtooth lead'], ['lead_3_calliope', 'Calliope'],
    ['pad_2_warm', 'Warm pad'], ['synth_strings_1', 'Synth strings']]],
];
const INSTRUMENT_NAMES = new Set(INSTRUMENTS.flatMap(([, list]) => list.map(([id]) => id)));
const INSTRUMENT_KEY = 'pw-instrument';
export function getInstrument() {
  let v = null;
  try { v = localStorage.getItem(INSTRUMENT_KEY); } catch { /* storage blocked */ }
  return INSTRUMENT_NAMES.has(v) ? v : WHISTLE;
}
export function setInstrument(v) { try { localStorage.setItem(INSTRUMENT_KEY, v); } catch { /* storage blocked */ } }

const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']; // the soundfont's file names
const gmNotes = new Map(); // `${instrument}:${midi}` -> Promise of { buffer, gain } (null when it would not load)
const gmReady = new Map(); // the same, once settled
let gmDecoder = null;
const gmMidi = (midi) => Math.min(108, Math.max(21, Math.round(midi))); // A0..C8, the soundfont's range

function loadGmNote(inst, midi) {
  const key = `${inst}:${midi}`;
  if (!gmNotes.has(key)) {
    gmDecoder ||= new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
    gmNotes.set(key, fetch(`${SOUNDFONT}${inst}-mp3/${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}.mp3`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${inst} ${midi}: ${r.status}`))))
      .then((b) => gmDecoder.decodeAudioData(b))
      .then((buffer) => {
        // level-match the instruments: scale by the loudness of the note's first second
        const d = buffer.getChannelData(0), n = Math.min(d.length, buffer.sampleRate);
        let sum = 0;
        for (let i = 0; i < n; i++) sum += d[i] * d[i];
        const rms = Math.sqrt(sum / Math.max(1, n));
        return { buffer, gain: rms > 1e-4 ? Math.min(6, 0.38 / rms) : 1 };
      })
      .catch(() => null) // a missing note falls back to the whistle
      .then((note) => { gmReady.set(key, note); return note; }));
  }
  return gmNotes.get(key);
}

/** Load whatever the chosen instrument needs for these written pitches. */
export function loadInstrument(midis, inst = getInstrument()) {
  if (inst === WHISTLE) return loadSamples();
  return Promise.all([...new Set(midis)].map((m) => loadGmNote(inst, gmMidi(m))));
}
function instrumentReady(midis, inst) {
  return inst === WHISTLE ? samplesReady : midis.every((m) => gmReady.has(`${inst}:${gmMidi(m)}`));
}

/**
 * A note on the chosen instrument (by default the one picked in the player settings). The
 * penny whistle uses the nearest recorded note, retuned, once they have loaded, otherwise a
 * synthesized tone; a D whistle sounds an octave above the written pitch. Other instruments
 * play at the written pitch, falling back to the whistle for a note that has not loaded.
 */
export function tone(midi, start, dur, level = 0.2, context = null, { fadeIn = 0, fadeOut = 0, instrument = getInstrument() } = {}) {
  const a = context || audio(); // context: e.g. an OfflineAudioContext for rendering
  const t0 = Math.max(start ?? a.currentTime, a.currentTime);
  if (instrument !== WHISTLE) {
    const note = gmReady.get(`${instrument}:${gmMidi(midi)}`);
    if (note) return gmTone(a, note, t0, t0 + dur, level, fadeOut);
    loadGmNote(instrument, gmMidi(midi)); // e.g. a clicked note: ready for next time
  }
  const s = nearestSample(midi + 12);
  if (s) sampleTone(a, s, midi + 12, t0, t0 + dur, level, fadeIn, fadeOut);
  else synthTone(a, midi, t0, t0 + Math.max(0.07, dur - 0.025), dur, level);
}

// Output chain for the samples: a gentle top-end roll-off (tames squeak) and a little
// small-room reverb, since a completely dry sample sounds electronic.
const masters = new WeakMap();
function master(a) {
  let m = masters.get(a);
  if (!m) {
    m = a.createBiquadFilter();
    m.type = 'lowpass';
    m.frequency.value = 8000;
    m.Q.value = 0.5;
    m.connect(a.destination);
    const room = a.createConvolver();
    room.buffer = roomImpulse(a);
    const wet = a.createGain();
    wet.gain.value = 0.22;
    m.connect(room).connect(wet).connect(a.destination);
    masters.set(a, m);
  }
  return m;
}

/** Impulse response of a small, soft room: decaying noise with a short pre-delay. */
function roomImpulse(a) {
  const sr = a.sampleRate, len = Math.floor(sr * 0.9), pre = Math.floor(sr * 0.012);
  const buf = a.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      lp += 0.35 * ((Math.random() * 2 - 1) - lp); // darken the tail like soft furnishings
      d[i] = lp * Math.exp(-t / 0.16);
    }
  }
  return buf;
}

// Equal-power fade curves, so a crossfade between two notes keeps a steady loudness.
const SLUR = 0.09; // crossfade between different notes, seconds
const REPEAT_DIP = 0.03; // shorter crossfade on a repeated note: a soft re-tongue
const CURVE = 64;
const fadeCurve = (vol, up) => Float32Array.from({ length: CURVE }, (_, i) => vol * (up ? Math.sin : Math.cos)((i / (CURVE - 1)) * Math.PI / 2));

/**
 * Play one sampled note from t0 to `end`. fadeIn > 0: the note joins the previous one in
 * the same breath, so it skips the recorded attack (starting in the steady part) and fades
 * in over that many seconds, centred on t0. fadeOut > 0: it fades out the same way into
 * the next note. 0 means tongued: the note starts with its (softened) attack, or ends with
 * a short release and a small gap.
 */
function sampleTone(a, s, target, t0, end, level, fadeIn, fadeOut) {
  const src = a.createBufferSource();
  src.buffer = s.buffer;
  src.playbackRate.value = Math.pow(2, (target - s.midi) / 12);
  src.loop = true; // the loop has a crossfade baked in, so held notes sustain smoothly
  src.loopStart = s.loopStart;
  src.loopEnd = s.loopEnd;
  // samples are normalized to an RMS of 0.2; high notes sound louder and shriller, so ease
  // them down. A little random variation keeps repeated notes from sounding mechanical.
  const vol = level * 2.5 * Math.pow(10, (-0.3 * Math.max(0, target - 74) + (Math.random() - 0.5) * 1.5) / 20);
  src.detune.value = (Math.random() - 0.5) * 8; // within +-4 cents, as a player's pitch drifts
  const len = end - t0;
  const fi = Math.min(fadeIn, len * 0.8), fo = Math.min(fadeOut, len * 0.8);
  const g = a.createGain();
  let start, free; // free: when the fade-in's automation ends (events must not overlap)
  if (fi > 0) {
    start = Math.max(a.currentTime, t0 - fi / 2);
    free = t0 + fi / 2;
    g.gain.setValueCurveAtTime(fadeCurve(vol, true), start, free - start);
  } else {
    start = t0;
    free = start + Math.min(0.012, len * 0.3);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, free); // soften the attack's chiff
  }
  let stop;
  if (fo > 0) {
    const from = Math.max(free + 0.001, end - fo / 2);
    stop = Math.max(from + 0.01, end + fo / 2);
    g.gain.setValueCurveAtTime(fadeCurve(vol, false), from, stop - from);
  } else {
    const release = Math.min(0.08, Math.max(0.03, len / 4));
    stop = Math.max(free + 0.03, end - 0.02); // a small gap, as when the tongue stops the air
    g.gain.setValueAtTime(vol, Math.max(free + 0.001, stop - release));
    g.gain.exponentialRampToValueAtTime(0.0001, stop);
  }
  // gentle vibrato that a player adds to longer notes, eased in after the note settles
  if (len > 0.35) {
    const vib = a.createOscillator();
    vib.frequency.value = 5 + Math.random();
    const depth = a.createGain();
    depth.gain.setValueAtTime(0, t0);
    depth.gain.setValueAtTime(0, t0 + 0.2);
    depth.gain.linearRampToValueAtTime(10, Math.min(end, t0 + 0.6)); // cents
    vib.connect(depth).connect(src.detune);
    vib.start(t0);
    vib.stop(stop + 0.02);
  }
  src.connect(g).connect(master(a));
  src.start(start, fi > 0 ? s.loopStart : 0);
  src.stop(stop + 0.02);
}

/** One soundfont note from t0, released at `end` (a touch later when it runs into the next note). */
function gmTone(a, note, t0, end, level, fadeOut) {
  const src = a.createBufferSource();
  src.buffer = note.buffer;
  const vol = level * note.gain * Math.pow(10, ((Math.random() - 0.5) * 1.5) / 20);
  const g = a.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.005);
  const off = Math.max(t0 + 0.01, fadeOut > 0 ? end + 0.02 : end - 0.02);
  g.gain.setValueAtTime(vol, off);
  g.gain.setTargetAtTime(0, off, 0.04); // a natural damping, ~0.2 s to silence
  src.connect(g).connect(master(a));
  src.start(t0);
  src.stop(off + 0.3);
}

/** Synthesized fallback: a pure, slightly breathy tone with an air "chiff",
 *  a small pitch scoop at the start, and gentle vibrato on longer notes. */
function synthTone(a, midi, t0, end, dur, level) {
  const f = 440 * Math.pow(2, (midi + 12 - 69) / 12);
  const out = a.createGain();
  out.gain.value = 1;
  const lp = a.createBiquadFilter(); // soften the top end like a real whistle bore
  lp.type = 'lowpass';
  lp.frequency.value = Math.min(12000, f * 6);
  lp.connect(out);
  out.connect(a.destination);

  // tone
  const osc = a.createOscillator();
  osc.setPeriodicWave(wave(a));
  osc.frequency.setValueAtTime(f * 0.985, t0); // breathy scoop up into the note
  osc.frequency.exponentialRampToValueAtTime(f, t0 + 0.035);
  const vib = a.createOscillator();
  const vibDepth = a.createGain();
  vib.frequency.value = 5.2;
  vibDepth.gain.setValueAtTime(0, t0);
  if (dur > 0.45) { // only longer notes get vibrato, and it fades in
    vibDepth.gain.setValueAtTime(0, t0 + 0.25);
    vibDepth.gain.linearRampToValueAtTime(f * 0.0045, t0 + Math.min(0.7, dur));
  }
  vib.connect(vibDepth).connect(osc.frequency);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(level * 1.15, t0 + 0.018);
  g.gain.exponentialRampToValueAtTime(level, t0 + 0.07);
  g.gain.setValueAtTime(level, Math.max(t0 + 0.07, end - 0.03));
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(g).connect(lp);

  // steady breath noise, tuned around the note
  const breath = noise(a);
  const bp = a.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = f;
  bp.Q.value = 6;
  const bg = a.createGain();
  bg.gain.setValueAtTime(0.0001, t0);
  bg.gain.exponentialRampToValueAtTime(level * 0.35, t0 + 0.02);
  bg.gain.setValueAtTime(level * 0.35, Math.max(t0 + 0.02, end - 0.03));
  bg.gain.exponentialRampToValueAtTime(0.0001, end);
  breath.connect(bp).connect(bg).connect(lp);

  // attack "chiff": a short burst of air above the note
  const chiff = noise(a);
  const hp = a.createBiquadFilter();
  hp.type = 'bandpass';
  hp.frequency.value = Math.min(9000, f * 3);
  hp.Q.value = 1.2;
  const cg = a.createGain();
  cg.gain.setValueAtTime(0.0001, t0);
  cg.gain.exponentialRampToValueAtTime(level * 0.5, t0 + 0.006);
  cg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
  chiff.connect(hp).connect(cg).connect(lp);

  for (const node of [osc, vib, breath, chiff]) { node.start(t0); node.stop(end + 0.05); }
}

// ---- chords played under the tune (guitar, mandolin, banjo, …), from plucked-string (Karplus-Strong) samples.
// Each chord's whole pattern (strum, roll…) is mixed into one buffer and played as one
// source: one node per pick would be thousands for a tune, more than live audio can keep up with.
const plucks = new Map(); // `${sampleRate}:${midi}:${decay}:${tone}` -> Float32Array, 3 s of the string ringing
/** decay: how long the string rings (lower is shorter); tone: pick brightness, 0 (soft) to 1 (bright). */
function pluck(sr, midi, decay = 0.996, tone = 0.5) {
  const key = `${sr}:${midi}:${decay}:${tone}`;
  let d = plucks.get(key);
  if (d) return d;
  const len = Math.floor(sr * 3);
  d = new Float32Array(len);
  const n = Math.max(2, Math.round(sr / (440 * 2 ** ((midi - 69) / 12)) - 0.5)); // the averaging adds half a sample
  const soft = 0.15 + 0.85 * tone;
  let lp = 0, peak = 0;
  for (let i = 0; i < n; i++) { lp += soft * ((Math.random() * 2 - 1) - lp); d[i] = lp; } // the pick: noise, darkened for a soft one
  for (let i = n; i < len; i++) d[i] = decay * 0.5 * (d[i - n] + d[i - n - 1 < 0 ? 0 : i - n - 1]);
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak) for (let i = 0; i < len; i++) d[i] /= peak;
  plucks.set(key, d);
  return d;
}

/** Times (from 0, before `span`), directions and loudness of each stroke in an instrument's pattern; beat in seconds. */
function strokes(pattern, span, beat) {
  const every = Math.max(0.11, { strum: Infinity, beat, downup: beat / 2, roll: beat / 2 }[pattern] ?? Infinity); // seconds: no faster than hands can go, e.g. in 6/8
  const out = [];
  for (let t = 0, k = 0; t < span - 0.02 && (k === 0 || every !== Infinity); t += every, k++) {
    const up = pattern !== 'beat' && k % 2 === 1;
    out.push({ t, k, up, level: up ? 0.55 : 1 });
  }
  return out;
}
const ROLL = [2, 3, 4, 0, 2, 3, 4, 0]; // 5-string banjo forward roll, by string as drawn (0 is the drone)
const DAMP = 0.08; // seconds to damp the strings at a chord change

/** Every pick of a chord played for `span` seconds: { s (string), midi, t, vol }. */
function picks(inst, frets, span, beat) {
  const strings = frets.map((f, s) => (f === 'x' ? null : { s, midi: inst.tuning[s] + Number(f) })).filter(Boolean);
  const out = [];
  for (const st of strokes(inst.pattern, span, beat)) {
    if (inst.pattern === 'roll') { // one string at a time; a muted string's turn goes to the lowest string played
      const x = strings.find((y) => y.s === ROLL[st.k % ROLL.length]) || strings[strings.length > 1 ? 1 : 0];
      out.push({ ...x, t: st.t, vol: st.k % 4 === 0 ? 0.9 : 0.65 });
      continue;
    }
    const order = st.up ? strings.slice().reverse() : strings;
    const spread = st.up ? 0.008 : 0.014;
    order.forEach((x, k) => out.push({ ...x, t: st.t + k * spread, vol: st.level }));
  }
  return out;
}

const chordMixes = new Map(); // `${sampleRate}:${instrument}:${chord}:${span}:${beat}` -> AudioBuffer
/** The chord played for `span` seconds in the instrument's style, mixed into one buffer (then damped). */
function chordMix(a, instrument, name, span, beat) {
  const key = `${a.sampleRate}:${instrument}:${name}:${span.toFixed(3)}:${beat.toFixed(4)}`;
  if (chordMixes.has(key)) return chordMixes.get(key);
  const frets = chordFrets(name, instrument);
  if (!frets) return null;
  const inst = CHORD_INSTRUMENTS[instrument] || CHORD_INSTRUMENTS.guitar;
  const sr = a.sampleRate, len = Math.ceil((span + DAMP) * sr), fade = Math.round(0.005 * sr);
  const mix = new Float32Array(len);
  const all = picks(inst, frets, span, beat);
  // a course's second string, a few cents sharp (an octave up for a bouzouki's low two)
  const voices = inst.courses ? [[0, 1, 0], [12, 1.0025, 0.006]] : [[0, 1, 0]];
  for (const [octave, rate, delay] of voices) {
    all.forEach((p, i) => {
      const next = all.find((q, j) => j > i && q.s === p.s); // picking the string again stops this note
      const src = pluck(sr, p.midi + (octave && inst.octave && p.s < 2 ? 12 : 0), inst.decay, inst.tone);
      const from = Math.round((p.t + delay) * sr);
      const to = Math.min(len, next ? Math.round((next.t + delay) * sr) : len, from + Math.floor((src.length - 1) / rate));
      for (let i2 = from; i2 < to; i2++) {
        const x = (i2 - from) * rate, k = x | 0;
        let v = src[k] + (src[k + 1] - src[k]) * (x - k);
        const left = to - i2;
        if (left < fade) v *= left / fade; // no click where the note is cut off
        if (i2 >= len - DAMP * sr) v *= (len - i2) / (DAMP * sr); // damped at the chord change
        mix[i2] += v * p.vol;
      }
    });
  }
  const buf = a.createBuffer(1, len, sr);
  buf.copyToChannel(mix, 0);
  if (chordMixes.size > 64) chordMixes.clear();
  chordMixes.set(key, buf);
  return buf;
}

/**
 * Play a chord from t0 until `end` in the instrument's style (a strum, strums on the beat, down-up
 * strumming, a banjo roll); beat is a beat's length in seconds. False when the chord has no known shape.
 */
function strum(a, name, t0, end, beat, instrument = getChordInstrument(), level = 0.055) {
  const buf = chordMix(a, instrument, name, end - t0, beat);
  if (!buf) return false;
  const inst = CHORD_INSTRUMENTS[instrument] || CHORD_INSTRUMENTS.guitar;
  const out = a.createGain();
  out.gain.value = level * Math.sqrt(6 / inst.tuning.length) * (inst.courses ? 0.75 : 1); // fewer strings, each a little louder
  let into = out;
  for (const [type, freq, gain] of inst.body || []) { // the instrument's body
    const f = a.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (gain) f.gain.value = gain;
    into.connect(f);
    into = f;
  }
  into.connect(master(a));
  const src = a.createBufferSource();
  src.buffer = buf;
  src.connect(out);
  src.start(t0);
  return true;
}

/**
 * Schedule the tune's notes, in play order, on audio context `a` from time `t`; returns the
 * end time. sound: false only times the items. chords: strum the chords too (on chordInstrument), on
 * each chord change and at the start of each bar. onItem(idx, t) is called for every item.
 */
function schedule(a, v, bpm, order, t, { sound = true, chords = false, instrument = getInstrument(), chordInstrument = getChordInstrument(), onItem } = {}) {
  const beatLen = (v.visual.getBeatLength && v.visual.getBeatLength()) || 0.25;
  const wholeSec = (60 / bpm) / beatLen;
  const den = v.data.meter.den;
  const strums = []; // { t, chord }; chord null where the chords stop
  const beat = wholeSec / den;
  order.forEach((idx, k) => {
    const it = v.items[idx];
    const dur = (it.beats / den) * wholeSec;
    if (chords && sound) {
      const chord = v.chordAt[idx] || null, bar = v.refs[idx].measureIndex;
      const last = strums[strums.length - 1];
      if (chord !== (last?.chord ?? null) || (chord && bar !== last.bar)) strums.push({ t, chord, bar });
    }
    if (it.type === 'note' && sound) {
      // extend through following tied "hold" items
      let held = dur;
      let j = k + 1;
      for (; j < order.length && v.items[order[j]].type === 'hold'; j++) held += (v.items[order[j]].beats / den) * wholeSec;
      // one breath: notes flow into each other (a quick soft dip on repeated notes);
      // only the start of a phrase, after a rest, gets the tongued attack
      const prev = k > 0 ? v.items[order[k - 1]] : null;
      const next = j < order.length ? v.items[order[j]] : null;
      const join = (other) => (other.midi === it.midi ? REPEAT_DIP : SLUR);
      tone(it.midi, t, held, undefined, a, {
        fadeIn: prev && prev.type !== 'rest' ? join(prev) : 0,
        fadeOut: next && next.type === 'note' ? join(next) : 0,
        instrument,
      });
    }
    if (onItem) onItem(idx, t);
    t += dur;
  });
  strums.forEach((st, i) => { if (st.chord) strum(a, st.chord, st.t, strums[i + 1]?.t ?? t, beat, chordInstrument); });
  return t;
}

/** The whole tune as Play sounds it at this tempo (with or without the chords), rendered
 *  offline into a stereo AudioBuffer. */
export async function renderTune(view, bpm, { chords = false, instrument = getInstrument(), chordInstrument = getChordInstrument() } = {}) {
  if (!view.items.length) throw new Error('There are no notes to play.');
  await Promise.all([loadSamples(), loadInstrument(noteMidis(view), instrument)]);
  const order = view.playOrder();
  const lead = 0.15, tail = 1.5; // let the last note and the room ring out
  const len = schedule(null, view, bpm, order, 0, { sound: false }) + lead + tail;
  const rate = 44100;
  const a = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, Math.ceil(len * rate), rate);
  schedule(a, view, bpm, order, lead, { chords, instrument, chordInstrument });
  return a.startRendering();
}

const noteMidis = (view) => view.items.filter((it) => it.type === 'note').map((it) => it.midi);

export class Player {
  constructor(view, { onStop } = {}) {
    this.view = view;
    this.onStop = onStop || (() => {});
    this.timers = [];
    this.playing = false;
  }

  /** bpm counts the tune's beat unit (from Q: or the meter). Muted: no sound, the notes still highlight and scroll in time.
   *  chords: strum the chords too (on the chosen chord instrument), on each chord change and at the start of each bar. */
  play(bpm, fromItem = -1, { muted = false, chords = false } = {}) {
    this.stop();
    const v = this.view;
    if (!v.items.length) return;
    let order = v.playOrder();
    if (fromItem >= 0) {
      const at = order.indexOf(fromItem);
      if (at > 0) order = order.slice(at);
    }
    const instrument = getInstrument(), midis = noteMidis(v);
    if (!muted && !instrumentReady(midis, instrument)) { // first play: wait for the notes, then start
      this.playing = true;
      const waiting = this.waiting = {};
      loadInstrument(midis, instrument).then(() => {
        if (this.playing && this.waiting === waiting) { this.playing = false; this.play(bpm, fromItem, { muted, chords }); }
      });
      return;
    }
    const a = muted ? null : audio();
    const t0 = (a ? a.currentTime : 0) + 0.12;
    this.playing = true;
    const end = schedule(a, v, bpm, order, t0, {
      sound: !muted,
      chords,
      instrument,
      onItem: (idx, t) => {
        if (!v.items[idx].invisible) this.timers.push(setTimeout(() => v.select(idx, { source: 'play', scroll: true }), (t - t0) * 1000 + 120));
      },
    });
    this.timers.push(setTimeout(() => this.stop(), (end - t0) * 1000 + 1000)); // let the room ring out
  }

  stop() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (this.playing) { this.playing = false; this.onStop(); }
    if (ctx) { try { ctx.close(); } catch { /* already closed */ } ctx = null; }
  }
}
