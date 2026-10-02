#!/usr/bin/env python3
"""Turn raw tin-whistle note recordings into playback samples.

    python3 scripts/prepare-samples.py [SRC_DIR] [OUT_DIR]   (default: notes public/sounds/whistle)

For each .wav in SRC_DIR (any name; the pitch is measured, not read from the name):
  - mix to mono, trim the silence before the note, even out the loudness,
  - measure the sounding pitch (fractional MIDI note),
  - pick a loop region in the steady part and bake in a crossfade so it loops without a click,
  - write OUT_DIR/<n>.wav (16-bit mono) and OUT_DIR/samples.json for the player.
No dependencies beyond the standard library.
"""
import glob, json, math, os, struct, sys, wave

SRC = sys.argv[1] if len(sys.argv) > 1 else 'notes'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'public/sounds/whistle'
TARGET_RMS = 0.2  # loudness of the steady part after normalizing


def read(path):
    w = wave.open(path)
    sr, ch, width, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
    if width != 2:
        sys.exit(f'{path}: only 16-bit WAV is supported')
    raw = struct.unpack(f'<{n * ch}h', w.readframes(n))
    return sr, [sum(raw[i:i + ch]) / (ch * 32768) for i in range(0, len(raw), ch)]


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
    body = x[steady:]
    gain = TARGET_RMS / rms(body)
    gain = min(gain, 0.95 / max(abs(v) for v in x))
    x = [v * gain for v in x]

    # pitch: median of three windows across the steady part
    n = 4096
    spots = [steady + int(f * (len(x) - steady - n)) for f in (0.1, 0.5, 0.9)]
    midi = sorted(pitch(x[s:s + n], sr) for s in spots)[1]

    # loop: steady start .. end, with a crossfade baked into the end of the loop
    ls = rising_zero(x, steady)
    le = rising_zero(x, len(x) - int(0.03 * sr))
    xf = min(int(0.08 * sr), (le - ls) // 3, ls)
    for i in range(xf):
        a = i / xf
        x[le - xf + i] = x[le - xf + i] * (1 - a) + x[ls - xf + i] * a
    x = x[:le]
    return x, midi, ls / sr, le / sr


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
    os.makedirs(OUT, exist_ok=True)
    for old in glob.glob(os.path.join(OUT, '*.wav')):
        os.remove(old)
    out = []
    for i, path in enumerate(files):
        sr, x = read(path)
        x, midi, ls, le = prepare(path, sr, x)
        name = f'{i + 1}.wav'
        write(os.path.join(OUT, name), sr, x)
        out.append({'file': name, 'midi': round(midi, 2), 'loopStart': round(ls, 4), 'loopEnd': round(le, 4), 'source': os.path.basename(path)})
        print(f'{os.path.basename(path):34s} -> {name:6s} midi {midi:6.2f}  {len(x) / sr:.2f}s  loop {ls:.2f}-{le:.2f}s')
    out.sort(key=lambda s: s['midi'])
    with open(os.path.join(OUT, 'samples.json'), 'w') as f:
        json.dump(out, f, indent=1)
        f.write('\n')


main()
