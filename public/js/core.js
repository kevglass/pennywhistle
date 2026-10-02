// Core music logic: turns abcjs tune objects into penny-whistle tab data,
// fingerings, guitar chords and whistle-friendly transpositions.
// Works in the browser (window.ABCJS) and in Node (pass the abcjs module).

const ABC = () => globalThis.ABCJS;

// ---------------------------------------------------------------- whistle

// Holes top (nearest mouthpiece) to bottom. X = covered, O = open, H = half-hole.
const LOW_OCTAVE = {
  62: 'XXXXXX', // D
  63: 'XXXXXH', // D#/Eb
  64: 'XXXXXO', // E
  65: 'XXXXHO', // F natural
  66: 'XXXXOO', // F#
  67: 'XXXOOO', // G
  68: 'XXHOOO', // G#/Ab
  69: 'XXOOOO', // A
  70: 'XHOOOO', // A#/Bb
  71: 'XOOOOO', // B
  72: 'OXXOOO', // C natural (cross fingering)
  73: 'OOOOOO', // C#
};

export const WHISTLE_MIN = 62; // D4 (written pitch)
export const WHISTLE_MAX = 86; // D6
export const WHISTLE_COMFORT_MAX = 83; // B5

/** Fingering for a written MIDI pitch on a D whistle. */
export function whistleFingering(midi) {
  let m = midi;
  let octaveShift = 0;
  while (m < WHISTLE_MIN) { m += 12; octaveShift += 1; }
  while (m > WHISTLE_MAX) { m -= 12; octaveShift -= 1; }
  let holes;
  let register;
  if (m <= 73) { holes = LOW_OCTAVE[m]; register = 1; }
  else if (m === 74) { holes = 'OXXXXX'; register = 2; }
  else if (m <= 85) { holes = LOW_OCTAVE[m - 12]; register = 2; }
  else { holes = 'OXXXXX'; register = 3; }
  return {
    holes,
    register, // 1 = normal breath, 2 = blow harder, 3 = blow much harder
    octaveShift, // non-zero when the note was out of range and moved by octaves
    halfHole: holes.includes('H'),
    cross: m % 12 === 0,
    hard: m > WHISTLE_COMFORT_MAX,
  };
}

/**
 * Number tab: how many holes to hold down, counting from the top (nearest the
 * mouthpiece). "3" = hold holes 1-3. When the top hole is open the count follows
 * "0/": "0/2" = hold holes 2-3, "0/5" = holes 2-6. "0" = all open.
 * "½" after the count = also half-cover the next hole ("4½" = 1-4 plus half of 5).
 * "'" = blow harder (high octave), "''" = third octave.
 */
export function fingerNumbers(holes, register = 1) {
  const run = (from) => {
    let n = from;
    while (n < 6 && holes[n] === 'X') n++;
    const half = holes[n] === 'H';
    const rest = holes.slice(n + (half ? 1 : 0));
    return /^O*$/.test(rest) ? `${n - from}${half ? '½' : ''}` : null;
  };
  let s = holes[0] === 'O' ? (run(1) === '0' ? '0' : run(1) && `0/${run(1)}`) : run(0);
  if (!s) {
    // not a simple run from the top: list the held holes instead
    s = [...holes].map((c, i) => (c === 'X' ? i + 1 : c === 'H' ? `${i + 1}½` : '')).join('') || '0';
  }
  // A 0/ fingering is already the high note, so it never takes an octave mark.
  return s + (s.startsWith('0/') ? '' : octaveMark(register));
}

/** ' for the second (high) octave, '' for the third. */
export const octaveMark = (register) => (register === 3 ? "''" : register === 2 ? "'" : '');

/** The octave mark actually written for a fingering ('' for 0/ fingerings). */
export const markFor = (holes, register) => (fingerNumbers(holes).startsWith('0/') ? '' : octaveMark(register));

// ------------------------------------------------------------ note names

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const DIATONIC_PC = [0, 2, 4, 5, 7, 9, 11];

const mod = (n, m) => ((n % m) + m) % m;

/** Spell a note from abcjs's diatonic pitch number plus the actual MIDI value. */
function spell(diatonic, midi) {
  const letter = 'CDEFGAB'[mod(diatonic, 7)];
  const octave = 4 + Math.floor(diatonic / 7);
  const natural = 60 + 12 * Math.floor(diatonic / 7) + DIATONIC_PC[mod(diatonic, 7)];
  const diff = midi - natural;
  const acc = { '-2': 'bb', '-1': 'b', 0: '', 1: '#', 2: 'x' }[diff];
  if (acc === undefined) return { name: SHARP_NAMES[mod(midi, 12)], octave: Math.floor(midi / 12) - 1 };
  return { name: letter + acc, octave };
}

// ------------------------------------------------------------ key / chords

const MODES = {
  '': [0, 2, 4, 5, 7, 9, 11], maj: [0, 2, 4, 5, 7, 9, 11], ion: [0, 2, 4, 5, 7, 9, 11],
  m: [0, 2, 3, 5, 7, 8, 10], min: [0, 2, 3, 5, 7, 8, 10], aeo: [0, 2, 3, 5, 7, 8, 10],
  dor: [0, 2, 3, 5, 7, 9, 10], mix: [0, 2, 4, 5, 7, 9, 10], phr: [0, 1, 3, 5, 7, 8, 10],
  lyd: [0, 2, 4, 6, 7, 9, 11], loc: [0, 1, 3, 5, 6, 8, 10],
};

function keyInfo(key) {
  const root = key && key.root && key.root !== 'none' && key.root !== 'HP' ? key.root : 'C';
  const acc = key && key.acc === '#' ? 1 : key && key.acc === 'b' ? -1 : 0;
  const tonic = mod((LETTER_PC[root] ?? 0) + acc, 12);
  const modeKey = ((key && key.mode) || '').toLowerCase().slice(0, 3);
  const scale = MODES[modeKey] || MODES[''];
  const isMinor = scale[2] === 3;
  const flats = key && key.accidentals ? key.accidentals.some((a) => a.acc === 'flat') : false;
  const name = (root + (key && key.acc ? key.acc : '')) + (isMinor && ['m', 'min', 'aeo'].includes(modeKey) ? 'm' : modeKey && modeKey !== 'maj' && modeKey !== 'ion' ? ' ' + modeKey : '');
  return { tonic, scale, isMinor, flats, name };
}

const CHORD_RE = /^[A-G][#b♯♭]?(m|min|maj|M|dim|aug|sus|add|°|ø|\+|\d|\/|\(|\)|[#b♯♭])*$/;
export const isChordName = (s) => CHORD_RE.test(String(s).trim().replace(/\s+/g, ''));

function chordName(pc, quality, flats) {
  const n = (flats ? FLAT_NAMES : SHARP_NAMES)[mod(pc, 12)];
  return n + (quality === 'min' ? 'm' : quality === 'dim' ? 'dim' : '');
}

/** Diatonic triads for the key, each with a "prior" preference weight. */
function candidateChords(ki) {
  const out = [];
  for (let d = 0; d < 7; d++) {
    const r = ki.scale[d];
    const t = ki.scale[(d + 2) % 7] - r;
    const f = ki.scale[(d + 4) % 7] - r;
    const third = mod(t, 12);
    const fifth = mod(f, 12);
    const quality = third === 4 && fifth === 7 ? 'maj' : third === 3 && fifth === 7 ? 'min' : 'dim';
    if (quality === 'dim') continue;
    const prior = d === 0 ? 0.4 : d === 4 ? 0.35 : d === 3 ? 0.3 : 0.05;
    out.push({ root: mod(ki.tonic + r, 12), quality, degree: d, prior });
  }
  if (ki.isMinor) {
    // harmonic-minor dominant (E in A minor) is very common in folk tunes
    out.push({ root: mod(ki.tonic + 7, 12), quality: 'maj', degree: 4, prior: 0.2 });
  }
  return out.map((c) => ({
    ...c,
    tones: [c.root, mod(c.root + (c.quality === 'maj' ? 4 : 3), 12), mod(c.root + 7, 12)],
    name: chordName(c.root, c.quality, ki.flats),
  }));
}

function scoreChord(chord, notes, segBeats, beatsPerBar) {
  let s = 0;
  for (const n of notes) {
    if (n.midi == null) continue;
    const pc = mod(n.midi, 12);
    const strong = n.pos === 0 ? 2 : Math.abs(n.pos - beatsPerBar / 2) < 1e-6 ? 1.4 : Number.isInteger(n.pos) ? 1.1 : 0.8;
    const w = n.beats * strong;
    const idx = chord.tones.indexOf(pc);
    s += idx === 0 ? w * 1.0 : idx === 1 ? w * 0.95 : idx === 2 ? w * 0.9 : -w * 0.55;
  }
  return s + chord.prior * segBeats;
}

/** Choose a guitar chord (or two) for each measure from its melody notes. */
export function harmonize(data) {
  const ki = keyInfo(data.keySignature);
  const cands = candidateChords(ki);
  const barBeats = data.meter.num; // beats are counted in 1/den notes
  const best = (notes, segBeats, bias) => {
    let top = null;
    for (const c of cands) {
      const sc = scoreChord(c, notes, segBeats, barBeats) + (bias && c.degree === 0 && c.root === ki.tonic ? bias : 0);
      if (!top || sc > top.score) top = { chord: c, score: sc };
    }
    return top;
  };
  const result = [];
  const last = data.measures.length - 1;
  let prev = null;
  data.measures.forEach((m, mi) => {
    const sounding = m.items.filter((it) => it.type === 'note' || it.type === 'hold');
    if (!sounding.length) { result.push([]); return; }
    const total = m.items.reduce((a, it) => a + it.beats, 0);
    const bias = mi === 0 || mi === last ? total * 0.5 : 0;
    const whole = best(sounding, total, bias);
    let chosen = [{ name: whole.chord.name, at: m.items.indexOf(sounding[0]) }];
    // Split long bars (4/4, 6/8, 12/8 ...) in half when the halves clearly differ.
    const half = barBeats / 2;
    if (total >= barBeats - 1e-6 && barBeats >= 4 && (data.meter.num % 2 === 0)) {
      const a = sounding.filter((n) => n.pos < half - 1e-6);
      const b = sounding.filter((n) => n.pos >= half - 1e-6);
      if (a.length && b.length) {
        const ba = best(a, half, mi === 0 ? half * 0.5 : 0);
        const bb = best(b, half, mi === last ? half * 0.5 : 0);
        if (ba.chord.name !== bb.chord.name && ba.score + bb.score > whole.score + total * 0.3) {
          chosen = [
            { name: ba.chord.name, at: m.items.indexOf(a[0]) },
            { name: bb.chord.name, at: m.items.indexOf(b[0]) },
          ];
        }
      }
    }
    // Lead-sheet style: don't repeat a chord that is already sounding.
    if (chosen.length === 1 && prev === chosen[0].name && mi !== 0) {
      chosen[0].repeat = true;
    }
    prev = chosen[chosen.length - 1].name;
    result.push(chosen);
  });
  return result;
}

// ------------------------------------------------------------ analysis

/**
 * Walk a parsed/rendered abcjs tune and build the tab data model.
 * Returns { data, refs } where refs[i] = { item, el, line } for every item
 * (refs are not serialisable; data is the JSON stored on disk).
 */
export function analyzeTune(tune) {
  if (!tune.lines.some((l) => l.staff && l.staff[0].voices[0].some((e) => e.midiPitches))) {
    try { tune.setUpAudio(); } catch { /* rests-only or empty tune */ }
  }
  const meter = (tune.getMeterFraction && tune.getMeterFraction()) || { num: 4, den: 4 };
  const meta = tune.metaText || {};
  let keySignature = null;
  const measures = [];
  const refs = [];
  const newMeasure = () => ({ number: measures.length + 1, items: [], chords: [] });
  let cur = newMeasure();
  let pos = 0;
  let mult = 1;
  let prevMidi = null;

  const closeMeasure = () => {
    if (cur.items.length) {
      measures.push(cur);
      cur = newMeasure();
      cur.number = measures.length + 1;
    }
    pos = 0;
  };

  tune.lines.forEach((line, li) => {
    if (!line.staff) return;
    const staff = line.staff[0];
    if (!keySignature && staff.key) keySignature = staff.key;
    for (const el of staff.voices[0]) {
      if (el.el_type === 'bar') {
        const t = el.type || '';
        const hadItems = cur.items.length > 0;
        if (t.includes('right_repeat') || t === 'bar_dbl_repeat') cur.repeatEnd = true;
        if (t === 'bar_thin_thick' || t === 'bar_thin_thin') cur.endBar = t;
        closeMeasure();
        if (!hadItems && measures.length === 0) { /* leading bar line */ }
        if (t.includes('left_repeat') || t === 'bar_dbl_repeat') cur.repeatStart = true;
        if (el.startEnding) cur.ending = el.startEnding;
        continue;
      }
      if (el.el_type === 'key') { continue; }
      if (el.el_type !== 'note') continue;

      if (el.startTriplet) mult = el.tripletMultiplier || 1;
      const written = el.duration * mult;
      const beats = round(written * meter.den);
      let item;
      if (el.rest) {
        const invisible = el.rest.type === 'invisible' || el.rest.type === 'spacer';
        item = { type: 'rest', beats, invisible: invisible || undefined };
        prevMidi = null;
      } else if (el.midiPitches && el.midiPitches.length) {
        // Melody only: when several notes sound together, keep the highest.
        let topIdx = 0;
        el.midiPitches.forEach((p, i) => { if (p.pitch > el.midiPitches[topIdx].pitch) topIdx = i; });
        const midi = el.midiPitches[topIdx].pitch;
        const pitchObj = el.pitches[Math.min(topIdx, el.pitches.length - 1)] || el.pitches[el.pitches.length - 1];
        const sp = spell(pitchObj.pitch, midi);
        const f = whistleFingering(midi);
        item = {
          type: 'note',
          pitch: sp.name + sp.octave,
          name: sp.name,
          midi,
          beats,
          holes: f.holes,
          register: f.register,
        };
        if (f.octaveShift) item.octaveShift = f.octaveShift;
        if (f.halfHole) item.halfHole = true;
        if (f.cross) item.cross = true;
        if (f.hard) item.hard = true;
        if (el.pitches.some((p) => p.startTie)) item.tie = true;
        prevMidi = midi;
      } else {
        // Tied continuation (abcjs folds the sound into the previous note).
        item = { type: 'hold', beats, midi: prevMidi };
        if (el.pitches && el.pitches.some((p) => p.startTie)) item.tie = true;
      }
      if (mult !== 1) item.triplet = true;
      item.pos = round(pos);
      pos += beats;
      if (el.endTriplet) mult = 1;

      if (el.chord) {
        for (const c of el.chord) {
          if ((c.position === 'default' || !c.position) && isChordName(c.name)) {
            cur.chords.push({ name: c.name.trim(), at: cur.items.length, source: 'score' });
          }
        }
      }
      refs.push({ item, el, line: li, measureIndex: measures.length, itemIndex: cur.items.length });
      cur.items.push(item);
    }
  });
  closeMeasure();

  const ki = keyInfo(keySignature);
  const data = {
    title: meta.title || 'Untitled',
    composer: meta.composer || undefined,
    key: ki.name,
    keySignature: keySignature ? { root: keySignature.root, acc: keySignature.acc, mode: keySignature.mode, accidentals: keySignature.accidentals } : null,
    meter: { num: meter.num, den: meter.den },
    tempo: tempoText(tune.metaText && tune.metaText.tempo),
    measures,
  };
  return { data, refs };
}

const round = (x) => Math.round(x * 1000) / 1000;

/** Plain "1/4=100" text for a Q: field (abcjs's tempo object also holds drawing state). */
function tempoText(t) {
  if (!t || !t.bpm) return undefined;
  const beat = (t.duration || [0.25]).map((d) => {
    for (let den = 1; den <= 64; den *= 2) if (Math.abs(d * den - Math.round(d * den)) < 1e-9) return `${Math.round(d * den)}/${den}`;
    return String(d);
  }).join(' ');
  return `${beat}=${t.bpm}`;
}

/** Summary of how well a tune suits a D whistle. */
export function whistleStats(data, shift = 0) {
  let notes = 0, outOfRange = 0, halfHoles = 0, hard = 0, cross = 0;
  for (const m of data.measures) for (const it of m.items) {
    if (it.type !== 'note') continue;
    notes++;
    const midi = it.midi + shift;
    if (midi < WHISTLE_MIN || midi > WHISTLE_MAX) { outOfRange++; continue; }
    const f = whistleFingering(midi);
    if (f.halfHole) halfHoles++;
    if (f.cross) cross++;
    if (f.hard) hard++;
  }
  return { notes, outOfRange, halfHoles, cross, hard };
}

/** Find the transposition (semitones) that makes the tune easiest on a D whistle. */
export function bestTranspose(data) {
  let best = null;
  for (let n = -12; n <= 12; n++) {
    const s = whistleStats(data, n);
    const penalty = s.outOfRange * 10 + s.halfHoles * 1.5 + s.cross * 0.5 + s.hard * 1 + Math.abs(n) * 0.05;
    if (!best || penalty < best.penalty) best = { shift: n, penalty, stats: s };
  }
  return best;
}

// ------------------------------------------------------------ ABC building

/** Strip a leading/trailing code fence and prose that models sometimes add. */
export function cleanAbc(text) {
  let t = String(text || '').replace(/\r\n/g, '\n');
  const fence = t.match(/```(?:abc)?\s*\n([\s\S]*?)```/);
  if (fence) t = fence[1];
  const x = t.search(/^X:/m);
  if (x > 0) t = t.slice(x);
  return t.trim() + '\n';
}

/** Transpose ABC text by semitones (also rewrites K: and chord symbols). */
export function transposeAbc(abc, steps) {
  if (!steps) return abc;
  const tunes = ABC().parseOnly(abc);
  return ABC().strTranspose(abc, tunes, steps);
}

/**
 * Produce the ABC actually displayed: transposed, with generated chords
 * inserted where needed. chordMode: 'auto' | 'score' | 'generate'.
 */
export function buildDisplayAbc(sourceAbc, { transpose = 0, chordMode = 'auto' } = {}) {
  let abc = transposeAbc(sourceAbc, transpose);
  const tune = ABC().parseOnly(abc)[0];
  if (!tune) return { abc, generated: false };
  const { data, refs } = analyzeTune(tune);
  const hasScoreChords = data.measures.some((m) => m.chords.length);
  const generate = chordMode === 'generate' || (chordMode === 'auto' && !hasScoreChords);
  if (!generate) return { abc, generated: false };

  const edits = []; // { at, remove, insert }
  if (hasScoreChords) {
    // remove printed chord symbols (but keep ^annotations)
    for (const r of refs) {
      if (!r.el.chord) continue;
      const slice = abc.slice(r.el.startChar, r.el.endChar);
      const re = /"([^"^_<>@][^"]*)"/g;
      let mm;
      while ((mm = re.exec(slice))) {
        if (isChordName(mm[1])) edits.push({ at: r.el.startChar + mm.index, remove: mm[0].length, insert: '' });
      }
    }
  }
  const plan = harmonize(data);
  const byMeasure = new Map();
  refs.forEach((r) => {
    const key = r.measureIndex + ':' + r.itemIndex;
    byMeasure.set(key, r);
  });
  plan.forEach((chords, mi) => {
    for (const c of chords) {
      if (c.repeat) continue;
      const r = byMeasure.get(mi + ':' + c.at);
      if (r) edits.push({ at: r.el.startChar, remove: 0, insert: `"${c.name}"` });
    }
  });
  edits.sort((a, b) => b.at - a.at || b.remove - a.remove);
  for (const e of edits) abc = abc.slice(0, e.at) + e.insert + abc.slice(e.at + e.remove);
  return { abc, generated: true };
}

/** Final JSON document describing the tab (stored as part of tune.json). */
export function tabDocument(data, { generatedChords }) {
  const measures = data.measures.map((m) => ({
    number: m.number,
    ...(m.repeatStart ? { repeatStart: true } : {}),
    ...(m.repeatEnd ? { repeatEnd: true } : {}),
    ...(m.ending ? { ending: m.ending } : {}),
    chords: m.chords.map((c) => ({ name: c.name, atItem: c.at, source: generatedChords ? 'generated' : 'score' })),
    items: m.items.map((it) => {
      const o = { type: it.type, beats: it.beats, pos: it.pos };
      if (it.type === 'note') {
        Object.assign(o, { pitch: it.pitch, fingers: fingerNumbers(it.holes, it.register), midi: it.midi, holes: it.holes, register: it.register });
        for (const k of ['octaveShift', 'halfHole', 'cross', 'hard']) if (it[k]) o[k] = it[k];
      }
      if (it.tie) o.tie = true;
      if (it.triplet) o.triplet = true;
      return o;
    }),
  }));
  return {
    instrument: 'D tin whistle',
    fingersLegend: "fingers = how many holes to hold down from the top (nearest the mouthpiece): 3 = holes 1-3. 0/N = top hole open, hold the next N holes (0/2 = holes 2-3). 0 = all open. ½ after the count = also half-cover the next hole. ' after it = blow harder (high octave); 0/ fingerings never take '.",
    holesLegend: 'holes = the same fingering as six symbols, top to bottom: X = covered, O = open, H = half-covered. register 2 = blow harder (high octave).',
    beatsUnit: `1/${data.meter.den} note`,
    key: data.key,
    meter: `${data.meter.num}/${data.meter.den}`,
    tempo: data.tempo,
    chordsUsed: [...new Set(measures.flatMap((m) => m.chords.map((c) => c.name)))],
    measures,
  };
}

/** Name of the key after transposing by n semitones (for menus). */
export function transposedKeyName(keySignature, n) {
  const ki = keyInfo(keySignature);
  const pc = mod(ki.tonic + n, 12);
  const minor = /m$/.test(ki.name);
  const names = minor ? ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'] : ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const mode = ki.name.includes(' ') ? ki.name.slice(ki.name.indexOf(' ')) : '';
  return names[pc] + mode;
}
