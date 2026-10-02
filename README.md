# Penny Whistle Tabs

Turn sheet music (PDF or photos/scans) into easy-to-follow **D tin whistle tablature** with **guitar chords**.

- Upload a PDF or image files. Claude reads the music and transcribes the melody.
- The engraved score is shown with a whistle tab row under every line. Each note shows the **numbers of the holes to cover** (1 = top hole nearest the mouthpiece … 6 = bottom; `0` = all open, `+` = blow harder, `½` = half-cover), or hole diagrams if you prefer, plus a bar for how long it lasts. Rests and tied notes are marked too.
- Each saved tune has a **plain-text number tab** (guitar chords above the numbers, bar lines, note lengths, rests) to copy or download as `.txt`. There's also a print view and a JSON download.
- Click any note in the score (or in the tab) to highlight its fingering and see it enlarged with the guitar chord for that spot. The ← → keys step through the notes and **Play** plays the tune, following repeats.
- Chords come from the score when it prints them. Otherwise the app suggests chords that fit each bar.
- **Best key for whistle** finds a transposition that keeps every note in range with as little half-holing as possible.
- Approving a tab saves it to the **library** (the index page). Saved tunes can be opened later, with an optional **Show original music** panel beside the tab.

## Hosting requirements

Any web host with **PHP 8.1+** (Apache or nginx). The pages are static HTML/JS. One small PHP endpoint saves tunes as files and calls the Claude API, which keeps the API key off the browser. No Node, no database and no build step on the server.

## Local development

```bash
composer install            # PHP packages (Anthropic SDK)
cp .env.example .env        # add ANTHROPIC_API_KEY (or: composer secrets:decrypt)
./dev.sh                    # PHP built-in server on http://localhost:6060 (PORT in .env)
```

Avoid ports browsers block as unsafe (e.g. 6000, 6665-6669). Without an API key the app still works: you can enter or paste ABC notation by hand.

| Setting (in `.env`) | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude API key used to read sheet music (server-side only) |
| `ANTHROPIC_WORKSPACE_ID` | Only for keys that must name a workspace |
| `CLAUDE_MODEL` | Defaults to `claude-opus-5-5` |
| `PORT` | Local dev server port (`./dev.sh`) |
| `DATA_DIR` | Where tunes are stored, defaults to `data/` next to the app code |
| `APP_PASSWORD` | Optional: requires HTTP Basic auth for the API (saving and reading music), since transcriptions cost API credits |

## Deploying

```bash
./deploy.sh             # or: ./deploy.sh --dry-run
```

The script:
1. Encrypts `.env` into `.env.enc` if `.env` has changed (it asks for your secrets password), or decrypts `.env.enc` if there is no `.env`.
2. Runs `composer install --no-dev` when Composer is available.
3. Uploads over SSH/rsync to `kevglass@cokeandcode.com:cokeandcode.com/pennywhistle`. Override with the `DEPLOY_HOST`, `DEPLOY_PATH` and `SITE_URL` environment variables.
4. Checks that `https://cokeandcode.com/pennywhistle/_private/.env` is **not** downloadable (it removes the file and stops if it is), and that the API is answering.

Server layout:

```
pennywhistle/            public: index.html, editor.html, tune.html, js/, css/, vendor/, api/index.php
pennywhistle/_private/   app/ (PHP code), vendor/ (Composer packages), .env, data/ (saved tunes)
```

`_private/` is blocked by `.htaccess` (Apache). On **nginx**, add `location ^~ /pennywhistle/_private/ { deny all; }`. Saved tunes in `_private/data` are never overwritten or deleted by a deploy. If uploads of large PDFs fail, raise `upload_max_filesize`/`post_max_size` (preset in `api/.user.ini` and `api/.htaccess`).

## Encrypted secrets

`.env` is git-ignored. An encrypted copy, `.env.enc` (Argon2id + XChaCha20-Poly1305 via libsodium), is committed instead:

```bash
composer secrets:encrypt   # .env -> .env.enc (asks for a password twice)
composer secrets:decrypt   # .env.enc -> .env (asks for the password)
```

Set `SECRETS_PASSWORD` to skip the prompt.

## Storage (no database)

Each approved tune is a folder:

```
data/tunes/<id>/
  tune.json        everything about the tune (see below)
  tune.txt         the plain-text number tab (what "Download tab (.txt)" gives you)
  tune.abc         the displayed notation (after transposing and adding chords)
  original-1.pdf   the uploaded original(s): .pdf / .png / .jpg …
```

`tune.json` holds the title, settings, the approved ABC transcription, and a `tab` object. That object has the key, the meter, the chords used, and every bar's chords and notes. Each note has its pitch, `fingers` (the number tab, e.g. `123` or `12345+`), MIDI number, length in beats, whistle `holes` (top to bottom, `X` = covered, `O` = open, `H` = half-covered) and `register` (2 = blow harder). Back up or move the `data/` folder to keep the library.

## Code map

- `public/`: the static site. `js/core.js` holds the fingering chart, tab data, chord suggestion and best-key search. `js/render.js` draws the score with [abcjs](https://www.abcjs.net/) plus the tab rows, highlighting and playback. PDFs are rendered in the browser with [PDF.js](https://mozilla.github.io/pdf.js/). Both libraries are bundled in `public/vendor/`.
- `public/api/index.php` → `app/api.php`: the API (`?r=config`, `tunes`, `tunes/<id>`, `tunes/<id>/files/<file>`, `tunes/<id>/delete`, `transcribe`). Transcription streams from Claude through the official Anthropic PHP SDK, with server-side fallback if a request is declined.
- `scripts/secrets.php`, `deploy.sh`, `dev.sh`: tooling.
- `samples/`: public-domain and CC-licensed sheet music for testing (see `samples/README.md`).

Transcription accuracy depends on scan quality. Always compare the tab with the original (the editor shows them side by side) before approving.
