#!/usr/bin/env python3
"""Turn raw tin-whistle note recordings into playback samples.

    python3 scripts/prepare-samples.py [--raw] [SRC_DIR] [OUT_DIR]
        default: notes -> public/sounds/whistle, or with --raw -> public/sounds/whistle-raw
    --raw skips the clean-up (noise, overtones, wobble) for comparison; it still trims,
    normalizes, retunes and loops.

For each .wav in SRC_DIR (any name; the pitch is measured, not read from the name):
mix to mono, trim the silence before the note and measure the sounding pitch; then
clean it: turn down the breath noise between the harmonics (keeping the attack's chiff),
tame overtones that are louder than a clean whistle's (they make an edgy, raspy note),
steady the loudness wobble in the held part, and normalize. Recordings that clip are
skipped (clipping sounds like distortion).

Then for every semitone the whistle plays (D5..D7), take the nearest recording and
retune it to the exact pitch with windowed-sinc resampling, so the browser plays it at
its natural speed (its own resampling is coarse and adds grit). Each file gets a loop in
its steady part, with end points matched by waveform and a short crossfade, for held notes.
Writes OUT_DIR/<midi>.wav (16-bit mono) and OUT_DIR/samples.json for the player.
No dependencies beyond the standard library.
"""
import cmath, glob, hashlib, json, math, os, struct, sys, wave

RAW = '--raw' in sys.argv
ARGS = [a for a in sys.argv[1:] if a != '--raw']
SRC = ARGS[0] if ARGS else 'notes'
OUT = ARGS[1] if len(ARGS) > 1 else 'public/sounds/whistle-raw' if RAW else 'public/sounds/whistle'
TARGET_RMS = 0.2  # loudness of the steady part after normalizing
LOW, HIGH = 74, 98  # sounding range of a D whistle: D5..D7
TAPS = 16  # resampling filter half-width, in input samples
NOISE_KEEP = 0.45  # level kept of the breath noise between harmonics (about -7 dB; breath sounds real)
STEADY = 0.4  # how much of the loudness wobble in the held part to remove (0..1)
# loudest allowed level of harmonics 2, 3, 4, 5+ relative to the fundamental, in dB
# (only extreme, edgy overtones are turned down; normal ones give the whistle its character)
HARMONIC_CEILING = [-8, -14, -24, -28]


def read(path):
    w = wave.open(path)
    sr, ch, width, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
    if width != 2:
        sys.exit(f'{path}: only 16-bit WAV is supported')
    raw = struct.unpack(f'<{n * ch}h', w.readframes(n))
    clipped = sum(1 for v in raw if abs(v) >= 32700)
    return sr, [sum(raw[i:i + ch]) / (ch * 32768) for i in range(0, len(raw), ch)], clipped


def rms(x):
    return math.sqrt(sum(v * v for v in x) / max(1, len(x)))


def pitch(x, sr):
    """Fractional MIDI note of the strongest partial in x (autocorrelation, then a fine scan)."""
    lo, hi = int(sr / 2600), int(sr / 450)
    cs = {lag: sum(x[i] * x[i + lag] for i in range(len(x) - lag)) for lag in range(lo, hi + 2)}
    top = max(cs[l] for l in range(lo + 1, hi + 1))
    lag = next(l for l in range(lo + 1, hi + 1) if cs[l] > 0.9 * top and cs[l] >= cs[l - 1] and cs[l] >= cs[l + 1])
    m0 = 69 + 12 * math.log2(sr / lag / 440)
    win = [v * (0.5 - 0.5 * math.cos(2 * math.pi * i / (len(x) - 1))) for i, v in enumerate(x)]

    def power(m):  # Goertzel
        k = 2 * math.pi * 440 * 2 ** ((m - 69) / 12) / sr
        c, s1, s2 = 2 * math.cos(k), 0.0, 0.0
        for v in win:
            s1, s2 = v + c * s1 - s2, s1
        return s1 * s1 + s2 * s2 - c * s1 * s2

    return max((m0 - 1.2 + i * 0.01 for i in range(241)), key=power)


def rising_zero(x, i):
    while i < len(x) - 1 and not (x[i] <= 0 < x[i + 1]):
        i += 1
    return i


def fft(a, inverse=False):
    """In-place iterative radix-2 FFT of a list of complex numbers."""
    n = len(a)
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            a[i], a[j] = a[j], a[i]
    size = 2
    sign = 1 if inverse else -1
    while size <= n:
        w = cmath.exp(sign * 2j * math.pi / size)
        for start in range(0, n, size):
            wk = 1
            for k in range(size // 2):
                u, v = a[start + k], a[start + k + size // 2] * wk
                a[start + k], a[start + k + size // 2] = u + v, u - v
                wk *= w
        size *= 2
    if inverse:
        for i in range(n):
            a[i] /= n
    return a


def harmonic_gains(x, sr, f0, steady):
    """Per-harmonic gains that bring overtones louder than HARMONIC_CEILING down to it."""
    n = 4096
    s = min(steady, max(0, len(x) - n))
    spec = fft([complex(x[s + i] * (0.5 - 0.5 * math.cos(2 * math.pi * i / (n - 1)))) for i in range(n)])
    binw = sr / n

    def level(h):
        c = round(h * f0 / binw)
        return max((abs(spec[k]) for k in range(max(1, c - 3), min(n // 2, c + 4))), default=1e-12) or 1e-12
    gains = {}
    base = level(1)
    for h in range(2, int(sr / 2 / f0) + 1):
        rel = 20 * math.log10(level(h) / base)
        ceiling = HARMONIC_CEILING[min(h, 5) - 2]
        gains[h] = min(1.0, 10 ** ((ceiling - rel) / 20))
    return gains


def denoise(x, sr, midi, steady):
    """Keep the harmonics of the note (taming overly loud overtones); turn the noise
    between them down to NOISE_KEEP. The first ~0.1 s keeps more of its noise so the
    attack still has its chiff."""
    f0 = 440 * 2 ** ((midi - 69) / 12)
    hg = harmonic_gains(x, sr, f0, steady)
    n, hop = 2048, 512
    win = [0.5 - 0.5 * math.cos(2 * math.pi * i / n) for i in range(n)]
    binw = sr / n
    near, tame = [], []  # per bin: closeness to a harmonic (0..1), and that harmonic's gain
    for k in range(n // 2 + 1):
        f = k * binw
        h = max(1, round(f / f0))
        tol = 2.5 * binw + 0.01 * h * f0
        d = abs(f - h * f0)
        near.append(1.0 if d <= tol else max(0.0, 1 - (d - tol) / binw))
        tame.append(hg.get(h, 1.0))
    pad = [0.0] * n
    y = pad + x + pad
    out = [0.0] * len(y)
    for start in range(0, len(y) - n, hop):
        t = (start + n / 2 - n) / sr  # frame centre, seconds into the note
        keep = 1.0 if t < 0.03 else NOISE_KEEP if t > 0.12 else 1.0 - (1.0 - NOISE_KEEP) * (t - 0.03) / 0.09
        spec = fft([complex(y[start + i] * win[i]) for i in range(n)])
        for k in range(n // 2 + 1):
            g = near[k] * tame[k] + (1 - near[k]) * keep
            spec[k] *= g
            if 0 < k < n // 2:
                spec[n - k] *= g
        frame = fft(spec, inverse=True)
        for i in range(n):
            out[start + i] += frame[i].real * win[i] / 1.5  # Hann^2 at 75% overlap sums to 1.5
    return out[n:n + len(x)]


def steady_level(x, sr, steady):
    """Remove most of the loudness wobble after `steady`, fading the correction in."""
    hop, w = int(0.005 * sr), int(0.02 * sr)
    pts = list(range(0, len(x), hop))
    env = [rms(x[max(0, i - w // 2):i + w // 2]) or 1e-9 for i in pts]
    held = [e for i, e in zip(pts, env) if i >= steady]
    target = sum(held) / len(held)
    fade = int(0.05 * sr)
    out = []
    for i, v in enumerate(x):
        if i < steady:
            out.append(v)
            continue
        p = i / hop
        a = int(p)
        e = env[a] if a + 1 >= len(env) else env[a] + (env[a + 1] - env[a]) * (p - a)
        g = min(2.0, max(0.5, (target / e) ** STEADY))
        r = min(1.0, (i - steady) / fade)
        out.append(v * (1 + (g - 1) * r))
    return out


def prepare(path, sr, x):
    hop = sr // 100  # 10 ms envelope
    env = [rms(x[i:i + hop]) for i in range(0, len(x) - hop, hop)]
    peak = max(env)
    onset = next(i for i, e in enumerate(env) if e > 0.1 * peak)
    loud = [i for i, e in enumerate(env) if e > 0.5 * peak]
    start = max(0, (onset - 1) * hop)
    sus_end = loud[-1] * hop
    x = x[start:sus_end]

    # steady part: from 0.25 s in (past the attack) to the end of the loud part
    steady = int(0.25 * sr)
    if len(x) - steady < int(0.3 * sr):
        steady = len(x) // 3

    # pitch: median of three windows across the steady part
    n = 4096
    spots = [steady + int(f * (len(x) - steady - n)) for f in (0.1, 0.5, 0.9)]
    midi = sorted(pitch(x[s:s + n], sr) for s in spots)[1]

    if not RAW:
        x = steady_level(denoise(x, sr, midi, steady), sr, steady)
    gain = TARGET_RMS / rms(x[steady:])
    gain = min(gain, 0.95 / max(abs(v) for v in x))
    x = [v * gain for v in x]

    return x, midi, steady


def resample(x, step):
    """Read x at `step` input samples per output sample (step > 1 raises the pitch)."""
    fc = min(1.0, 1.0 / step)  # low-pass below the new Nyquist when speeding up
    half = TAPS / fc
    phases = 256
    # kernel table: windowed sinc sampled every 1/phases of an input sample
    size = int(math.ceil(half)) + 1
    table = []
    for i in range(size * phases + 1):
        d = i / phases
        if d >= half:
            table.append(0.0)
            continue
        sinc = 1.0 if d == 0 else math.sin(math.pi * fc * d) / (math.pi * fc * d)
        table.append(fc * sinc * (0.5 + 0.5 * math.cos(math.pi * d / half)))
    n_out = int((len(x) - 1) / step)
    span = int(math.ceil(half))
    out = [0.0] * n_out
    for j in range(n_out):
        t = j * step
        k0 = int(t)
        acc = 0.0
        for k in range(max(0, k0 - span + 1), min(len(x), k0 + span + 1)):
            acc += x[k] * table[int(abs(t - k) * phases + 0.5)]
        out[j] = acc
    return out


def add_loop(x, steady, sr, midi):
    """Loop steady..end; move the end to where the waveform best matches the start."""
    period = sr / (440 * 2 ** ((midi - 69) / 12))
    ls = rising_zero(x, steady)
    w = int(0.01 * sr)
    best, le = -2.0, len(x) - int(0.03 * sr)
    for cand in range(le - int(3 * period), le + 1):
        a, b = x[ls - w:ls], x[cand - w:cand]
        num = sum(p * q for p, q in zip(a, b))
        den = math.sqrt(sum(p * p for p in a) * sum(q * q for q in b)) or 1
        if num / den > best:
            best, end = num / den, cand
    xf = min(int(0.015 * sr), ls)
    for i in range(xf):
        g = i / xf
        x[end - xf + i] = x[end - xf + i] * (1 - g) + x[ls - xf + i] * g
    return x[:end], ls, end, best


def write(path, sr, x):
    w = wave.open(path, 'wb')
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes(struct.pack(f'<{len(x)}h', *(max(-32767, min(32767, round(v * 32767))) for v in x)))


def main():
    files = sorted(glob.glob(os.path.join(SRC, '*.wav')))
    if not files:
        sys.exit(f'no .wav files in {SRC}')
    notes = []
    for path in files:
        sr, x, clipped = read(path)
        name = os.path.basename(path)
        if clipped > 10:
            print(f'skip {name}: {clipped} clipped samples')
            continue
        x, midi, steady = prepare(path, sr, x)
        notes.append({'name': name, 'sr': sr, 'x': x, 'midi': midi, 'steady': steady})
        print(f'{name:34s} measured midi {midi:6.2f}')
    if not notes:
        sys.exit('no usable recordings')
    os.makedirs(OUT, exist_ok=True)
    for old in glob.glob(os.path.join(OUT, '*.wav')):
        os.remove(old)
    out = []
    for target in range(LOW, HIGH + 1):
        src = min(notes, key=lambda n: abs(n['midi'] - target))
        step = 2 ** ((target - src['midi']) / 12)
        sr = src['sr']
        y = resample(src['x'], step)
        y, ls, le, match = add_loop(y, int(src['steady'] / step), sr, target)
        name = f'{target}.wav'
        write(os.path.join(OUT, name), sr, y)
        with open(os.path.join(OUT, name), 'rb') as f:
            version = hashlib.sha1(f.read()).hexdigest()[:10]  # cache-buster for the player
        out.append({'file': name, 'v': version, 'midi': target, 'loopStart': round(ls / sr, 5), 'loopEnd': round(le / sr, 5), 'source': src['name']})
        print(f'{name:7s} from {src["name"]:32s} shift {target - src["midi"]:+5.2f} st  {len(y) / sr:.2f}s  loop match {match:.3f}')
    with open(os.path.join(OUT, 'samples.json'), 'w') as f:
        json.dump(out, f, indent=1)
        f.write('\n')


main()
