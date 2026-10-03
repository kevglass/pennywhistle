# Penny Whistle Tabs

Turn sheet music (PDF or photos/scans) into easy-to-follow **D tin whistle tablature** with **guitar chords**.

- Upload a PDF or image files. PDFs exported from **MuseScore 4** are read directly, with no AI: the notes come straight out of the PDF. Anything else (scans, photos, other programs' PDFs) is read by Claude, which transcribes the melody.
- The engraved score is shown with a whistle tab row under every line. Each note shows **how many holes to hold down from the top** (`3` = holes 1–3; `0/2` = top hole open, hold the next 2; `0` = all open; `'` after the number = blow harder for the high octave; `½` = also half-cover the next hole), or hole diagrams if you prefer, plus a bar for how long it lasts. Rests and tied notes are marked too.
- **Download PDF** gives the score with the number tab under every line and guitar chord diagrams. There's also a JSON download.
- Light mode by default, with a dark-mode toggle in the top bar.
- A thin player bar fixed to the top of the screen (play, tempo, tab style, and the selected note's fingering and chord) collapses to a small icon at the top left. **Play** and tapping a note use recordings of a real D tin whistle (see Credits). Works on phones and tablets.
- Click any note in the score (or in the tab) to highlight its fingering and see it enlarged with the guitar chord for that spot. The ← → keys step through the notes and **Play** plays the tune, following repeats.
- Chords come from the score when it prints them. Otherwise the app suggests chords that fit each bar.
- **Best key for whistle** finds a transposition that keeps every note in range with as little half-holing as possible.
- Approving a tab saves it to the **library** (the index page). Saved tunes can be opened later, with an optional **Show original music** panel beside the tab.
- **License check**: Claude searches the web to find out who wrote each tune, whether it is still under copyright, and whether it can be used for free in a game or video. Checks only run when you press a **Check** button, in the library's License column or under a tune's title (on your tunes or a friend's). Checking a friend's tune saves the result in their library too (the only change a friend can make to a tune). The library shows each tune's status (Free to use, Free with credit, Copyrighted or Unclear). Click the status, in the library or under a tune's title, to open a pop-up with the details: who wrote it and when, who owns the copyright, when it expired or will expire and how that was worked out, and the sources with what each one showed. This is research, not legal advice.
- **Users** (in the account menu, only for `ADMIN_EMAILS`): everyone who has signed in, how many tunes each has saved and when, with **Block uploads** / **Allow uploads**. A blocked account can't save new tunes or have Claude read music, but can still open, edit and delete its tunes.
- **Friends** (in the account menu): add a friend by email address and they get an email about the request, which they can accept or ignore on their friends page. Friends see each other's tunes in their library, in a section per friend, and can open them but not change them. Search covers every tune you can see.

## Hosting requirements

Any web host with **PHP 8.1+** (Apache or nginx). The pages are static HTML/JS. One small PHP endpoint saves tunes as files and calls the Claude API, which keeps the API key off the browser. No Node, no database and no build step on the server.

## Local development

```bash
composer install            # PHP packages (Anthropic SDK)
cp .env.example .env        # add ANTHROPIC_API_KEY (or: composer secrets:decrypt)
./dev.sh                    # PHP built-in server on http://localhost:6060 (PORT in .env)
```

Avoid ports browsers block as unsafe (e.g. 6000, 6665-6669). Without an API key the app still works: MuseScore PDFs are read without AI, and you can enter or paste ABC notation by hand.

| Setting (in `.env`) | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude API key used to read sheet music (server-side only) |
| `ANTHROPIC_WORKSPACE_ID` | Only for keys that must name a workspace |
| `CLAUDE_MODEL` | Defaults to `claude-opus-5-5` |
| `LICENSE_CHECKERS` | Comma-separated emails or `@domain`s allowed to run license checks (each costs API credits). Empty means nobody. Everyone else sees the results, and "Unknown" for unchecked tunes |
| `LICENSE_MODEL` | Model for license checks, defaults to `claude-sonnet-5-5`: as accurate as Opus on tricky tunes, for less. Haiku 4.5 was not accurate enough |
| `LICENSE_EFFORT` | Effort for license checks, defaults to `low` |
| `PORT` | Local dev server port (`./dev.sh`) |
| `DATA_DIR` | Where tunes are stored, defaults to `data/` next to the app code |
| `GOOGLE_CLIENT_ID` | Required: OAuth client ID for Google sign-in (see below) |
| `ADMIN_EMAILS` | Comma-separated emails or `@domain`s that get a **Users** page in the account menu: every registered user with how many tunes they've saved, and a button to block or allow them adding more. Empty means nobody |
| `ALLOWED_EMAILS` | Optional: comma-separated emails or `@domain`s allowed to sign in. Empty lets any Google account in, and transcriptions cost API credits |
| `SITE_URL` | Optional: the site's address for links in friend request emails, e.g. `https://cokeandcode.com/pennywhistle`. Otherwise taken from the server name |
| `MAIL_FROM` | Optional: sender address for friend request emails (sent with PHP's `mail()`), defaults to `noreply@<server name>` |
| `LEGACY_OWNER_EMAIL` | Optional: on this account's first sign-in, tunes saved before sign-in existed (`data/tunes/`) move into its library |

### Google sign-in

Everyone signs in with Google, and each Google account has its own tune library. To set it up:

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create an **OAuth client ID** of type **Web application**.
2. Under **Authorised JavaScript origins**, add `http://localhost:6060` (or your dev `PORT`) and `https://cokeandcode.com`. No redirect URIs are needed.
3. Put the client ID in `.env` as `GOOGLE_CLIENT_ID`.

The browser gets an ID token from Google on `login.html`; the server checks it with Google (audience, issuer, expiry, verified email) and then keeps a 30-day session cookie, scoped to `api/`. Sessions are files in `data/sessions/`.

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
pennywhistle/            public: index.html, login.html, editor.html, tune.html, js/, css/, vendor/, api/index.php
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

Each Google account has a folder, named by its Google account ID, and each approved tune is a folder inside it:

```
data/users/<google-id>/
  user.json        email and name of the account, last sign-in
  friends.json     friends (by Google ID) and friend requests this account has sent
  access.json      whether an admin has blocked this account from adding tunes
  tunes/<id>/
    tune.json        everything about the tune (see below)
    tune.abc         the displayed notation (after transposing and adding chords)
    original-1.pdf   the uploaded original(s): .pdf / .png / .jpg …
data/friend-requests/<sha256 of email>.json   requests waiting for that address
```

Friend requests are filed by email address, so they can be sent to someone who hasn't signed in yet. Accepting one adds each person to the other's `friends.json`.

`tune.json` holds the title, settings, the approved ABC transcription, and a `tab` object. That object has the key, the meter, the chords used, and every bar's chords and notes. Each note has its pitch, `fingers` (the number tab, e.g. `3`, `0/2` or `5'`), MIDI number, length in beats, whistle `holes` (top to bottom, `X` = covered, `O` = open, `H` = half-covered) and `register` (2 = blow harder). After a license check there is also a `license` object: `status` (`free`, `attribution`, `restricted` or `unknown`), `copyright` (`active`, `expired`, `traditional` or `unknown`), the license name, composer, when it was written, when the composer died, rights holder, `copyrightExpires` (year) and `copyrightBasis` (how that was worked out), summary, conditions, notes, confidence, `sources` (title, URL and what each showed), and when it was checked and by which model. Back up or move the `data/` folder to keep the library.

## Code map

- `public/`: the static site. `js/core.js` holds the fingering chart, tab data, chord suggestion and best-key search. `js/render.js` draws the score with [abcjs](https://www.abcjs.net/) plus the tab rows, highlighting and playback. PDFs are rendered in the browser with [PDF.js](https://mozilla.github.io/pdf.js/). Both libraries are bundled in `public/vendor/`.
- `public/api/index.php` → `app/api.php`: the API (`?r=config`, `auth/google`, `auth/me`, `auth/logout`, `tunes`, `tunes/<id>`, `tunes/<id>/files/<file>`, `tunes/<id>/delete`, `tunes/<id>/license`, `library`, `friends`, `friends/request|accept|ignore|cancel|remove`, `friends/<google-id>/tunes/<id>[/license]`, `admin/users`, `admin/users/<google-id>/uploads`, `transcribe`). Friend code is in `app/friends.php`, user admin in `app/admin.php`; the license check (Claude with web search and a JSON schema for the answer) is in `app/license.php`. Transcription streams from Claude through the official Anthropic PHP SDK, with server-side fallback if a request is declined.
- `app/omr/`: the MuseScore 4 PDF reader, in plain PHP. `pdf.php` parses the PDF and `content.php` runs each page's drawing commands to list the glyphs, lines and filled shapes. `musescore.php` rebuilds the music from them: MuseScore draws every notehead, rest, clef and accidental as a glyph of its SMuFL font (Leland) at an exact position, so pitch comes from a notehead's height on the staff and length from its shape plus the flags and beams on its stem. Text (titles, chord symbols, endings) uses Edwin, which MuseScore embeds without a character map; its glyphs are identified by their metrics using `edwin-metrics.json` (built by `scripts/edwin-metrics.py`). If the PDF isn't from MuseScore, or too many bars don't add up to the time signature, the API falls back to Claude.
- `scripts/secrets.php`, `deploy.sh`, `dev.sh`: tooling.
- `samples/`: public-domain and CC-licensed sheet music for testing (see `samples/README.md`).

Transcription accuracy depends on scan quality. Always compare the tab with the original (the editor shows them side by side) before approving.

## Credits

- Tin whistle playback samples: cut from *Báidín Fheilimí* played by **Jules Grandgagnage** ([Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Baidin_Feidhlimidh_tinwhistleD.ogg)), [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The sample files in `public/audio/` are CC BY-SA 4.0; see `public/audio/README.md`.
- Score engraving: [abcjs](https://www.abcjs.net/) (MIT). PDF rendering: [PDF.js](https://mozilla.github.io/pdf.js/) (Apache-2.0). PDF export: [jsPDF](https://github.com/parallax/jsPDF) and [svg2pdf.js](https://github.com/yWorks/svg2pdf.js) (MIT).
