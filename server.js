// Penny Whistle Tab server.
// - serves the static app in ./public
// - stores approved tunes as plain files under ./data/tunes/<id>/ (no database)
// - proxies sheet-music transcription to Claude so the API key stays on the server
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const TUNES = path.join(DATA, 'tunes');
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const PASSWORD = process.env.APP_PASSWORD || '';
const MAX_BODY = 80 * 1024 * 1024;

const VENDOR = {
  '/vendor/abcjs-basic-min.js': 'node_modules/abcjs/dist/abcjs-basic-min.js',
  '/vendor/pdf.min.mjs': 'node_modules/pdfjs-dist/build/pdf.min.mjs',
  '/vendor/pdf.worker.min.mjs': 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.ico': 'image/x-icon', '.abc': 'text/plain; charset=utf-8',
};
const UPLOAD_TYPES = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
let client = null;
// User-level keys (not scoped to a workspace) must name one with this header.
const WORKSPACE = process.env.ANTHROPIC_WORKSPACE_ID || '';
const claude = () => (client ??= new Anthropic(WORKSPACE ? { defaultHeaders: { 'anthropic-workspace-id': WORKSPACE } } : {}));

// ------------------------------------------------------------------ helpers

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Upload too large (80 MB max)'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}

const validId = (id) => /^[a-z0-9][a-z0-9-]{0,80}$/.test(id);
const slug = (s) => String(s || 'tune').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'tune';

async function writeJsonAtomic(file, obj) {
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, file);
}

async function loadTune(id) {
  if (!validId(id)) return null;
  try { return JSON.parse(await fs.readFile(path.join(TUNES, id, 'tune.json'), 'utf8')); }
  catch { return null; }
}

async function saveOriginals(dir, files = []) {
  const saved = [];
  let n = 1;
  for (const f of files) {
    const ext = UPLOAD_TYPES[f.type];
    if (!ext || typeof f.data !== 'string') continue;
    const name = `original-${n++}${ext}`;
    await fs.writeFile(path.join(dir, name), Buffer.from(f.data, 'base64'));
    saved.push({ file: name, type: f.type, originalName: String(f.name || name).slice(0, 200) });
  }
  return saved;
}

function summary(t) {
  return {
    id: t.id, title: t.title, composer: t.composer, key: t.tab?.key, meter: t.tab?.meter,
    measures: t.tab?.measures?.length || 0, chords: t.tab?.chordsUsed || [], transpose: t.settings?.transpose || 0,
    hasOriginal: Boolean(t.originals?.length), createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

// ------------------------------------------------------------------ API

async function listTunes() {
  await fs.mkdir(TUNES, { recursive: true });
  const dirs = await fs.readdir(TUNES, { withFileTypes: true });
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const t = await loadTune(d.name);
    if (t) out.push(summary(t));
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function tuneRecord(body, existing) {
  const now = new Date().toISOString();
  if (typeof body.abc !== 'string' || !body.abc.includes('K:')) throw Object.assign(new Error('abc notation (with a K: line) is required'), { status: 400 });
  return {
    id: existing?.id,
    title: String(body.title || existing?.title || 'Untitled').slice(0, 200),
    composer: body.composer ? String(body.composer).slice(0, 200) : existing?.composer,
    approved: true,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    settings: { transpose: Number(body.settings?.transpose) || 0, chordMode: ['auto', 'score', 'generate'].includes(body.settings?.chordMode) ? body.settings.chordMode : 'auto' },
    abc: body.abc, // the approved transcription, as read from the original
    displayAbc: typeof body.displayAbc === 'string' ? body.displayAbc : undefined, // after transpose + chords
    tab: body.tab && typeof body.tab === 'object' ? body.tab : undefined,
    originals: existing?.originals || [],
    transcription: body.transcription || existing?.transcription,
  };
}

const TRANSCRIBE_PROMPT = `Transcribe the melody in these sheet-music page images into ABC notation (standard 2.1). The result will be turned into penny-whistle tablature, so the rhythm and pitches must match the printed music exactly.

What to transcribe:
- The melody only: the top line of the top staff. In piano/vocal or band scores, use the vocal or lead melody line (the one with lyrics, if any). Ignore accompaniment staves, bass lines, and harmony notes; if two notes sound together in the melody, write only the top one.
- Every page belongs to the same piece, in order. If the pages clearly hold several separate tunes, transcribe only the first.

How to write it:
- Header lines: X:1, T: (the title as printed), C: (composer, if printed), M:, L: (choose 1/8 for most folk/dance tunes, 1/4 for slower songs), Q: (only if a tempo is printed), then K: last. K: must match the printed key signature, with the mode (e.g. K:Em, K:Ador) when the music is clearly not major.
- Write pitches exactly as written (no transposing), including accidentals; the key signature applies as in ABC.
- Keep exact note lengths, dotted notes, ties (-), triplets ((3abc), rests (z), and pickup (anacrusis) bars. Write multi-bar rests out as one rest per bar.
- Bar lines as printed, including repeats (|: :|), first and second endings ([1 [2) and double/final bars. Do not expand repeats. Put D.C./D.S./Fine/Coda instructions in quoted annotations like "^D.C. al Fine".
- Chord symbols: if guitar chord symbols are printed above the staff, put each one in double quotes immediately before the note it sits over, e.g. "G"B2 "D7"A2. Do not invent chords that are not printed.
- Leave out grace notes, ornaments, slurs, dynamics, fingering numbers, and lyrics.
- About four bars per line of ABC.

If something is unclear, make the most musical best guess and list each uncertainty on a % comment line at the end.

Reply with the ABC notation only: no explanation and no code fences.`;

async function transcribe(req, res) {
  if (!hasKey()) return send(res, 503, { error: 'Transcription is not configured: set ANTHROPIC_API_KEY on the server.' });
  const body = await readJson(req);
  const pages = Array.isArray(body.pages) ? body.pages.slice(0, 40) : [];
  if (!pages.length) return send(res, 400, { error: 'No pages supplied' });
  const content = [];
  pages.forEach((p, i) => {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(p.mediaType) || typeof p.data !== 'string') return;
    content.push({ type: 'text', text: `Page ${i + 1} of ${pages.length}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } });
  });
  if (!content.length) return send(res, 400, { error: 'No usable page images' });
  const hint = typeof body.hint === 'string' && body.hint.trim() ? `\n\nNote from the user about this music: ${body.hint.trim().slice(0, 1000)}` : '';
  content.push({ type: 'text', text: TRANSCRIBE_PROMPT + hint });

  // NDJSON stream: {"type":"delta","text":...} ... {"type":"done","abc":...}
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const write = (obj) => res.write(JSON.stringify(obj) + '\n');
  let stream;
  let aborted = false;
  res.on('close', () => { if (!res.writableFinished) { aborted = true; stream?.abort(); } });
  try {
    stream = claude().beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      // Retry on Anthropic's recommended fallback model if a safety classifier declines.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: 'You are an expert music engraver and transcriber who reads printed sheet music and writes precise ABC notation.',
      messages: [{ role: 'user', content }],
    });
    write({ type: 'status', text: 'Claude is reading the music…' });
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'thinking') write({ type: 'status', text: 'Claude is studying the score…' });
      if (event.type === 'content_block_start' && event.content_block.type === 'text') write({ type: 'status', text: 'Writing out the notes…' });
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') write({ type: 'delta', text: event.delta.text });
    }
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') {
      write({ type: 'error', message: 'Claude declined to transcribe this file. Try a clearer scan, or enter the ABC manually.' });
    } else {
      const abc = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      write({ type: 'done', abc, model: msg.model, truncated: msg.stop_reason === 'max_tokens', usage: msg.usage && { input: msg.usage.input_tokens, output: msg.usage.output_tokens } });
    }
  } catch (err) {
    if (!aborted) {
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      const message = err instanceof Anthropic.AuthenticationError ? 'The server\'s Anthropic API key was rejected.'
        : err instanceof Anthropic.RateLimitError ? 'Rate limited by the Claude API, please try again in a minute.'
        : err instanceof Anthropic.APIConnectionError ? 'Could not reach the Claude API.'
        : err instanceof Anthropic.APIError && err.error?.error?.message ? `Claude API error: ${err.error.error.message}`
        : err.message || 'Transcription failed';
      console.error('transcribe error', status || '', err.message);
      write({ type: 'error', message });
    }
  }
  res.end();
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (parts[1] === 'config' && method === 'GET') return send(res, 200, { transcribe: hasKey(), model: MODEL });
  if (parts[1] === 'transcribe' && method === 'POST') return transcribe(req, res);

  if (parts[1] !== 'tunes') return send(res, 404, { error: 'Not found' });
  const id = parts[2];

  if (!id && method === 'GET') return send(res, 200, await listTunes());

  if (!id && method === 'POST') {
    const body = await readJson(req);
    const rec = tuneRecord(body);
    rec.id = `${slug(rec.title)}-${crypto.randomBytes(3).toString('hex')}`;
    const dir = path.join(TUNES, rec.id);
    await fs.mkdir(dir, { recursive: true });
    rec.originals = await saveOriginals(dir, body.originals);
    await fs.writeFile(path.join(dir, 'tune.abc'), rec.displayAbc || rec.abc);
    await writeJsonAtomic(path.join(dir, 'tune.json'), rec);
    return send(res, 201, rec);
  }

  if (!validId(id || '')) return send(res, 404, { error: 'Not found' });
  const existing = await loadTune(id);
  if (!existing) return send(res, 404, { error: 'Tune not found' });
  const dir = path.join(TUNES, id);

  if (parts[3] === 'files' && parts[4] && method === 'GET') {
    const entry = existing.originals.find((o) => o.file === parts[4]);
    if (!entry) return send(res, 404, { error: 'File not found' });
    res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'private, max-age=3600' });
    return createReadStream(path.join(dir, entry.file)).pipe(res);
  }
  if (parts[3]) return send(res, 404, { error: 'Not found' });

  if (method === 'GET') return send(res, 200, existing);
  if (method === 'PUT') {
    const body = await readJson(req);
    const rec = tuneRecord(body, existing);
    if (Array.isArray(body.originals) && body.originals.length) {
      for (const o of existing.originals) await fs.rm(path.join(dir, o.file), { force: true });
      rec.originals = await saveOriginals(dir, body.originals);
    }
    await fs.writeFile(path.join(dir, 'tune.abc'), rec.displayAbc || rec.abc);
    await writeJsonAtomic(path.join(dir, 'tune.json'), rec);
    return send(res, 200, rec);
  }
  if (method === 'DELETE') {
    await fs.rm(dir, { recursive: true, force: true });
    return send(res, 200, { ok: true });
  }
  return send(res, 405, { error: 'Method not allowed' });
}

// ------------------------------------------------------------------ static

async function serveStatic(req, res, url) {
  let rel = VENDOR[url.pathname];
  let file;
  if (rel) file = path.join(ROOT, rel);
  else {
    const p = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  }
  if (!existsSync(file) || !(await fs.stat(file)).isFile()) return send(res, 404, 'Not found', 'text/plain');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': rel ? 'public, max-age=86400' : 'no-cache' });
  createReadStream(file).pipe(res);
}

function authorized(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  const [, b64] = h.split(' ');
  const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  const a = Buffer.from(pass), b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Penny Whistle Tabs"' });
      return res.end('Authentication required');
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
    return await serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
    else res.end();
  }
});

await fs.mkdir(TUNES, { recursive: true });
server.listen(PORT, () => {
  console.log(`Penny Whistle Tabs on http://localhost:${PORT}`);
  console.log(`Storing tunes in ${TUNES}`);
  if (!hasKey()) console.log('ANTHROPIC_API_KEY is not set: reading PDFs/images is disabled (manual ABC entry still works).');
});
