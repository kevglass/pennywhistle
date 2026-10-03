// "Download MP3": the tune as the player sounds it (tempo, instrument, guitar chords), rendered
// offline with the Web Audio API and encoded in the browser with lamejs.
import { renderTune } from './render.js';
import { loadScript } from './ui.js';

const KBPS = 192;
const BLOCK = 1152; // samples per MP3 frame

/** Float samples to 16-bit, scaled so the loudest peak sits just under full scale (-1 dB). */
function toInt16(channels) {
  let peak = 0;
  for (const d of channels) for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  const gain = peak ? (0.89 / peak) * 32767 : 0;
  return channels.map((d) => Int16Array.from(d, (x) => Math.round(x * gain)));
}

export async function downloadMp3(view, bpm, { chords = false, filename = 'whistle.mp3' } = {}) {
  const [buffer] = await Promise.all([renderTune(view, bpm, { chords }), loadScript('../vendor/lame.min.js')]);
  const [left, right] = toInt16([buffer.getChannelData(0), buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0)]);
  const enc = new window.lamejs.Mp3Encoder(2, buffer.sampleRate, KBPS);
  const parts = [];
  for (let i = 0; i < left.length; i += BLOCK) {
    const out = enc.encodeBuffer(left.subarray(i, i + BLOCK), right.subarray(i, i + BLOCK));
    if (out.length) parts.push(out);
    if (i % (BLOCK * 200) === 0) await new Promise((r) => setTimeout(r)); // keep the page responsive
  }
  parts.push(enc.flush());
  const url = URL.createObjectURL(new Blob(parts, { type: 'audio/mpeg' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
