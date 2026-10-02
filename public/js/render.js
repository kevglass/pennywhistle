// Renders the engraved score with a penny-whistle tab row under every line,
// links notes <-> fingerings for click highlighting, and plays the tune.
import { analyzeTune } from './core.js';

const TAB_H = 132; // vertical room reserved under each system for the tab row

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

const registerMark = (it) => (it.register === 2 ? '+' : it.register === 3 ? '++' : '');

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

    const { data, refs } = analyzeTune(visual);
    this.data = data;
    this.refs = refs;
    this.items = refs.map((r) => r.item);

    // --- make room under each line of music by shifting later lines down
    const svg = scoreEl.querySelector('svg');
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
      this.lineBoxes.push({ top: L.top, bottom: tabTop + TAB_H - 10, refs: L.refs, row });

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
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = `cell ${it.type}` + (it.halfHole ? ' half' : '') + (it.octaveShift ? ' shifted' : '') + (it.register > 1 ? ' upper' : '');
        cell.style.left = x + 'px';
        cell.dataset.i = r.index;
        const len = beatsLabel(it.beats);
        if (it.type === 'note') {
          const shift = it.octaveShift ? `<span class="shift" title="Out of whistle range - played ${it.octaveShift > 0 ? 'an octave higher' : 'an octave lower'}">${it.octaveShift > 0 ? '8↑' : '8↓'}</span>` : '';
          cell.innerHTML = `<span class="nn">${it.name.replace('#', '♯').replace(/b$/, '♭')}</span>${holesSVG(it.holes)}<span class="reg">${registerMark(it) || '&nbsp;'}</span>${shift}`;
          cell.setAttribute('aria-label', `${it.pitch}, ${len} beats${it.register > 1 ? ', blow harder' : ''}`);
        } else if (it.type === 'rest') {
          cell.innerHTML = `<span class="nn">&nbsp;</span><span class="rest-mark">rest</span>`;
          cell.setAttribute('aria-label', `Rest, ${len} beats`);
        } else {
          cell.innerHTML = `<span class="nn">&nbsp;</span><span class="hold-mark">hold</span>`;
          cell.setAttribute('aria-label', `Keep holding, ${len} beats`);
        }
        cell.addEventListener('click', (e) => { e.stopPropagation(); this.select(r.index, { source: 'tab' }); });
        row.appendChild(cell);

        const bar = document.createElement('div');
        bar.className = `sustain ${it.type}`;
        bar.style.left = x - 6 + 'px';
        bar.style.width = Math.max(10, next - x - 2) + 'px';
        bar.innerHTML = `<span>${len}</span>`;
        bar.title = `${len} beat${it.beats === 1 ? '' : 's'}`;
        row.appendChild(bar);
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

/** A breathy, whistle-like tone. Whistles sound an octave above written pitch. */
export function tone(midi, start, dur, gainLevel = 0.18) {
  const a = audio();
  const t0 = start ?? a.currentTime;
  const f = 440 * Math.pow(2, (midi + 12 - 69) / 12);
  const osc = a.createOscillator();
  const osc2 = a.createOscillator();
  const g = a.createGain();
  const g2 = a.createGain();
  const vib = a.createOscillator();
  const vibG = a.createGain();
  osc.type = 'sine';
  osc2.type = 'triangle';
  osc.frequency.value = f;
  osc2.frequency.value = f;
  g2.gain.value = 0.25;
  vib.frequency.value = 5.5;
  vibG.gain.setValueAtTime(0, t0);
  vibG.gain.linearRampToValueAtTime(f * 0.006, t0 + Math.min(0.35, dur));
  vib.connect(vibG); vibG.connect(osc.frequency); vibG.connect(osc2.frequency);
  osc.connect(g); osc2.connect(g2); g2.connect(g); g.connect(a.destination);
  const end = t0 + Math.max(0.06, dur - 0.02);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gainLevel, t0 + 0.025);
  g.gain.setValueAtTime(gainLevel, Math.max(t0 + 0.03, end - 0.04));
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  for (const o of [osc, osc2, vib]) { o.start(t0); o.stop(end + 0.05); }
}

export class Player {
  constructor(view, { onStop } = {}) {
    this.view = view;
    this.onStop = onStop || (() => {});
    this.timers = [];
    this.playing = false;
  }

  /** bpm counts the tune's beat unit (from Q: or the meter). */
  play(bpm, fromItem = -1) {
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
    const a = audio();
    let t = a.currentTime + 0.12;
    const t0 = t;
    this.playing = true;
    order.forEach((idx, k) => {
      const it = v.items[idx];
      const dur = (it.beats / den) * wholeSec;
      if (it.type === 'note') {
        // extend through following tied "hold" items
        let sound = dur;
        for (let j = k + 1; j < order.length && v.items[order[j]].type === 'hold'; j++) sound += (v.items[order[j]].beats / den) * wholeSec;
        tone(it.midi, t, sound);
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
    if (ctx) { try { ctx.close(); } catch { /* already closed */ } ctx = null; }
  }
}
