<?php
// Favourites: tunes a user has starred, shown first in their library. Any tune they can read can be
// a favourite: their own, a friend's or a public domain one. Stored as a plain file under DATA_DIR:
//   users/<sub>/favourites.json  {"favourites": [{"owner": <sub>, "id", "at"}]}
// Favourites of tunes that have since gone (deleted, unfriended, no longer free) are skipped when read.
declare(strict_types=1);

const MAX_FAVOURITES = 1000;

function favourites_file(string $sub): string
{
    return user_dir($sub) . '/favourites.json';
}

function load_favourites(string $sub): array
{
    $list = read_json_file(favourites_file($sub), ['favourites' => []])['favourites'];
    return is_array($list) ? array_values(array_filter($list, fn ($f) => is_string($f['owner'] ?? null) && is_string($f['id'] ?? null))) : [];
}

function is_favourite(string $sub, string $owner, string $id): bool
{
    foreach (load_favourites($sub) as $f) if ($f['owner'] === $owner && $f['id'] === $id) return true;
    return false;
}

/** Star or unstar a tune. $owner is the tune's owner ($user's own sub for their own tunes). */
function set_favourite(array $user, string $owner, string $id, bool $on): void
{
    $readable = $owner === $user['sub'] ? load_tune(user_dir($owner) . '/tunes', $id) : readable_tune($user, $owner, $id);
    if ($on && !$readable) throw new HttpError('Tune not found', 404);
    $list = array_values(array_filter(load_favourites($user['sub']), fn ($f) => !($f['owner'] === $owner && $f['id'] === $id)));
    if ($on) {
        if (count($list) >= MAX_FAVOURITES) throw new HttpError('You have too many favourites. Remove some before adding more.', 429);
        $list[] = ['owner' => $owner, 'id' => $id, 'at' => gmdate('Y-m-d\TH:i:s\Z')];
    }
    ensure_dir(user_dir($user['sub']));
    write_json_atomic(favourites_file($user['sub']), ['favourites' => $list]);
}

/**
 * Summaries of $user's favourite tunes that they can still read, most recently starred first.
 * Others' tunes carry their owner's account id, as elsewhere in the library.
 */
function favourite_tunes(array $user): array
{
    $out = [];
    foreach (array_reverse(load_favourites($user['sub'])) as $f) {
        if ($f['owner'] === $user['sub']) {
            $t = load_tune(user_dir($user['sub']) . '/tunes', $f['id']);
            if ($t) $out[] = summary($t);
        } elseif ($t = readable_tune($user, $f['owner'], $f['id'])) {
            $out[] = ['owner' => $f['owner']] + summary($t);
        }
    }
    return $out;
}

/** POST favourites {"id", "owner" (empty for your own tune), "favourite": true|false}. */
function handle_favourites(array $user, string $method): never
{
    if ($method !== 'POST') send_json(405, ['error' => 'Method not allowed']);
    if (!str_starts_with($_SERVER['CONTENT_TYPE'] ?? '', 'application/json')) send_json(415, ['error' => 'Expected JSON']);
    $body = read_json_body();
    $owner = (string) ($body['owner'] ?? '') ?: $user['sub'];
    $id = (string) ($body['id'] ?? '');
    if (!valid_sub($owner) || !valid_id($id)) throw new HttpError('Unknown tune', 400);
    $on = !empty($body['favourite']);
    set_favourite($user, $owner, $id, $on);
    send_json(200, ['favourite' => $on]);
}
