<?php
// Admin: the accounts in ADMIN_EMAILS see every registered user, how many tunes each has
// saved, and can stop (or let) them save new tunes. Whether accounts may add tunes until an
// admin decides otherwise is a site setting; a blocked account can ask for access, which
// emails the admins. Admins also see every saved tune whose license hasn't been checked, and
// (if they are also in LICENSE_CHECKERS) can check any of them. Stored as:
//   settings.json             {"uploadsBlockedByDefault": bool, "changedBy", "changedAt"}
//   users/<sub>/access.json   {"uploadsBlocked"?: bool, "changedBy", "changedAt", "requestedAt"?}
//                             no uploadsBlocked: the site default applies
declare(strict_types=1);

/** Only the accounts in ADMIN_EMAILS may manage users; nobody if it is empty. */
function is_admin(?array $user): bool
{
    return $user !== null && email_in_list((string) $user['email'], env('ADMIN_EMAILS'), false);
}

function access_file(string $sub): string
{
    return user_dir($sub) . '/access.json';
}

function load_access(string $sub): array
{
    return read_json_file(access_file($sub), []);
}

function settings_file(): string
{
    return DATA_ROOT . '/settings.json';
}

/** Whether accounts an admin hasn't decided on are kept from adding tunes. */
function uploads_blocked_by_default(): bool
{
    return (bool) (read_json_file(settings_file(), [])['uploadsBlockedByDefault'] ?? false);
}

/** Whether this account may not add tunes (save new ones or read music with Claude): an admin's choice, else the site default (which never blocks admins). */
function uploads_blocked(string $sub): bool
{
    $blocked = load_access($sub)['uploadsBlocked'] ?? null;
    if (is_bool($blocked)) return $blocked;
    return uploads_blocked_by_default() && !is_admin(user_info($sub));
}

/** When this blocked account asked for upload access, if it has. */
function upload_requested_at(string $sub): ?string
{
    return load_access($sub)['requestedAt'] ?? null;
}

/** A blocked account asks to add tunes: remember it for the Users page and email the admins (once per request). */
function request_upload_access(array $user): array
{
    $sub = $user['sub'];
    if (!uploads_blocked($sub)) throw new HttpError('You can already add tunes.', 409);
    $access = load_access($sub);
    if (!isset($access['requestedAt'])) {
        $access['requestedAt'] = gmdate('Y-m-d\TH:i:s\Z');
        write_json_atomic(access_file($sub), $access);
        send_upload_request_email($user);
    }
    return ['requestedAt' => $access['requestedAt']];
}

function send_upload_request_email(array $from): void
{
    // Only whole addresses can be mailed; @domain entries are skipped.
    $to = array_filter(array_map('trim', explode(',', env('ADMIN_EMAILS'))), fn ($e) => filter_var($e, FILTER_VALIDATE_EMAIL));
    if (!$to) return;
    $oneLine = fn (string $s) => trim((string) preg_replace('/[\r\n]+/', ' ', $s));
    $who = $from['name'] !== $from['email'] ? $oneLine($from['name']) . " ({$from['email']})" : $from['email'];
    $subject = "$who asked to add tunes on Penny Whistle Tabs";
    $body = "Hello,\n\n"
        . "$who can't add tunes on Penny Whistle Tabs and has asked for upload access.\n\n"
        . "To review the request, open the Users page:\n"
        . site_url() . "/users.html\n";
    if (!send_mail(implode(', ', $to), $subject, $body)) error_log("upload request email for {$from['email']} could not be sent");
}

/** Every account that has signed in, with its tune count: those asking for access first, then most tunes first. */
function list_users(): array
{
    $out = [];
    foreach (glob(DATA_ROOT . '/users/*/user.json') ?: [] as $file) {
        $sub = basename(dirname($file));
        $info = user_info($sub);
        if (!$info) continue;
        $u = read_json_file($file, []);
        $tunes = glob(user_dir($sub) . '/tunes/*/tune.json') ?: [];
        $latest = $tunes ? max(array_map('filemtime', $tunes)) : null;
        $access = load_access($sub);
        $out[] = $info + [
            'tunes' => count($tunes),
            'lastTuneAt' => $latest ? gmdate('Y-m-d\TH:i:s\Z', $latest) : null,
            'lastLogin' => $u['lastLogin'] ?? null,
            'uploadsBlocked' => uploads_blocked($sub),
            'uploadsDefault' => !is_bool($access['uploadsBlocked'] ?? null),
            'requestedAt' => $access['requestedAt'] ?? null,
            'admin' => email_in_list($info['email'], env('ADMIN_EMAILS'), false),
        ];
    }
    usort($out, fn ($a, $b) => [$b['requestedAt'] !== null, $b['tunes'], (string) $b['lastLogin']] <=> [$a['requestedAt'] !== null, $a['tunes'], (string) $a['lastLogin']]);
    return $out;
}

/**
 * Every saved tune, in any library, whose license hasn't been checked: one entry per piece (a check
 * covers every copy), with who uploaded each copy. Newest first.
 */
function unchecked_tunes(): array
{
    $pieces = [];
    foreach (glob(DATA_ROOT . '/users/*/tunes/*/tune.json') ?: [] as $file) {
        $t = json_decode((string) file_get_contents($file), true);
        if (!is_array($t) || !isset($t['id']) || !empty($t['license']['checkedAt'])) continue;
        $sub = basename(dirname($file, 3));
        $owner = user_info($sub);
        $copy = ['sub' => $sub, 'id' => $t['id'], 'name' => $owner['name'] ?? '', 'email' => $owner['email'] ?? '', 'createdAt' => $t['createdAt'] ?? null];
        $piece = piece_of($t);
        foreach ($pieces as $i => $p) {
            if (pieces_match($piece, $p['piece'])) {
                $pieces[$i]['copies'][] = $copy;
                continue 2;
            }
        }
        $pieces[] = ['piece' => $piece, 'title' => $t['title'] ?? 'Untitled', 'composer' => $t['composer'] ?? null, 'key' => $t['tab']['key'] ?? null, 'copies' => [$copy]];
    }
    $out = [];
    foreach ($pieces as $p) {
        usort($p['copies'], fn ($a, $b) => strcmp((string) $a['createdAt'], (string) $b['createdAt']));
        unset($p['piece']);
        $out[] = $p + ['createdAt' => end($p['copies'])['createdAt']];
    }
    usort($out, fn ($a, $b) => strcmp((string) $b['createdAt'], (string) $a['createdAt']));
    return $out;
}

function admin_overview(): array
{
    return ['uploadsBlockedByDefault' => uploads_blocked_by_default(), 'users' => list_users()];
}

/**
 * Routes under admin/: users (GET), users/<sub>/uploads (POST {"blocked": bool}, or {"blocked": null}
 * for the site default), settings (POST {"uploadsBlockedByDefault": bool}). Each answers with admin_overview().
 * Also licenses (GET: unchecked_tunes()) and tunes/<sub>/<id>/license (POST {"again"?}: check any user's tune).
 */
function handle_admin(array $user, array $parts, string $method): never
{
    if (!is_admin($user)) send_json(403, ['error' => 'Only the site owner can manage users.']);
    $stamp = ['changedBy' => $user['email'], 'changedAt' => gmdate('Y-m-d\TH:i:s\Z')];
    if (($parts[1] ?? '') === 'users' && !isset($parts[2]) && $method === 'GET') send_json(200, admin_overview());
    if (($parts[1] ?? '') === 'users' && ($parts[3] ?? '') === 'uploads' && $method === 'POST') {
        $sub = (string) ($parts[2] ?? '');
        if (!user_info($sub)) send_json(404, ['error' => 'User not found']);
        $body = read_json_body();
        if (!array_key_exists('blocked', $body) || !(is_bool($body['blocked']) || $body['blocked'] === null)) {
            throw new HttpError('blocked (true, false or null) is required', 400);
        }
        // Deciding answers any pending request.
        write_json_atomic(access_file($sub), ($body['blocked'] === null ? [] : ['uploadsBlocked' => $body['blocked']]) + $stamp);
        send_json(200, admin_overview());
    }
    if (($parts[1] ?? '') === 'licenses' && !isset($parts[2]) && $method === 'GET') send_json(200, ['tunes' => unchecked_tunes()]);
    if (($parts[1] ?? '') === 'tunes' && isset($parts[3]) && ($parts[4] ?? '') === 'license' && $method === 'POST') {
        $owner = (string) $parts[2];
        $tune = valid_sub($owner) ? load_tune(user_dir($owner) . '/tunes', (string) $parts[3]) : null;
        if (!$tune) send_json(404, ['error' => 'Tune not found']);
        license_check(user_dir($owner) . "/tunes/{$tune['id']}", $tune, $user);
    }
    if (($parts[1] ?? '') === 'settings' && !isset($parts[2]) && $method === 'POST') {
        $body = read_json_body();
        if (!is_bool($body['uploadsBlockedByDefault'] ?? null)) throw new HttpError('uploadsBlockedByDefault (true or false) is required', 400);
        write_json_atomic(settings_file(), ['uploadsBlockedByDefault' => $body['uploadsBlockedByDefault']] + $stamp);
        send_json(200, admin_overview());
    }
    send_json(404, ['error' => 'Not found']);
}
