<?php
// Penny Whistle Tabs API (PHP). Stores approved tunes as plain files under DATA_DIR
// (default ../data, outside the web root), one library per Google account, and proxies
// transcription to Claude so the API key never reaches the browser.
// Routed via public/api/index.php?r=<route>.
declare(strict_types=1);

use Anthropic\Client;
use Anthropic\Core\Exceptions\APIConnectionException;
use Anthropic\Core\Exceptions\APIStatusException;
use Anthropic\Core\Exceptions\AuthenticationException;
use Anthropic\Core\Exceptions\RateLimitException;

const PROJECT_ROOT = __DIR__ . '/..';

require PROJECT_ROOT . '/vendor/autoload.php';
require __DIR__ . '/claude.php';
require __DIR__ . '/license.php';
require __DIR__ . '/omr/musescore.php';
require __DIR__ . '/friends.php';

// ------------------------------------------------------------------ config

function load_env(string $file): void
{
    if (!is_readable($file)) return;
    foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        if (preg_match('/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/i', $line, $m) !== 1) continue;
        $value = trim($m[2]);
        if (preg_match('/^(["\'])(.*)\1$/', $value, $q) === 1) $value = $q[2];
        if (getenv($m[1]) === false || getenv($m[1]) === '') putenv("{$m[1]}={$value}");
    }
}
load_env(PROJECT_ROOT . '/.env');

function env(string $key, string $default = ''): string
{
    $v = getenv($key);
    return $v === false || $v === '' ? $default : $v;
}

define('DATA_ROOT', rtrim(env('DATA_DIR', PROJECT_ROOT . '/data'), '/'));
// TUNES_DIR (the signed-in user's library) is defined in handle() once the user is known.
define('MODEL', env('CLAUDE_MODEL', 'claude-opus-5-5'));
// License checks: Sonnet 5.5 at low effort was as accurate as Opus here for less (see app/license.php).
define('LICENSE_MODEL', env('LICENSE_MODEL', 'claude-sonnet-5-5'));
define('LICENSE_EFFORT', env('LICENSE_EFFORT', 'low'));
const UPLOAD_TYPES = ['application/pdf' => '.pdf', 'image/png' => '.png', 'image/jpeg' => '.jpg', 'image/gif' => '.gif', 'image/webp' => '.webp'];

function has_key(): bool
{
    return env('ANTHROPIC_API_KEY') !== '' || env('ANTHROPIC_AUTH_TOKEN') !== '';
}

// ------------------------------------------------------------------ helpers

final class HttpError extends Exception {}

function send_json(int $status, mixed $body): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function read_json_body(): array
{
    $raw = file_get_contents('php://input');
    $data = json_decode($raw === false || $raw === '' ? '{}' : $raw, true);
    if (!is_array($data)) throw new HttpError('Invalid JSON body', 400);
    return $data;
}

function valid_id(string $id): bool
{
    return preg_match('/^[a-z0-9][a-z0-9-]{0,80}$/', $id) === 1;
}

function slug(string $s): string
{
    $s = strtolower((string) preg_replace('/[^A-Za-z0-9]+/', '-', iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s) ?: $s));
    $s = substr(trim($s, '-'), 0, 50);
    return $s !== '' ? $s : 'tune';
}

function ensure_dir(string $dir): void
{
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
        throw new HttpError('Cannot create the data folder; check permissions on ' . DATA_ROOT, 500);
    }
    // In case DATA_DIR ends up inside the web root, keep it private on Apache.
    $ht = DATA_ROOT . '/.htaccess';
    if (!file_exists($ht)) @file_put_contents($ht, "Require all denied\nDeny from all\n");
}

function write_json_atomic(string $file, array $data): void
{
    $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
    file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    rename($tmp, $file);
}

function load_tune(string $tunesDir, string $id): ?array
{
    if (!valid_id($id)) return null;
    $file = "$tunesDir/$id/tune.json";
    if (!is_file($file)) return null;
    $t = json_decode((string) file_get_contents($file), true);
    return is_array($t) ? $t : null;
}

function summary(array $t): array
{
    return [
        'id' => $t['id'], 'title' => $t['title'], 'composer' => $t['composer'] ?? null,
        'key' => $t['tab']['key'] ?? null, 'meter' => $t['tab']['meter'] ?? null,
        'measures' => count($t['tab']['measures'] ?? []), 'chords' => $t['tab']['chordsUsed'] ?? [],
        'transpose' => $t['settings']['transpose'] ?? 0, 'hasOriginal' => !empty($t['originals']),
        'license' => $t['license'] ?? null, // in full: the library shows the details on click
        'createdAt' => $t['createdAt'], 'updatedAt' => $t['updatedAt'],
    ];
}

/** Summaries of every tune in a library folder, newest first. */
function list_tunes(string $tunesDir): array
{
    $out = [];
    foreach (glob("$tunesDir/*/tune.json") ?: [] as $file) {
        $t = load_tune($tunesDir, basename(dirname($file)));
        if ($t) $out[] = summary($t);
    }
    usort($out, fn ($a, $b) => strcmp((string) $b['updatedAt'], (string) $a['updatedAt']));
    return $out;
}

/** Send one of a tune's uploaded original files. */
function serve_original(string $dir, array $tune, string $name): never
{
    foreach ($tune['originals'] ?? [] as $o) {
        if ($o['file'] === $name && is_file("$dir/{$o['file']}")) {
            header('Content-Type: ' . $o['type']);
            header('Content-Length: ' . filesize("$dir/{$o['file']}"));
            header('Cache-Control: private, max-age=3600');
            readfile("$dir/{$o['file']}");
            exit;
        }
    }
    send_json(404, ['error' => 'File not found']);
}

/** Save uploaded original files (multipart field originals[]) into the tune folder. */
function save_originals(string $dir): array
{
    $f = $_FILES['originals'] ?? null;
    if (!$f || !is_array($f['name'])) return [];
    $saved = [];
    $n = 1;
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    foreach ($f['name'] as $i => $name) {
        if ($f['error'][$i] !== UPLOAD_ERR_OK) {
            if ($f['error'][$i] === UPLOAD_ERR_INI_SIZE || $f['error'][$i] === UPLOAD_ERR_FORM_SIZE) throw new HttpError('Original file is too large for this server (upload_max_filesize)', 413);
            continue;
        }
        $type = $finfo->file($f['tmp_name'][$i]) ?: '';
        if (!isset(UPLOAD_TYPES[$type])) continue;
        $file = 'original-' . $n++ . UPLOAD_TYPES[$type];
        move_uploaded_file($f['tmp_name'][$i], "$dir/$file");
        $saved[] = ['file' => $file, 'type' => $type, 'originalName' => mb_substr((string) $name, 0, 200)];
    }
    return $saved;
}

function tune_record(array $body, ?array $existing): array
{
    if (!is_string($body['abc'] ?? null) || !str_contains($body['abc'], 'K:')) throw new HttpError('abc notation (with a K: line) is required', 400);
    $now = gmdate('Y-m-d\TH:i:s.v\Z');
    $mode = $body['settings']['chordMode'] ?? 'auto';
    return array_filter([
        'id' => $existing['id'] ?? null,
        'title' => mb_substr((string) ($body['title'] ?? $existing['title'] ?? 'Untitled'), 0, 200),
        'composer' => isset($body['composer']) ? mb_substr((string) $body['composer'], 0, 200) : ($existing['composer'] ?? null),
        'approved' => true,
        'createdAt' => $existing['createdAt'] ?? $now,
        'updatedAt' => $now,
        'settings' => [
            'transpose' => (int) ($body['settings']['transpose'] ?? 0),
            'chordMode' => in_array($mode, ['auto', 'score', 'generate'], true) ? $mode : 'auto',
        ],
        'abc' => $body['abc'], // the approved transcription, as read from the original
        'displayAbc' => is_string($body['displayAbc'] ?? null) ? $body['displayAbc'] : null, // after transpose + chords
        'tab' => is_array($body['tab'] ?? null) ? $body['tab'] : null,
        'originals' => $existing['originals'] ?? [],
        'transcription' => $body['transcription'] ?? ($existing['transcription'] ?? null),
        'license' => $existing['license'] ?? null, // set only by the license check
    ], fn ($v) => $v !== null);
}

/** tune.abc (the displayed notation) beside tune.json. */
function save_side_files(string $dir, array $rec, array $meta): void
{
    file_put_contents("$dir/tune.abc", $rec['displayAbc'] ?? $rec['abc']);
    @unlink("$dir/tune.txt"); // text tab is no longer produced
}

function meta_from_request(): array
{
    // Saves arrive as multipart/form-data: a JSON "meta" field plus originals[] files.
    if (isset($_POST['meta'])) {
        $data = json_decode((string) $_POST['meta'], true);
        if (!is_array($data)) throw new HttpError('Invalid meta field', 400);
        return $data;
    }
    if (empty($_POST) && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0 && str_starts_with($_SERVER['CONTENT_TYPE'] ?? '', 'multipart/')) {
        throw new HttpError('Upload too large for this server (post_max_size)', 413);
    }
    return read_json_body();
}

// ------------------------------------------------------------------ transcription


/**
 * A single uploaded PDF exported from MuseScore 4 is read straight from its drawing commands
 * (app/omr/musescore.php): exact, instant and free. Returns null for anything else.
 */
function read_musescore_pdf(array $body): ?array
{
    $pdfs = is_array($body['pdfs'] ?? null) ? $body['pdfs'] : [];
    if (count($pdfs) !== 1 || (int) ($body['sourceCount'] ?? 1) !== 1) return null;
    $data = base64_decode((string) ($pdfs[0]['data'] ?? ''), true);
    if ($data === false || $data === '' || strlen($data) > 40 * 1024 * 1024) return null;
    try {
        return musescore_to_abc($data, pathinfo((string) ($pdfs[0]['name'] ?? ''), PATHINFO_FILENAME));
    } catch (Throwable $e) {
        error_log('musescore reader: ' . $e->getMessage());
        return null;
    }
}

function transcribe(): never
{
    $body = read_json_body();
    $score = read_musescore_pdf($body);
    if ($score !== null) {
        header('Content-Type: application/x-ndjson; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode(['type' => 'done', 'abc' => $score['abc'], 'model' => 'musescore-pdf', 'truncated' => false, 'warnings' => $score['warnings']], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
        exit;
    }
    if (!has_key()) send_json(503, ['error' => 'Only PDFs exported from MuseScore can be read on this server. Reading other music needs Claude: set ANTHROPIC_API_KEY in the server .env file.']);
    $pages = array_slice(is_array($body['pages'] ?? null) ? $body['pages'] : [], 0, 40);
    $content = transcription_content($pages, (string) ($body['hint'] ?? ''));
    if (!$content) send_json(400, ['error' => 'No usable page images']);

    // Stream NDJSON lines to the browser: status / delta / done / error.
    set_time_limit(600);
    ignore_user_abort(false);
    while (ob_get_level() > 0) ob_end_flush();
    header('Content-Type: application/x-ndjson; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Accel-Buffering: no'); // nginx: don't buffer the stream
    $write = function (array $obj): void {
        echo json_encode($obj, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
        flush();
    };

    $write(['type' => 'status', 'text' => 'Claude is reading the music…']);
    try {
        $client = new Client(apiKey: env('ANTHROPIC_API_KEY') ?: null);
        $stream = transcription_stream($client, MODEL, $content, env('ANTHROPIC_WORKSPACE_ID'));
        $text = '';
        $stopReason = null;
        $model = MODEL;
        foreach ($stream as $event) {
            switch ($event->type) {
                case 'message_start':
                    $model = $event->message->model ?: $model;
                    break;
                case 'content_block_start':
                    if ($event->contentBlock->type === 'thinking') $write(['type' => 'status', 'text' => 'Claude is studying the score…']);
                    if ($event->contentBlock->type === 'text') $write(['type' => 'status', 'text' => 'Writing out the notes…']);
                    break;
                case 'content_block_delta':
                    if ($event->delta->type === 'text_delta') {
                        // After a mid-stream fallback the new model continues the same text.
                        $text .= $event->delta->text;
                        $write(['type' => 'delta', 'text' => $event->delta->text]);
                    }
                    break;
                case 'message_delta':
                    $stopReason = $event->delta->stopReason ?? $stopReason;
                    break;
            }
        }
        if ($stopReason === 'refusal') {
            $write(['type' => 'error', 'message' => 'Claude declined to transcribe this file. Try a clearer scan, or enter the ABC manually.']);
        } else {
            $write(['type' => 'done', 'abc' => $text, 'model' => $model, 'truncated' => $stopReason === 'max_tokens']);
        }
    } catch (AuthenticationException) {
        $write(['type' => 'error', 'message' => "The server's Anthropic API key was rejected."]);
    } catch (RateLimitException) {
        $write(['type' => 'error', 'message' => 'Rate limited by the Claude API, please try again in a minute.']);
    } catch (APIStatusException $e) {
        error_log('transcribe error: ' . $e->getMessage());
        $write(['type' => 'error', 'message' => 'Claude API error: ' . $e->getMessage()]);
    } catch (APIConnectionException) {
        $write(['type' => 'error', 'message' => 'Could not reach the Claude API.']);
    } catch (Throwable $e) {
        error_log('transcribe error: ' . $e->getMessage());
        $write(['type' => 'error', 'message' => 'Transcription failed: ' . $e->getMessage()]);
    }
    exit;
}

// ------------------------------------------------------------------ license check

/** Research the tune's license with Claude and web search, and save it in tune.json (noting who asked). */
function license_check(string $dir, array $tune, array $user): never
{
    if (!has_key()) send_json(503, ['error' => 'License checks need Claude: set ANTHROPIC_API_KEY in the server .env file.']);
    if (!can_check_license($user)) send_json(403, ['error' => 'Only the site owner can check licenses.']);
    set_time_limit(300);
    ignore_user_abort(true); // keep the result even if the page is closed while Claude searches
    try {
        $client = new Client(apiKey: env('ANTHROPIC_API_KEY') ?: null);
        $license = check_license($client, LICENSE_MODEL, LICENSE_EFFORT, $tune, env('ANTHROPIC_WORKSPACE_ID'));
    } catch (AuthenticationException) {
        send_json(502, ['error' => "The server's Anthropic API key was rejected."]);
    } catch (RateLimitException) {
        send_json(429, ['error' => 'Rate limited by the Claude API, please try again in a minute.']);
    } catch (APIConnectionException) {
        send_json(502, ['error' => 'Could not reach the Claude API.']);
    } catch (Throwable $e) {
        error_log('license check error: ' . $e->getMessage());
        send_json(502, ['error' => 'License check failed: ' . $e->getMessage()]);
    }
    // Re-read the tune: it may have been edited while Claude was searching.
    $current = load_tune(dirname($dir), $tune['id']);
    if (!$current) send_json(404, ['error' => 'Tune not found']);
    $license['checkedBy'] = $user['name'] ?: $user['email'];
    $current['license'] = $license;
    write_json_atomic("$dir/tune.json", $current);
    send_json(200, $license);
}

// ------------------------------------------------------------------ auth (Google sign-in)

const SESSION_DAYS = 30;

/** Session cookie for the API folder only; sessions are files under DATA_DIR/sessions. */
function start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) return;
    $dir = DATA_ROOT . '/sessions';
    ensure_dir($dir);
    session_save_path($dir);
    session_name('pwtabs');
    ini_set('session.gc_maxlifetime', (string) (SESSION_DAYS * 86400));
    ini_set('session.use_strict_mode', '1');
    $https = ($_SERVER['HTTPS'] ?? '') !== '' && $_SERVER['HTTPS'] !== 'off'
        || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
    session_set_cookie_params([
        'lifetime' => SESSION_DAYS * 86400,
        'path' => rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? '/'), '/') . '/',
        'secure' => $https,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

/** The signed-in user, or null. Releases the session lock so long requests (transcription) don't block others. */
function current_user(): ?array
{
    if (!isset($_COOKIE['pwtabs'])) return null;
    start_session();
    $user = $_SESSION['user'] ?? null;
    if ($user === null) session_destroy(); // stale cookie: don't leave an empty session behind
    else session_write_close();
    return is_array($user) && valid_sub((string) ($user['sub'] ?? '')) ? $user : null;
}

/** Google's account id ("sub") names the user's data folder, so keep it path-safe. */
function valid_sub(string $sub): bool
{
    return preg_match('/^[A-Za-z0-9_-]{1,255}$/', $sub) === 1;
}

/** Whether an email matches a comma-separated list of emails and @domains (an empty list matches $ifEmpty). */
function email_in_list(string $email, string $list, bool $ifEmpty): bool
{
    $list = array_filter(array_map(fn ($s) => strtolower(trim($s)), explode(',', $list)));
    if (!$list) return $ifEmpty;
    $email = strtolower($email);
    foreach ($list as $allowed) {
        if ($allowed === $email || (str_starts_with($allowed, '@') && str_ends_with($email, $allowed))) return true;
    }
    return false;
}

function email_allowed(string $email): bool
{
    return email_in_list($email, env('ALLOWED_EMAILS'), true);
}

/** Only the accounts in LICENSE_CHECKERS may run license checks (they cost API credits); nobody if it is empty. */
function can_check_license(?array $user): bool
{
    return $user !== null && has_key() && email_in_list((string) $user['email'], env('LICENSE_CHECKERS'), false);
}

/** Check a Google ID token (from Sign in with Google) and return its claims. */
function verify_google_token(string $token): array
{
    $clientId = env('GOOGLE_CLIENT_ID');
    if ($clientId === '') throw new HttpError('Sign-in is not configured: set GOOGLE_CLIENT_ID in the server .env file.', 503);
    try {
        $res = (new \GuzzleHttp\Client(['timeout' => 10]))->get('https://oauth2.googleapis.com/tokeninfo', [
            'query' => ['id_token' => $token],
            'http_errors' => false,
        ]);
    } catch (Throwable $e) {
        error_log('google tokeninfo error: ' . $e->getMessage());
        throw new HttpError('Could not reach Google to check the sign-in. Please try again.', 502);
    }
    $c = json_decode((string) $res->getBody(), true);
    if ($res->getStatusCode() !== 200 || !is_array($c)) throw new HttpError('Google sign-in was not accepted. Please try again.', 401);
    $ok = ($c['aud'] ?? '') === $clientId
        && in_array($c['iss'] ?? '', ['accounts.google.com', 'https://accounts.google.com'], true)
        && (int) ($c['exp'] ?? 0) > time()
        && in_array($c['email_verified'] ?? '', ['true', true], true)
        && valid_sub((string) ($c['sub'] ?? ''));
    if (!$ok) throw new HttpError('Google sign-in was not accepted. Please try again.', 401);
    return $c;
}

function user_dir(string $sub): string
{
    return DATA_ROOT . '/users/' . $sub;
}

/** Tunes saved before sign-in existed (DATA_DIR/tunes) go to LEGACY_OWNER_EMAIL's library on their first sign-in. */
function adopt_legacy_tunes(array $user): void
{
    $owner = strtolower(trim(env('LEGACY_OWNER_EMAIL')));
    $legacy = DATA_ROOT . '/tunes';
    $mine = user_dir($user['sub']) . '/tunes';
    if ($owner === '' || $owner !== strtolower($user['email']) || !is_dir($legacy) || is_dir($mine)) return;
    if (!rename($legacy, $mine)) error_log("could not move $legacy to $mine");
}

function login(): never
{
    // A JSON content type can't be sent cross-site without a CORS preflight, which this API never grants.
    if (!str_starts_with($_SERVER['CONTENT_TYPE'] ?? '', 'application/json')) send_json(415, ['error' => 'Expected JSON']);
    $body = read_json_body();
    $claims = verify_google_token((string) ($body['credential'] ?? ''));
    $email = (string) $claims['email'];
    if (!email_allowed($email)) send_json(403, ['error' => "$email is not allowed to use this site."]);
    $user = [
        'sub' => (string) $claims['sub'],
        'email' => $email,
        'name' => mb_substr((string) ($claims['name'] ?? $email), 0, 200),
        'picture' => is_string($claims['picture'] ?? null) ? $claims['picture'] : null,
    ];
    $dir = user_dir($user['sub']);
    ensure_dir($dir);
    adopt_legacy_tunes($user);
    // Who owns each folder, for whoever looks after the server.
    write_json_atomic("$dir/user.json", $user + ['lastLogin' => gmdate('Y-m-d\TH:i:s\Z')]);

    start_session();
    session_regenerate_id(true);
    $_SESSION['user'] = $user;
    session_write_close();
    send_json(200, $user);
}

function logout(): never
{
    if (isset($_COOKIE['pwtabs'])) {
        start_session();
        $_SESSION = [];
        session_destroy();
        $p = session_get_cookie_params();
        setcookie('pwtabs', '', ['expires' => time() - 3600] + array_intersect_key($p, array_flip(['path', 'secure', 'httponly', 'samesite'])));
    }
    send_json(200, ['ok' => true]);
}

// ------------------------------------------------------------------ router

function handle(): never
{
    $route = trim((string) ($_GET['r'] ?? ''), '/');
    $parts = $route === '' ? [] : explode('/', $route);
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    // Public routes: everything else needs a signed-in Google user.
    if ($route === 'config' && $method === 'GET') send_json(200, ['transcribe' => has_key(), 'licenseCheck' => can_check_license(current_user()), 'model' => MODEL, 'googleClientId' => env('GOOGLE_CLIENT_ID')]);
    if ($route === 'auth/google' && $method === 'POST') login();
    if ($route === 'auth/logout' && $method === 'POST') logout();

    $user = current_user();
    if (!$user) send_json(401, ['error' => 'Please sign in', 'login' => true]);
    if ($route === 'auth/me' && $method === 'GET') send_json(200, $user + ['friendRequests' => friend_request_count($user)]);
    if ($route === 'transcribe' && $method === 'POST') transcribe();
    if (in_array($parts[0] ?? '', ['friends', 'library'], true)) handle_friends($user, $parts, $method);
    if (($parts[0] ?? '') !== 'tunes') send_json(404, ['error' => 'Not found']);
    define('TUNES_DIR', user_dir($user['sub']) . '/tunes');
    ensure_dir(TUNES_DIR);
    $id = $parts[1] ?? null;

    if ($id === null && $method === 'GET') send_json(200, list_tunes(TUNES_DIR));

    if ($id === null && $method === 'POST') {
        $meta = meta_from_request();
        $rec = tune_record($meta, null);
        $rec['id'] = slug($rec['title']) . '-' . bin2hex(random_bytes(3));
        $dir = TUNES_DIR . '/' . $rec['id'];
        mkdir($dir, 0775, true);
        $rec['originals'] = save_originals($dir);
        save_side_files($dir, $rec, $meta);
        write_json_atomic("$dir/tune.json", $rec);
        send_json(201, $rec);
    }

    $existing = $id !== null ? load_tune(TUNES_DIR, $id) : null;
    if (!$existing) send_json(404, ['error' => 'Tune not found']);
    $dir = TUNES_DIR . '/' . $existing['id'];
    $action = $parts[2] ?? '';

    if ($action === 'files' && isset($parts[3]) && $method === 'GET') serve_original($dir, $existing, $parts[3]);
    if ($action === '' && $method === 'GET') send_json(200, $existing);
    if ($action === 'license' && $method === 'POST') license_check($dir, $existing, $user);
    if ($action === '' && $method === 'POST') { // update (POST for compatibility with simple hosts)
        $meta = meta_from_request();
        $rec = tune_record($meta, $existing);
        $new = save_originals($dir);
        if ($new) {
            foreach ($existing['originals'] as $o) if (!in_array($o['file'], array_column($new, 'file'), true)) @unlink("$dir/{$o['file']}");
            $rec['originals'] = $new;
        }
        save_side_files($dir, $rec, $meta);
        write_json_atomic("$dir/tune.json", $rec);
        send_json(200, $rec);
    }
    if ($action === 'delete' && $method === 'POST') {
        foreach (glob("$dir/{,.}*", GLOB_BRACE) ?: [] as $f) if (is_file($f)) unlink($f);
        rmdir($dir);
        send_json(200, ['ok' => true]);
    }
    send_json(405, ['error' => 'Method not allowed']);
}

try {
    handle();
} catch (HttpError $e) {
    send_json($e->getCode() ?: 400, ['error' => $e->getMessage()]);
} catch (Throwable $e) {
    error_log((string) $e);
    send_json(500, ['error' => 'Server error']);
}
