<?php
// Friends: people who can see (but not change) each other's tune libraries.
// Stored as plain files under DATA_DIR, like everything else:
//   users/<sub>/friends.json              {"friends": [{"sub", "since"}], "sent": [{"email", "at"}]}
//   friend-requests/<sha256(email)>.json  {"email", "requests": [{"from": <sub>, "at"}]}
// Requests are filed by email address, so they can be sent before the other person has
// ever signed in; they see them on the friends page once they do.
declare(strict_types=1);

const MAX_PENDING_SENT = 50;

function norm_email(string $email): string
{
    return strtolower(trim($email));
}

function friends_file(string $sub): string
{
    return user_dir($sub) . '/friends.json';
}

function requests_file(string $email): string
{
    return DATA_ROOT . '/friend-requests/' . hash('sha256', norm_email($email)) . '.json';
}

function read_json_file(string $file, array $default): array
{
    if (!is_file($file)) return $default;
    $d = json_decode((string) file_get_contents($file), true);
    return is_array($d) ? $d + $default : $default;
}

function load_friends(string $sub): array
{
    return read_json_file(friends_file($sub), ['friends' => [], 'sent' => []]);
}

function save_friends(string $sub, array $f): void
{
    ensure_dir(user_dir($sub));
    write_json_atomic(friends_file($sub), ['friends' => array_values($f['friends']), 'sent' => array_values($f['sent'])]);
}

function load_requests(string $email): array
{
    return read_json_file(requests_file($email), ['email' => norm_email($email), 'requests' => []]);
}

function save_requests(string $email, array $r): void
{
    $file = requests_file($email);
    if (!$r['requests']) {
        @unlink($file);
        return;
    }
    ensure_dir(dirname($file));
    write_json_atomic($file, ['email' => norm_email($email), 'requests' => array_values($r['requests'])]);
}

/** Name, email and picture of a user, from the user.json written at each sign-in. */
function user_info(string $sub): ?array
{
    if (!valid_sub($sub)) return null;
    $u = read_json_file(user_dir($sub) . '/user.json', []);
    if (!is_string($u['email'] ?? null)) return null;
    return ['sub' => $sub, 'email' => $u['email'], 'name' => $u['name'] ?? $u['email'], 'picture' => $u['picture'] ?? null];
}

function is_friend(string $sub, string $other): bool
{
    return in_array($other, array_column(load_friends($sub)['friends'], 'sub'), true);
}

function friend_request_count(array $user): int
{
    return count(load_requests($user['email'])['requests']);
}

/** Changes touch two people's files, so they run one at a time under a lock. */
function with_friends_lock(callable $fn): mixed
{
    ensure_dir(DATA_ROOT);
    $h = fopen(DATA_ROOT . '/friends.lock', 'c');
    if ($h === false) throw new HttpError('Cannot write to the data folder; check permissions on ' . DATA_ROOT, 500);
    flock($h, LOCK_EX);
    try {
        return $fn();
    } finally {
        flock($h, LOCK_UN);
        fclose($h);
    }
}

/** Make $a and $b friends, and clear any requests between them in either direction. */
function make_friends(array $a, array $b): void
{
    $now = gmdate('Y-m-d\TH:i:s\Z');
    foreach ([[$a, $b], [$b, $a]] as [$me, $them]) {
        $f = load_friends($me['sub']);
        if (!in_array($them['sub'], array_column($f['friends'], 'sub'), true)) $f['friends'][] = ['sub' => $them['sub'], 'since' => $now];
        $f['sent'] = array_filter($f['sent'], fn ($s) => $s['email'] !== norm_email($them['email']));
        save_friends($me['sub'], $f);
        $r = load_requests($me['email']);
        $r['requests'] = array_filter($r['requests'], fn ($q) => $q['from'] !== $them['sub']);
        save_requests($me['email'], $r);
    }
}

function friends_overview(array $user): array
{
    $mine = load_friends($user['sub']);
    $friends = [];
    foreach ($mine['friends'] as $f) {
        $info = user_info($f['sub']);
        if ($info) $friends[] = $info + ['since' => $f['since']];
    }
    usort($friends, fn ($a, $b) => strcasecmp($a['name'], $b['name']));
    $incoming = [];
    foreach (load_requests($user['email'])['requests'] as $q) {
        $info = user_info($q['from']);
        if ($info) $incoming[] = $info + ['at' => $q['at']];
    }
    return ['friends' => $friends, 'incoming' => $incoming, 'sent' => array_values($mine['sent'])];
}

/** Returns 'sent', 'already-sent' or 'friends' (when they had already asked us). */
function send_friend_request(array $user, string $email): string
{
    $email = norm_email($email);
    if (strlen($email) > 254 || !filter_var($email, FILTER_VALIDATE_EMAIL)) throw new HttpError('Enter a valid email address', 400);
    if ($email === norm_email($user['email'])) throw new HttpError('That is your own email address', 400);
    if (!email_allowed($email)) throw new HttpError("$email is not allowed to sign in to this site, so they can't be a friend here.", 400);

    $status = with_friends_lock(function () use ($user, $email): string {
        $mine = load_friends($user['sub']);
        foreach ($mine['friends'] as $f) {
            if (norm_email(user_info($f['sub'])['email'] ?? '') === $email) throw new HttpError("You are already friends with $email", 409);
        }
        // They already asked us, so asking them back is the same as accepting.
        foreach (load_requests($user['email'])['requests'] as $q) {
            $them = user_info($q['from']);
            if ($them && norm_email($them['email']) === $email) {
                make_friends($user, $them);
                return 'friends';
            }
        }
        if (in_array($email, array_column($mine['sent'], 'email'), true)) return 'already-sent';
        if (count($mine['sent']) >= MAX_PENDING_SENT) throw new HttpError('You have too many friend requests waiting. Cancel some before sending more.', 429);
        $now = gmdate('Y-m-d\TH:i:s\Z');
        $mine['sent'][] = ['email' => $email, 'at' => $now];
        save_friends($user['sub'], $mine);
        $r = load_requests($email);
        $r['requests'][] = ['from' => $user['sub'], 'at' => $now];
        save_requests($email, $r);
        return 'sent';
    });
    if ($status === 'sent' && !send_friend_email($user, $email)) return 'sent-no-email';
    return $status;
}

function accept_friend(array $user, string $sub): void
{
    with_friends_lock(function () use ($user, $sub): void {
        $them = user_info($sub);
        if (!$them || !in_array($sub, array_column(load_requests($user['email'])['requests'], 'from'), true)) {
            throw new HttpError('That friend request is no longer there', 404);
        }
        make_friends($user, $them);
    });
}

/** Ignoring drops the request quietly: the sender still sees it as waiting. */
function ignore_friend(array $user, string $sub): void
{
    with_friends_lock(function () use ($user, $sub): void {
        $r = load_requests($user['email']);
        $r['requests'] = array_filter($r['requests'], fn ($q) => $q['from'] !== $sub);
        save_requests($user['email'], $r);
    });
}

function cancel_friend_request(array $user, string $email): void
{
    $email = norm_email($email);
    with_friends_lock(function () use ($user, $email): void {
        $mine = load_friends($user['sub']);
        $mine['sent'] = array_filter($mine['sent'], fn ($s) => $s['email'] !== $email);
        save_friends($user['sub'], $mine);
        $r = load_requests($email);
        $r['requests'] = array_filter($r['requests'], fn ($q) => $q['from'] !== $user['sub']);
        save_requests($email, $r);
    });
}

function remove_friend(array $user, string $sub): void
{
    if (!valid_sub($sub)) throw new HttpError('Unknown friend', 400);
    with_friends_lock(function () use ($user, $sub): void {
        foreach ([[$user['sub'], $sub], [$sub, $user['sub']]] as [$me, $them]) {
            $f = load_friends($me);
            $f['friends'] = array_filter($f['friends'], fn ($x) => $x['sub'] !== $them);
            if (is_file(friends_file($me))) save_friends($me, $f);
        }
    });
}

/** The site's address for links in emails. SITE_URL wins, as the request's Host header can be forged. */
function site_url(): string
{
    $url = env('SITE_URL');
    if ($url !== '') return rtrim($url, '/');
    $https = ($_SERVER['HTTPS'] ?? '') !== '' && $_SERVER['HTTPS'] !== 'off';
    $port = (int) ($_SERVER['SERVER_PORT'] ?? 80);
    $host = (string) ($_SERVER['SERVER_NAME'] ?? 'localhost') . (in_array($port, [80, 443], true) ? '' : ":$port");
    // .../api/index.php -> the folder above api/
    return ($https ? 'https' : 'http') . "://$host" . rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? '/', 2), '/');
}

function send_friend_email(array $from, string $to): bool
{
    $oneLine = fn (string $s) => trim((string) preg_replace('/[\r\n]+/', ' ', $s));
    $who = $from['name'] !== $from['email'] ? $oneLine($from['name']) . " ({$from['email']})" : $from['email'];
    $subject = "$who sent you a friend request on Penny Whistle Tabs";
    $body = "Hello,\n\n"
        . "$who would like to be friends on Penny Whistle Tabs. Friends can see each other's tune libraries.\n\n"
        . "To accept or ignore the request, sign in with Google as $to and open your friends page:\n"
        . site_url() . "/friends.html\n";
    $sender = env('MAIL_FROM', 'noreply@' . preg_replace('/^www\./', '', (string) ($_SERVER['SERVER_NAME'] ?? 'localhost')));
    $headers = [
        'From' => 'Penny Whistle Tabs <' . $oneLine($sender) . '>',
        'MIME-Version' => '1.0',
        'Content-Type' => 'text/plain; charset=UTF-8',
        'Content-Transfer-Encoding' => '8bit',
    ];
    $ok = @mail($to, mb_encode_mimeheader($subject, 'UTF-8'), $body, $headers);
    if (!$ok) error_log("friend request email to $to could not be sent");
    return $ok;
}

/** Whether a license check found the tune free to use (public domain, or a license with no conditions). */
function is_public_domain(array $tune): bool
{
    return ($tune['license']['status'] ?? '') === 'free';
}

function public_domain_file(): string
{
    return DATA_ROOT . '/public-domain.json';
}

/**
 * Every free-to-use piece in anyone's library, once each (its most recently updated copy):
 * {"tunes": [{"owner", "piece", "summary"}]}. Reading every library is slow, so the list is
 * kept in public-domain.json and rebuilt only after forget_public_domain().
 */
function public_domain_pieces(): array
{
    $cached = read_json_file(public_domain_file(), []);
    if (is_array($cached['tunes'] ?? null)) return $cached['tunes'];
    $free = [];
    foreach (glob(DATA_ROOT . '/users/*/tunes/*/tune.json') ?: [] as $file) {
        $t = json_decode((string) file_get_contents($file), true);
        if (is_array($t) && isset($t['id'], $t['title'], $t['createdAt'], $t['updatedAt']) && is_public_domain($t)) {
            $free[] = [basename(dirname($file, 3)), $t];
        }
    }
    usort($free, fn ($a, $b) => strcmp((string) $b[1]['updatedAt'], (string) $a[1]['updatedAt']));
    $tunes = [];
    foreach ($free as [$owner, $t]) {
        $piece = piece_of($t);
        foreach ($tunes as $x) if (pieces_match($piece, $x['piece'])) continue 2;
        $tunes[] = ['owner' => $owner, 'piece' => $piece, 'summary' => ['hasOriginal' => false] + summary($t)];
    }
    ensure_dir(DATA_ROOT);
    write_json_atomic(public_domain_file(), ['builtAt' => gmdate('Y-m-d\TH:i:s\Z'), 'tunes' => $tunes]);
    return $tunes;
}

/** Drop the cached public domain list, so the next library load rebuilds it (after a license is found, or a free tune changes). */
function forget_public_domain(): void
{
    @unlink(public_domain_file());
}

/**
 * The public domain section of $sub's library: the free-to-use pieces, leaving out any piece
 * already shown (piece_of() of each tune in their own or their friends' libraries). Each summary
 * carries its owner's account id.
 */
function public_domain_tunes(string $sub, array $friendSubs, array $shown): array
{
    $out = [];
    foreach (public_domain_pieces() as $x) {
        if ($x['owner'] === $sub || in_array($x['owner'], $friendSubs, true)) continue;
        foreach ($shown as $piece) if (pieces_match($x['piece'], $piece)) continue 2;
        $out[] = ['owner' => $x['owner']] + $x['summary'];
    }
    return $out;
}

/**
 * Another user's tune that $user may read: a friend's, or one found to be public domain.
 * Null (send a 404) for anything else, so other tunes can't be probed for.
 */
function readable_tune(array $user, string $owner, string $id): ?array
{
    if (!valid_sub($owner)) return null;
    $tune = load_tune(user_dir($owner) . '/tunes', $id);
    return $tune && (is_friend($user['sub'], $owner) || is_public_domain($tune)) ? $tune : null;
}

/**
 * Copy tunes from $user's library into a friend's, as their own tunes (with the original files):
 * the tunes with the given ids, or the whole library when $ids is null. Pieces the friend already
 * has are skipped. Returns ['copied' => [titles], 'skipped' => [titles]].
 */
function share_tunes(array $user, string $sub, ?array $ids): array
{
    if (!valid_sub($sub) || !is_friend($user['sub'], $sub)) throw new HttpError('You can only share tunes with your friends', 404);
    $from = user_dir($user['sub']) . '/tunes';
    $to = user_dir($sub) . '/tunes';
    $tunes = $ids === null ? load_tunes($from) : array_values(array_filter(array_map(fn ($id) => load_tune($from, (string) $id), $ids)));
    if (!$tunes) throw new HttpError('There are no tunes to share', 400);
    ensure_dir($to);
    // One share at a time, so two at once (a double click, or two friends) can't both copy a piece.
    return with_friends_lock(fn () => copy_new_pieces($user, $tunes, $from, $to));
}

/** Copy each tune into the $to library unless the piece is already there (or was copied earlier in this share). */
function copy_new_pieces(array $user, array $tunes, string $from, string $to): array
{
    $theirs = array_map('piece_of', load_tunes($to));
    $now = gmdate('Y-m-d\TH:i:s.v\Z');
    $out = ['copied' => [], 'skipped' => []];
    foreach ($tunes as $t) {
        $piece = piece_of($t);
        foreach ($theirs as $p) {
            if (pieces_match($piece, $p)) {
                $out['skipped'][] = $t['title'];
                continue 2;
            }
        }
        $id = slug($t['title']) . '-' . bin2hex(random_bytes(3));
        $dir = "$to/$id";
        mkdir($dir, 0775, true);
        foreach (glob("$from/{$t['id']}/*") ?: [] as $f) {
            if (is_file($f) && basename($f) !== 'tune.json') copy($f, "$dir/" . basename($f));
        }
        write_json_atomic("$dir/tune.json", ['id' => $id, 'createdAt' => $now, 'updatedAt' => $now,
            'sharedBy' => ['sub' => $user['sub'], 'name' => $user['name'], 'email' => $user['email'], 'at' => $now]] + $t);
        $theirs[] = $piece;
        $out['copied'][] = $t['title'];
    }
    return $out;
}

/** Routes under friends/ and library. Returns only by sending a response. */
function handle_friends(array $user, array $parts, string $method): never
{
    // The whole library, each piece once: all your own tunes, then friends' tunes (friends in
    // alphabetical order) leaving out pieces already listed, then the public domain section.
    if ($parts[0] === 'library' && $method === 'GET') {
        $mine = load_tunes(user_dir($user['sub']) . '/tunes');
        $shown = array_map('piece_of', $mine);
        $friends = [];
        foreach (friends_overview($user)['friends'] as $f) {
            $tunes = [];
            foreach (load_tunes(user_dir($f['sub']) . '/tunes') as $t) {
                $piece = piece_of($t);
                foreach ($shown as $s) if (pieces_match($piece, $s)) continue 2;
                $shown[] = $piece;
                $tunes[] = summary($t);
            }
            $friends[] = $f + ['tunes' => $tunes];
        }
        send_json(200, [
            'mine' => array_map('summary', $mine),
            'friends' => $friends,
            'publicDomain' => public_domain_tunes($user['sub'], array_column($friends, 'sub'), $shown),
        ]);
    }

    $action = $parts[1] ?? '';
    if ($action === '' && $method === 'GET') send_json(200, friends_overview($user));

    // Someone else's tune, read-only: friends/<sub>/tunes/<id>[/files/<file>]. Public domain tunes
    // from people who aren't friends come without the uploader's name or their uploaded files.
    if (($parts[2] ?? '') === 'tunes' && isset($parts[3]) && $method === 'GET') {
        $owner = $action;
        $tune = readable_tune($user, $owner, $parts[3]);
        if (!$tune) send_json(404, ['error' => 'Tune not found']);
        if (!is_friend($user['sub'], $owner)) {
            if (($parts[4] ?? '') !== '') send_json(404, ['error' => 'File not found']);
            send_json(200, ['originals' => [], 'owner' => ['sub' => $owner], 'publicDomain' => true] + $tune);
        }
        $dir = user_dir($owner) . '/tunes';
        if (($parts[4] ?? '') === 'files' && isset($parts[5])) serve_original("$dir/{$tune['id']}", $tune, $parts[5]);
        send_json(200, $tune + ['owner' => user_info($owner)]);
    }

    // License checks on friends' and public domain tunes: only the license is saved to the tune.
    if (($parts[2] ?? '') === 'tunes' && isset($parts[3]) && ($parts[4] ?? '') === 'license' && $method === 'POST') {
        $owner = $action;
        $tune = readable_tune($user, $owner, $parts[3]);
        if (!$tune) send_json(404, ['error' => 'Tune not found']);
        license_check(user_dir($owner) . "/tunes/{$tune['id']}", $tune, $user);
    }

    if ($method !== 'POST') send_json(405, ['error' => 'Method not allowed']);
    if (!str_starts_with($_SERVER['CONTENT_TYPE'] ?? '', 'application/json')) send_json(415, ['error' => 'Expected JSON']);
    $body = read_json_body();
    $sub = (string) ($body['sub'] ?? '');
    switch ($action) {
        case 'request':
            $status = send_friend_request($user, (string) ($body['email'] ?? ''));
            send_json(200, ['status' => $status] + friends_overview($user));
        case 'accept':
            accept_friend($user, $sub);
            break;
        case 'ignore':
            ignore_friend($user, $sub);
            break;
        case 'cancel':
            cancel_friend_request($user, (string) ($body['email'] ?? ''));
            break;
        case 'remove':
            remove_friend($user, $sub);
            break;
        case 'share': // {"sub", "ids": [...]}, or no ids for the whole library
            $ids = $body['ids'] ?? null;
            if ($ids !== null && (!is_array($ids) || !$ids)) throw new HttpError('ids must be a list of tune ids', 400);
            send_json(200, share_tunes($user, $sub, $ids) + friends_overview($user));
        default:
            send_json(404, ['error' => 'Not found']);
    }
    send_json(200, friends_overview($user));
}
