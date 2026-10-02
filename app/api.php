<?php
// Penny Whistle Tabs API (PHP). Stores approved tunes as plain files under DATA_DIR
// (default ../data, outside the web root) and proxies transcription to Claude so the
// API key never reaches the browser. Routed via public/api/index.php?r=<route>.
declare(strict_types=1);

use Anthropic\Client;
use Anthropic\Core\Exceptions\APIConnectionException;
use Anthropic\Core\Exceptions\APIStatusException;
use Anthropic\Core\Exceptions\AuthenticationException;
use Anthropic\Core\Exceptions\RateLimitException;

const PROJECT_ROOT = __DIR__ . '/..';

require PROJECT_ROOT . '/vendor/autoload.php';
require __DIR__ . '/claude.php';

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

$DATA = rtrim(env('DATA_DIR', PROJECT_ROOT . '/data'), '/');
define('TUNES_DIR', $DATA . '/tunes');
define('MODEL', env('CLAUDE_MODEL', 'claude-opus-5-5'));
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

function ensure_data_dir(): void
{
    if (!is_dir(TUNES_DIR) && !mkdir(TUNES_DIR, 0775, true) && !is_dir(TUNES_DIR)) {
        throw new HttpError('Cannot create the data folder; check permissions on ' . dirname(TUNES_DIR), 500);
    }
    // In case DATA_DIR ends up inside the web root, keep it private on Apache.
    $ht = dirname(TUNES_DIR) . '/.htaccess';
    if (!file_exists($ht)) @file_put_contents($ht, "Require all denied\nDeny from all\n");
}

function write_json_atomic(string $file, array $data): void
{
    $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
    file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    rename($tmp, $file);
}

function load_tune(string $id): ?array
{
    if (!valid_id($id)) return null;
    $file = TUNES_DIR . "/$id/tune.json";
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
        'createdAt' => $t['createdAt'], 'updatedAt' => $t['updatedAt'],
    ];
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


function transcribe(): never
{
    if (!has_key()) send_json(503, ['error' => 'Transcription is not configured: set ANTHROPIC_API_KEY in the server .env file.']);
    $body = read_json_body();
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

// ------------------------------------------------------------------ auth

function authorized(): bool
{
    $password = env('APP_PASSWORD');
    if ($password === '') return true;
    $given = $_SERVER['PHP_AUTH_PW'] ?? null;
    if ($given === null) {
        $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        if (str_starts_with($h, 'Basic ')) {
            $parts = explode(':', (string) base64_decode(substr($h, 6)), 2);
            $given = $parts[1] ?? '';
        }
    }
    return is_string($given) && hash_equals($password, $given);
}

// ------------------------------------------------------------------ router

function handle(): never
{
    if (!authorized()) {
        header('WWW-Authenticate: Basic realm="Penny Whistle Tabs"');
        send_json(401, ['error' => 'Authentication required']);
    }
    $route = trim((string) ($_GET['r'] ?? ''), '/');
    $parts = $route === '' ? [] : explode('/', $route);
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if ($route === 'config' && $method === 'GET') send_json(200, ['transcribe' => has_key(), 'model' => MODEL]);
    if ($route === 'transcribe' && $method === 'POST') transcribe();
    if (($parts[0] ?? '') !== 'tunes') send_json(404, ['error' => 'Not found']);
    ensure_data_dir();
    $id = $parts[1] ?? null;

    if ($id === null && $method === 'GET') {
        $out = [];
        foreach (glob(TUNES_DIR . '/*/tune.json') ?: [] as $file) {
            $t = load_tune(basename(dirname($file)));
            if ($t) $out[] = summary($t);
        }
        usort($out, fn ($a, $b) => strcmp((string) $b['updatedAt'], (string) $a['updatedAt']));
        send_json(200, $out);
    }

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

    $existing = $id !== null ? load_tune($id) : null;
    if (!$existing) send_json(404, ['error' => 'Tune not found']);
    $dir = TUNES_DIR . '/' . $existing['id'];
    $action = $parts[2] ?? '';

    if ($action === 'files' && isset($parts[3]) && $method === 'GET') {
        foreach ($existing['originals'] as $o) {
            if ($o['file'] === $parts[3] && is_file("$dir/{$o['file']}")) {
                header('Content-Type: ' . $o['type']);
                header('Content-Length: ' . filesize("$dir/{$o['file']}"));
                header('Cache-Control: private, max-age=3600');
                readfile("$dir/{$o['file']}");
                exit;
            }
        }
        send_json(404, ['error' => 'File not found']);
    }
    if ($action === '' && $method === 'GET') send_json(200, $existing);
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
