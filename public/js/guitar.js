// Chord shapes for the strummed instruments that can play the chords under the tune.
// Guitar shapes are listed by hand (low E -> high e; 'x' = muted, 0 = open); the other
// instruments' shapes are worked out from their tuning.

const SHAPES = {
  C: 'x32010', D: 'xx0232', E: '022100', F: '133211', G: '320003', A: 'x02220', B: 'x24442',
  Cm: 'x35543', Dm: 'xx0231', Em: '022000', Fm: '133111', Gm: '355333', Am: 'x02210', Bm: 'x24432',
  C7: 'x32310', D7: 'xx0212', E7: '020100', F7: '131211', G7: '320001', A7: 'x02020', B7: 'x21202',
  Am7: 'x02010', Bm7: 'x20202', Dm7: 'xx0211', Em7: '022030', 'F#m7': '242222',
  Cmaj7: 'x32000', Dmaj7: 'xx0222', Fmaj7: 'xx3210', Gmaj7: '320002', Amaj7: 'x02120',
  Dsus2: 'xx0230', Dsus4: 'xx0233', Asus2: 'x02200', Asus4: 'x02230', Esus4: '022200', Gsus4: '330013',
  'F#': '244322', 'F#m': '244222', 'C#m': 'x46654', 'G#m': '466444', Bb: 'x13331', Eb: 'x68886',
  Ab: '466544', Db: 'x46664', 'C#': 'x46664', 'G#': '466544', 'D#': 'x68886', 'A#': 'x13331',
  'F#7': '242322', 'C#7': 'x46464', Bbm: 'x13321', Ebm: 'x68876', 'D#m': 'x68876', 'A#m': 'x13321',
};

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function parseChord(name) {
  const m = String(name).replace('♯', '#').replace('♭', 'b').match(/^([A-G])([#b]?)(.*?)(?:\/[A-G][#b]?)?$/);
  if (!m) return null;
  const pc = (PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return { root: m[1] + m[2], pc, quality: m[3] };
}

/**
 * Instruments that can play the chords. tuning: MIDI note of each string, as drawn left to right
 * (low to high, except a ukulele's high G and a 5-string banjo's short drone string, which come first).
 * How they sound when playing along:
 *   pattern  strum: once per bar or chord change; beat: a strum on every beat; downup: down on the
 *            beat, a lighter up-strum between; roll: a banjo forward roll
 *   decay    how long a string rings (lower is shorter); tone: pick brightness, 0 (soft) to 1 (bright)
 *   courses  pairs of strings, slightly out of tune with each other (shimmer); octave: the lowest two
 *            courses in octaves, as on a bouzouki
 *   body     filters that shape the sound: [type, frequency, gain in dB for a peaking filter]
 */
export const CHORD_INSTRUMENTS = {
  guitar: { label: 'Guitar', tuning: [40, 45, 50, 55, 59, 64], pattern: 'strum', decay: 0.996, tone: 0.5, body: [['lowpass', 4500]] },
  mandolin: { label: 'Mandolin', tuning: [55, 62, 69, 76], pattern: 'downup', decay: 0.991, tone: 0.9, courses: true,
    body: [['highpass', 250], ['peaking', 3000, 5]] },
  mandola: { label: 'Mandola', tuning: [48, 55, 62, 69], pattern: 'downup', decay: 0.993, tone: 0.8, courses: true,
    body: [['highpass', 150], ['peaking', 2200, 4]] },
  bouzouki: { label: 'Irish bouzouki', tuning: [43, 50, 57, 62], pattern: 'beat', decay: 0.996, tone: 0.75, courses: true, octave: true,
    body: [['peaking', 1800, 3]] },
  tenor_banjo: { label: 'Tenor banjo (GDAE)', tuning: [43, 50, 57, 64], pattern: 'downup', decay: 0.982, tone: 1,
    body: [['highpass', 220], ['peaking', 2400, 8]] },
  banjo: { label: 'Banjo (5-string)', tuning: [67, 50, 55, 59, 62], drone: 0, pattern: 'roll', decay: 0.982, tone: 1,
    body: [['highpass', 220], ['peaking', 2400, 8]] },
  ukulele: { label: 'Ukulele', tuning: [67, 60, 64, 69], reentrant: true, pattern: 'downup', decay: 0.988, tone: 0.25,
    body: [['highpass', 300], ['lowpass', 3500]] },
  baritone_ukulele: { label: 'Baritone ukulele', tuning: [50, 55, 59, 64], pattern: 'downup', decay: 0.99, tone: 0.3,
    body: [['highpass', 150], ['lowpass', 3500]] },
};
const CHORD_INSTRUMENT_KEY = 'pw-chord-instrument';
export function getChordInstrument() {
  let v = null;
  try { v = localStorage.getItem(CHORD_INSTRUMENT_KEY); } catch { /* storage blocked */ }
  return CHORD_INSTRUMENTS[v] ? v : 'guitar';
}
export function setChordInstrument(v) { try { localStorage.setItem(CHORD_INSTRUMENT_KEY, v); } catch { /* storage blocked */ } }

function guitarFrets(name) {
  const clean = String(name).replace(/\s+/g, '');
  const noBass = clean.replace(/\/[A-G][#b]?$/, '');
  if (SHAPES[noBass]) return SHAPES[noBass];
  const p = parseChord(noBass);
  if (!p) return null;
  const q = p.quality === 'min' ? 'm' : p.quality;
  if (SHAPES[p.root + q]) return SHAPES[p.root + q];
  // Moveable barre shapes for anything else in the common families.
  const eFret = (p.pc - 4 + 12) % 12 || 12;
  const aFret = (p.pc - 9 + 12) % 12 || 12;
  const useA = aFret < eFret;
  const f = useA ? aFret : eFret;
  const shapes = useA
    ? { '': [null, 0, 2, 2, 2, 0], m: [null, 0, 2, 2, 1, 0], 7: [null, 0, 2, 0, 2, 0], m7: [null, 0, 2, 0, 1, 0] }
    : { '': [0, 2, 2, 1, 0, 0], m: [0, 2, 2, 0, 0, 0], 7: [0, 2, 0, 1, 0, 0], m7: [0, 2, 0, 0, 0, 0] };
  const s = shapes[q];
  if (!s) return null;
  return s.map((x) => (x == null ? 'x' : String(x + f))).join(',');
}

/** Semitones above the root of each chord quality's notes. */
const QUALITIES = {
  '': [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7], 5: [0, 7], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9],
  7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11], 9: [0, 4, 7, 10, 2], add9: [0, 4, 7, 2],
  sus: [0, 5, 7], sus2: [0, 2, 7], sus4: [0, 5, 7], '7sus4': [0, 5, 7, 10],
  dim: [0, 3, 6], dim7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10], aug: [0, 4, 8], '+': [0, 4, 8],
};
const MAX_FRET = 9;

/**
 * The easiest shape for a chord on an instrument: every string sounds a chord note (the fifth
 * may be left out of bigger chords), within four frets and four fingers, as low on the neck
 * as possible, preferring the root as the lowest note.
 */
function findShape(inst, name) {
  const p = parseChord(String(name).replace(/\s+/g, '').replace(/\/[A-G][#b]?$/, ''));
  const iv = p && QUALITIES[p.quality];
  if (!iv) return null;
  const pcs = iv.map((i) => (p.pc + i) % 12);
  const required = iv.length > 3 ? pcs.filter((_, k) => iv[k] !== 7) : pcs;
  const options = inst.tuning.map((open, s) => {
    if (s === inst.drone) return [pcs.includes(open % 12) ? 0 : 'x']; // the drone string isn't fretted
    const o = [];
    for (let f = 0; f <= MAX_FRET; f++) if (pcs.includes((open + f) % 12)) o.push(f);
    return o;
  });
  let best = null, bestCost = Infinity;
  const pick = [];
  const score = () => {
    const fretted = pick.filter((f) => f !== 'x' && f > 0);
    const lo = Math.min(...fretted), hi = Math.max(...fretted, 0);
    if (fretted.length && hi - lo > 3) return Infinity;
    const atLo = fretted.filter((f) => f === lo).length;
    const fingers = fretted.length - (atLo > 1 ? atLo - 1 : 0); // a barre across the lowest fret
    if (fingers > 4) return Infinity;
    const notes = pick.map((f, s) => (f === 'x' ? null : inst.tuning[s] + f)).filter((n) => n != null);
    const have = new Set(notes.map((n) => n % 12));
    if (!required.every((pc) => have.has(pc))) return Infinity;
    const rootBass = inst.reentrant || Math.min(...notes) % 12 === p.pc;
    return hi * 2 + fingers + (rootBass ? 0 : 3) + (pcs.every((pc) => have.has(pc)) ? 0 : 1);
  };
  const walk = (s) => {
    if (s === options.length) {
      const c = score();
      if (c < bestCost) { bestCost = c; best = pick.slice(); }
      return;
    }
    for (const f of options[s]) { pick[s] = f; walk(s + 1); }
  };
  walk(0);
  return best && best.map(String);
}

const shapes = new Map(); // `${instrument}:${name}` -> frets
/** Frets for a chord on an instrument, one per string as drawn ('x' = not played), or null when we don't know a shape. */
export function chordFrets(name, instrument = 'guitar') {
  const key = `${instrument}:${name}`;
  if (!shapes.has(key)) {
    const inst = CHORD_INSTRUMENTS[instrument] || CHORD_INSTRUMENTS.guitar;
    const g = inst === CHORD_INSTRUMENTS.guitar ? guitarFrets(name) : null;
    shapes.set(key, inst === CHORD_INSTRUMENTS.guitar ? (g && (g.includes(',') ? g.split(',') : g.split(''))) : findShape(inst, name));
  }
  return shapes.get(key);
}

/** SVG chord box diagram for the instrument. */
export function chordDiagramSVG(name, instrument = 'guitar') {
  const frets = chordFrets(name, instrument);
  const label = `${(CHORD_INSTRUMENTS[instrument] || CHORD_INSTRUMENTS.guitar).label} chord ${name}`;
  const strings = (CHORD_INSTRUMENTS[instrument] || CHORD_INSTRUMENTS.guitar).tuning.length;
  const left = 14, top = 24, sx = 10, sy = 13, n = 5, H = 92, W = 24 + (strings - 1) * sx;
  if (!frets) {
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}"><text x="${W / 2}" y="14" text-anchor="middle" class="cd-name">${name}</text><text x="${W / 2}" y="55" text-anchor="middle" class="cd-muted">no diagram</text></svg>`;
  }
  const nums = frets.filter((f) => f !== 'x').map(Number);
  const max = Math.max(...nums, 0);
  const minPos = Math.min(...nums.filter((f) => f > 0), 99);
  const base = max > 4 ? minPos : 1;
  const right = left + (strings - 1) * sx;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}">`;
  s += `<text x="${W / 2}" y="12" text-anchor="middle" class="cd-name">${name}</text>`;
  for (let i = 0; i < strings; i++) s += `<line x1="${left + i * sx}" y1="${top}" x2="${left + i * sx}" y2="${top + n * sy}" class="cd-line"/>`;
  for (let j = 0; j <= n; j++) s += `<line x1="${left}" y1="${top + j * sy}" x2="${right}" y2="${top + j * sy}" class="${j === 0 && base === 1 ? 'cd-nut' : 'cd-line'}"/>`;
  if (base > 1) s += `<text x="${right + 4}" y="${top + sy - 3}" class="cd-fret">${base}fr</text>`;
  frets.forEach((f, i) => {
    const x = left + i * sx;
    if (f === 'x') s += `<text x="${x}" y="${top - 4}" text-anchor="middle" class="cd-mark">×</text>`;
    else if (f === '0') s += `<circle cx="${x}" cy="${top - 7}" r="3" class="cd-open"/>`;
    else {
      const rel = Number(f) - base + 1;
      s += `<circle cx="${x}" cy="${top + (rel - 0.5) * sy}" r="4" class="cd-dot"/>`;
    }
  });
  return s + '</svg>';
}
