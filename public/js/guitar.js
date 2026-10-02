// Guitar chord shapes (low E -> high e). 'x' = muted, 0 = open.

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

/** Frets for a chord name, or null when we don't know a shape. */
export function chordFrets(name) {
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

/** SVG chord box diagram. */
export function chordDiagramSVG(name) {
  const frets = chordFrets(name);
  const W = 74, H = 92, left = 14, top = 24, sx = 10, sy = 13, n = 5;
  if (!frets) {
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${name}"><text x="${W / 2}" y="14" text-anchor="middle" class="cd-name">${name}</text><text x="${W / 2}" y="55" text-anchor="middle" class="cd-muted">no diagram</text></svg>`;
  }
  const arr = frets.includes(',') ? frets.split(',') : frets.split('');
  const nums = arr.filter((f) => f !== 'x').map(Number);
  const max = Math.max(...nums, 0);
  const minPos = Math.min(...nums.filter((f) => f > 0), 99);
  const base = max > 4 ? minPos : 1;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Guitar chord ${name}">`;
  s += `<text x="${W / 2}" y="12" text-anchor="middle" class="cd-name">${name}</text>`;
  for (let i = 0; i < 6; i++) s += `<line x1="${left + i * sx}" y1="${top}" x2="${left + i * sx}" y2="${top + n * sy}" class="cd-line"/>`;
  for (let j = 0; j <= n; j++) s += `<line x1="${left}" y1="${top + j * sy}" x2="${left + 5 * sx}" y2="${top + j * sy}" class="${j === 0 && base === 1 ? 'cd-nut' : 'cd-line'}"/>`;
  if (base > 1) s += `<text x="${left + 5 * sx + 4}" y="${top + sy - 3}" class="cd-fret">${base}fr</text>`;
  arr.forEach((f, i) => {
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
