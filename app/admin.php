<?php
// Admin: the accounts in ADMIN_EMAILS see every registered user, how many tunes each has
// saved, and can stop (or let) them save new tunes. Stored beside each user's other files:
//   users/<sub>/access.json   {"uploadsBlocked": bool, "changedBy", "changedAt"}
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

/** Whether an admin has stopped this account from adding tunes (saving new ones and reading music with Claude). */
function uploads_blocked(string $sub): bool
{
    return (bool) (read_json_file(access_file($sub), [])['uploadsBlocked'] ?? false);
}

/** Every account that has signed in, with its tune count, most tunes first. */
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
        $out[] = $info + [
            'tunes' => count($tunes),
            'lastTuneAt' => $latest ? gmdate('Y-m-d\TH:i:s\Z', $latest) : null,
            'lastLogin' => $u['lastLogin'] ?? null,
            'uploadsBlocked' => uploads_blocked($sub),
            'admin' => email_in_list($info['email'], env('ADMIN_EMAILS'), false),
        ];
    }
    usort($out, fn ($a, $b) => [$b['tunes'], (string) $b['lastLogin']] <=> [$a['tunes'], (string) $a['lastLogin']]);
    return $out;
}

/** Routes under admin/: users (GET), users/<sub>/uploads (POST {"blocked": bool}). */
function handle_admin(array $user, array $parts, string $method): never
{
    if (!is_admin($user)) send_json(403, ['error' => 'Only the site owner can manage users.']);
    if (($parts[1] ?? '') === 'users' && !isset($parts[2]) && $method === 'GET') send_json(200, list_users());
    if (($parts[1] ?? '') === 'users' && ($parts[3] ?? '') === 'uploads' && $method === 'POST') {
        $sub = (string) ($parts[2] ?? '');
        if (!user_info($sub)) send_json(404, ['error' => 'User not found']);
        $body = read_json_body();
        if (!is_bool($body['blocked'] ?? null)) throw new HttpError('blocked (true or false) is required', 400);
        write_json_atomic(access_file($sub), [
            'uploadsBlocked' => $body['blocked'],
            'changedBy' => $user['email'],
            'changedAt' => gmdate('Y-m-d\TH:i:s\Z'),
        ]);
        send_json(200, list_users());
    }
    send_json(404, ['error' => 'Not found']);
}
