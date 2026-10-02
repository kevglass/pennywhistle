# Penny Whistle Tabs

Turn sheet music (PDF or photos/scans) into easy-to-follow **D tin whistle tablature** with **guitar chords**.

- Upload a PDF or image files. Claude reads the music and transcribes the melody.
- The engraved score is shown with a whistle-fingering row under every line. Each note shows its holes, whether to blow harder (+), and a bar for how long it lasts; rests and tied notes are marked too.
- Click any note in the score (or in the tab) to highlight its fingering and see it enlarged with the guitar chord for that spot. The ← → keys step through the notes and **Play** plays the tune, following repeats.
- Chords come from the score when it prints them. Otherwise the app suggests chords that fit each bar.
- **Best key for whistle** finds a transposition that keeps every note in range with as little half-holing as possible.
- Approving a tab saves it to the **library** (the index page). Saved tunes can be opened later, with an optional **Show original music** panel beside the tab.

## Running

```bash
npm install
cp .env.example .env        # then put your key in .env (or decrypt .env.enc, see below)
npm start                   # http://localhost:3000
```

Requires Node 22 or newer. Without an API key the app still works: you can enter or paste ABC notation by hand.

| Setting (in `.env`) | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude API key used to read sheet music (server-side only, never sent to the browser) |
| `ANTHROPIC_WORKSPACE_ID` | Only for keys that aren't scoped to a workspace |
| `CLAUDE_MODEL` | Defaults to `claude-opus-5-5` |
| `PORT` | Defaults to `3000` |
| `DATA_DIR` | Where tunes are stored, defaults to `./data` |
| `APP_PASSWORD` | Optional: puts the whole site behind HTTP Basic auth (recommended when hosting publicly, since transcriptions cost API credits) |

## Encrypted secrets

`.env` is git-ignored. An encrypted copy, `.env.enc` (scrypt + AES-256-GCM), is committed instead:

```bash
npm run secrets:encrypt   # .env -> .env.enc  (asks for a password twice)
npm run secrets:decrypt   # .env.enc -> .env  (asks for the password)
```

On a server, set `SECRETS_PASSWORD` to decrypt without a prompt: `SECRETS_PASSWORD=… npm run secrets:decrypt`.

## Storage (no database)

Each approved tune is a folder on disk:

```
data/tunes/<id>/
  tune.json        everything about the tune (see below)
  tune.abc         the displayed notation (after transposing and adding chords)
  original-1.pdf   the uploaded original(s): .pdf / .png / .jpg …
```

`tune.json` holds the title, settings, the approved ABC transcription, and a `tab` object. That object has the key, the meter, the chords used, and every bar's chords and notes. Each note has its pitch, MIDI number, length in beats, whistle `holes` (top to bottom, `X` = covered, `O` = open, `H` = half-covered) and `register` (2 = blow harder). Back up or move the `data/` folder to keep the library.

## How it works

- `server.js`: a dependency-light Node HTTP server. It serves `public/`, stores tunes in `data/`, and streams transcriptions from the Claude API (`/api/transcribe`), with automatic server-side fallback if a request is declined.
- `public/js/core.js`: fingering chart, tab data model, chord suggestion and best-key search.
- `public/js/render.js`: draws the score with [abcjs](https://www.abcjs.net/), adds the tab rows, handles note-to-fingering highlighting and playback.
- PDFs are rendered in the browser with [PDF.js](https://mozilla.github.io/pdf.js/). The page images are sent to Claude, which returns ABC notation. You can edit that notation in the editor before approving.

Transcription accuracy depends on scan quality. Always compare the tab with the original (the editor shows them side by side) before approving.
