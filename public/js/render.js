// Renders the engraved score with a penny-whistle tab row under every line,
// links notes <-> fingerings for click highlighting, and plays the tune.
import { analyzeTune, fingerNumbers, markFor } from './core.js';

// vertical room reserved under each system for the tab row
const tabHeight = () => (getTabStyle() === 'holes' ? 118 : 60);

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
          cell.innerHTML = `<span class="nn">${it.name.replace('#', '♯').replace(/b$/, '♭')}</span>${fingering}${shift}`;
          cell.setAttribute('aria-label', `${it.pitch}, cover ${fingerNumbers(it.holes, it.register)}, ${len} beats${it.register > 1 ? ', blow harder' : ''}`);
        } else if (it.type === 'rest') {
          cell.innerHTML = `<span class="nn">&nbsp;</span><span class="rest-mark">rest</span>`;
          cell.setAttribute('aria-label', `Rest, ${len} beats`);
        } else {
          cell.innerHTML = `<span class="nn">&nbsp;</span><span class="hold-mark">hold</span>`;
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
        if (rc.top < 80 || rc.bottom > window.innerHeight - 40) cell.scrollIntoView({ block: 'center', behavior: 'smooth' });
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

/**
 * A penny-whistle note: a pure, slightly breathy tone with an air "chiff" and a
 * small pitch scoop at the start, and gentle vibrato on longer notes.
 * A D whistle sounds an octave above the written pitch.
 */
export function tone(midi, start, dur, level = 0.2, context = null, dest = null) {
  const a = context || audio(); // context: e.g. an OfflineAudioContext for rendering
  const t0 = Math.max(start ?? a.currentTime, a.currentTime);
  const f = 440 * Math.pow(2, (midi + 12 - 69) / 12);
  const end = t0 + Math.max(0.07, dur - 0.025); // tiny gap so repeated notes are tongued
  const out = a.createGain();
  out.gain.value = 1;
  const lp = a.createBiquadFilter(); // soften the top end like a real whistle bore
  lp.type = 'lowpass';
  lp.frequency.value = Math.min(12000, f * 6);
  lp.connect(out);
  out.connect(dest || a.destination);

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

// ---------------------------------------------------------- recorded samples

// Real D tin whistle notes (see public/audio/README.md); the synth above is the fallback.
const SAMPLE_DIR = new URL('../audio/', import.meta.url);
const banks = new WeakMap(); // AudioContext -> Promise<[{midi, cents, buffer, loopStart, loopEnd}]>

/** Load and decode the sample set for an audio context (once per context). */
export function loadSamples(context = null) {
  const a = context || audio();
  if (!banks.has(a)) {
    banks.set(a, (async () => {
      const list = await (await fetch(new URL('samples.json', SAMPLE_DIR))).json();
      return Promise.all(list.map(async (s) => ({
        ...s,
        buffer: await a.decodeAudioData(await (await fetch(new URL(s.file, SAMPLE_DIR))).arrayBuffer()),
      })));
    })().catch((e) => { console.warn('Whistle samples unavailable, using synthesised sound:', e); banks.delete(a); return null; }));
  }
  return banks.get(a);
}

/** Bring a written pitch into the D whistle's range (as the tab does), as a sounding pitch. */
function soundingPitch(midi) {
  let m = midi;
  while (m < 62) m += 12;
  while (m > 86) m -= 12;
  return m + 12; // a D whistle sounds an octave above written pitch
}

function playSample(a, bank, midi, t0, dur, level, dest) {
  const target = soundingPitch(midi);
  let s = bank[0];
  for (const b of bank) if (Math.abs(b.midi - target) < Math.abs(s.midi - target)) s = b;
  const src = a.createBufferSource();
  src.buffer = s.buffer;
  src.playbackRate.value = 2 ** ((target - (s.midi + s.cents / 100)) / 12);
  const natural = s.buffer.duration / src.playbackRate.value;
  if (dur > natural - 0.05) { // hold longer than the recording: loop its steady middle
    src.loop = true;
    src.loopStart = s.loopStart;
    src.loopEnd = s.loopEnd;
  }
  const g = a.createGain();
  const end = t0 + Math.max(0.08, dur - 0.02); // tiny gap so repeated notes are tongued
  const rel = Math.min(0.06, (end - t0) / 3);
  g.gain.setValueAtTime(level, t0);
  g.gain.setValueAtTime(level, end - rel);
  g.gain.linearRampToValueAtTime(0.0001, end);
  src.connect(g).connect(dest || a.destination);
  src.start(t0);
  src.stop(end + 0.02);
}

/**
 * Play a note: the recorded whistle when its samples are loaded, otherwise the synth.
 * (Samples start loading on first use; the first tap may use the synth.)
 */
export function whistleNote(midi, start, dur, context = null, dest = null) {
  const a = context || audio();
  const t0 = Math.max(start ?? a.currentTime, a.currentTime);
  const bank = readyBanks.get(a);
  if (bank) playSample(a, bank, midi, t0, dur, 0.9, dest);
  else {
    loadSamples(a).then((b) => { if (b) readyBanks.set(a, b); });
    tone(midi, t0, dur, 0.2, a, dest);
  }
}
const readyBanks = new WeakMap();

/** Await the samples (used before playback so a whole tune uses the recordings). */
export async function samplesReady(context = null) {
  const a = context || audio();
  const b = await loadSamples(a);
  if (b) readyBanks.set(a, b);
  return !!b;
}

export class Player {
  constructor(view, { onStop } = {}) {
    this.view = view;
    this.onStop = onStop || (() => {});
    this.timers = [];
    this.playing = false;
  }

  /** bpm counts the tune's beat unit (from Q: or the meter). */
  async play(bpm, fromItem = -1) {
    this.stop();
    this.playing = true;
    await samplesReady();
    if (!this.playing) return; // stopped while loading
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
    const a = audio();
    this.bus = a.createGain();
    this.bus.connect(a.destination);
    let t = a.currentTime + 0.12;
    const t0 = t;
    order.forEach((idx, k) => {
      const it = v.items[idx];
      const dur = (it.beats / den) * wholeSec;
      if (it.type === 'note') {
        // extend through following tied "hold" items
        let sound = dur;
        for (let j = k + 1; j < order.length && v.items[order[j]].type === 'hold'; j++) sound += (v.items[order[j]].beats / den) * wholeSec;
        whistleNote(it.midi, t, sound, a, this.bus);
      }
      const delay = (t - t0) * 1000 + 120;
      if (!it.invisible) this.timers.push(setTimeout(() => v.select(idx, { source: 'play', scroll: true }), delay));
      t += dur;
    });
    this.timers.push(setTimeout(() => this.stop(), (t - t0) * 1000 + 300));
  }

  stop() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (this.playing) { this.playing = false; this.onStop(); }
    if (this.bus) { // silence anything still scheduled, keep the audio context (and samples)
      const bus = this.bus, a = bus.context;
      bus.gain.setTargetAtTime(0, a.currentTime, 0.02);
      setTimeout(() => bus.disconnect(), 300);
      this.bus = null;
    }
  }
}
