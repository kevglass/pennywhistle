// Renders the engraved score with a penny-whistle tab row under every line,
// links notes <-> fingerings for click highlighting, and plays the tune.
import { analyzeTune, fingerNumbers, markFor } from './core.js';

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
  return m ? `<span class="count open-top" aria-hidden="true"><small>0/</small>${m[1]}${mark}</span>` : `<span class="count" aria-hidden="true">${t}${mark}</span>`;
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
    const chordAt = []; // active guitar chord for every item
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
        r.tabX = x;
        r.tabNext = next;
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = `cell ${it.type} style-${getTabStyle()}` + (it.halfHole ? ' half' : '') + (it.octaveShift ? ' shifted' : '') + (it.register > 1 ? ' upper' : '');
        cell.style.left = x + 'px';
        cell.dataset.i = r.index;
        const len = beatsLabel(it.beats);
        if (it.type === 'note') {
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
        const bar = document.querySelector('body.has-player .player:not(.collapsed)'); // fixed over the top of the page
        const top = (bar ? bar.getBoundingClientRect().bottom : 0) + 30;
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
// Recorded tin-whistle notes, prepared by scripts/prepare-samples.py into
// public/sounds/whistle/: samples.json lists each file's pitch and loop points.
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

/**
 * A penny-whistle note. Uses the nearest recorded note, retuned, once they have loaded;
 * otherwise a synthesized tone. A D whistle sounds an octave above the written pitch.
 */
export function tone(midi, start, dur, level = 0.2, context = null, { fadeIn = 0, fadeOut = 0 } = {}) {
  const a = context || audio(); // context: e.g. an OfflineAudioContext for rendering
  const t0 = Math.max(start ?? a.currentTime, a.currentTime);
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

export class Player {
  constructor(view, { onStop } = {}) {
    this.view = view;
    this.onStop = onStop || (() => {});
    this.timers = [];
    this.playing = false;
  }

  /** bpm counts the tune's beat unit (from Q: or the meter). Muted: no sound, the notes still highlight and scroll in time. */
  play(bpm, fromItem = -1, { muted = false } = {}) {
    this.stop();
    const v = this.view;
    if (!v.items.length) return;
    const beatLen = (v.visual.getBeatLength && v.visual.getBeatLength()) || 0.25;
    const wholeSec = (60 / bpm) / beatLen;
    const den = v.data.meter.den;
    let order = v.playOrder();
    if (fromItem >= 0) {
      const at = order.indexOf(fromItem);
      if (at > 0) order = order.slice(at);
    }
    if (!muted && !samplesReady) { // first play: wait for the samples, then start
      this.playing = true;
      loadSamples().then(() => { if (this.playing) { this.playing = false; this.play(bpm, fromItem, { muted }); } });
      return;
    }
    let t = (muted ? 0 : audio().currentTime) + 0.12;
    const t0 = t;
    this.playing = true;
    order.forEach((idx, k) => {
      const it = v.items[idx];
      const dur = (it.beats / den) * wholeSec;
      if (it.type === 'note' && !muted) {
        // extend through following tied "hold" items
        let sound = dur;
        let j = k + 1;
        for (; j < order.length && v.items[order[j]].type === 'hold'; j++) sound += (v.items[order[j]].beats / den) * wholeSec;
        // one breath: notes flow into each other (a quick soft dip on repeated notes);
        // only the start of a phrase, after a rest, gets the tongued attack
        const prev = k > 0 ? v.items[order[k - 1]] : null;
        const next = j < order.length ? v.items[order[j]] : null;
        const join = (other) => (other.midi === it.midi ? REPEAT_DIP : SLUR);
        tone(it.midi, t, sound, undefined, null, {
          fadeIn: prev && prev.type !== 'rest' ? join(prev) : 0,
          fadeOut: next && next.type === 'note' ? join(next) : 0,
        });
      }
      const delay = (t - t0) * 1000 + 120;
      if (!it.invisible) this.timers.push(setTimeout(() => v.select(idx, { source: 'play', scroll: true }), delay));
      t += dur;
    });
    this.timers.push(setTimeout(() => this.stop(), (t - t0) * 1000 + 1000)); // let the room ring out
  }

  stop() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (this.playing) { this.playing = false; this.onStop(); }
    if (ctx) { try { ctx.close(); } catch { /* already closed */ } ctx = null; }
  }
}
