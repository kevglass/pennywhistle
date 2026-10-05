<?php
// Email + password accounts, for people without a Google account. Plain files under DATA_DIR:
//   accounts/<sha256(email)>.json     {"email", "name", "passwordHash", "verified", "sub"?, "createdAt",
//                                      "passwordChangedAt", "failedLogins"?, "lockedUntil"?}
//   auth-tokens/<sha256(token)>.json  {"purpose": "verify"|"reset", "email", "expires"}
//   auth-mail/<sha256(email)>         touched when an account email is sent (one a minute at most)
// Only password_hash() output is stored, never the password, and emailed links carry a random
// token whose SHA-256 is all the server keeps. An account's library is users/<sub>/ as for Google:
// the same email address is the same library whichever way its owner signs in.
declare(strict_types=1);

const PASSWORD_MIN = 8;
const PASSWORD_MAX_BYTES = 72; // bcrypt ignores anything longer
const VERIFY_HOURS = 48;
const RESET_HOURS = 1;
const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;
const MAIL_GAP_SECONDS = 60;

function account_file(string $email): string
{
    return DATA_ROOT . '/accounts/' . hash('sha256', norm_email($email)) . '.json';
}

function load_account(string $email): ?array
{
    $a = read_json_file(account_file($email), []);
    return is_string($a['passwordHash'] ?? null) ? $a : null;
}

function save_account(array $a): void
{
    $file = account_file($a['email']);
    ensure_dir(dirname($file));
    write_json_atomic($file, $a);
}

function now_iso(int $t = 0): string
{
    return gmdate('Y-m-d\TH:i:s\Z', $t ?: time());
}

/** Marks a password version: sessions signed in with an older one stop working. */
function password_stamp(): string
{
    return now_iso() . '#' . bin2hex(random_bytes(4)); // differs even within a second
}

function valid_email(string $email): string
{
    $email = norm_email($email);
    if (strlen($email) > 254 || !filter_var($email, FILTER_VALIDATE_EMAIL)) throw new HttpError('Enter a valid email address', 400);
    return $email;
}

function check_password(string $password): void
{
    if (mb_strlen($password) < PASSWORD_MIN) throw new HttpError('Use a password of at least ' . PASSWORD_MIN . ' characters', 400);
    if (strlen($password) > PASSWORD_MAX_BYTES) throw new HttpError('That password is too long: use at most ' . PASSWORD_MAX_BYTES . ' characters', 400);
}

/** The library folder already used by this email (a Google sign-in), or null. */
function sub_for_email(string $email): ?string
{
    foreach (glob(DATA_ROOT . '/users/*/user.json') ?: [] as $file) {
        $u = read_json_file($file, []);
        if (norm_email((string) ($u['email'] ?? '')) === norm_email($email)) return basename(dirname($file));
    }
    return null;
}

/** Google sign-in: the library of a confirmed password account with the same email, if there is one. */
function password_account_sub(string $email): ?string
{
    $a = load_account($email);
    return $a && $a['verified'] && valid_sub((string) ($a['sub'] ?? '')) ? $a['sub'] : null;
}

// ------------------------------------------------------------------ tokens

function new_token(string $purpose, string $email, int $hours): string
{
    $dir = DATA_ROOT . '/auth-tokens';
    ensure_dir($dir);
    // Tidy up: expired tokens, and earlier ones for the same email and purpose (only the newest link works).
    foreach (glob("$dir/*.json") ?: [] as $f) {
        $t = read_json_file($f, []);
        if (($t['expires'] ?? 0) < time() || (($t['email'] ?? '') === $email && ($t['purpose'] ?? '') === $purpose)) @unlink($f);
    }
    $token = bin2hex(random_bytes(32));
    write_json_atomic("$dir/" . hash('sha256', $token) . '.json', ['purpose' => $purpose, 'email' => $email, 'expires' => time() + $hours * 3600]);
    return $token;
}

/** The email a token was issued for; it can only be used once. */
function use_token(string $purpose, string $token): string
{
    $bad = $purpose === 'verify'
        ? 'This confirmation link has expired or was already used. Sign in to get a new one.'
        : 'This reset link has expired or was already used. Ask for a new one.';
    if (preg_match('/^[0-9a-f]{64}$/', $token) !== 1) throw new HttpError($bad, 400);
    $file = DATA_ROOT . '/auth-tokens/' . hash('sha256', $token) . '.json';
    $t = read_json_file($file, []);
    if (($t['purpose'] ?? '') !== $purpose || !@unlink($file) || ($t['expires'] ?? 0) < time()) throw new HttpError($bad, 400);
    return (string) $t['email'];
}

// ------------------------------------------------------------------ email

/** At most one account email a minute per address, so the forms can't be used to flood someone. */
function may_mail(string $email): bool
{
    $stamp = DATA_ROOT . '/auth-mail/' . hash('sha256', $email);
    if (is_file($stamp) && filemtime($stamp) > time() - MAIL_GAP_SECONDS) return false;
    ensure_dir(dirname($stamp));
    touch($stamp);
    return true;
}

/** Call after may_mail() said yes (and before making a token, so a skipped email doesn't spoil the last link). */
function send_account_mail(string $email, string $subject, string $body): void
{
    if (!send_mail($email, $subject, $body)) error_log("account email ($subject) to $email could not be sent");
}

function send_verify_email(string $email): void
{
    if (!may_mail($email)) return;
    $link = site_url() . '/login.html?verify=' . new_token('verify', $email, VERIFY_HOURS);
    send_account_mail($email, 'Confirm your email for Penny Whistle Tabs', "Hello,\n\n"
        . "To finish creating your Penny Whistle Tabs account, open this link within " . VERIFY_HOURS . " hours:\n$link\n\n"
        . "If you didn't sign up, you can ignore this email.\n");
}

function send_reset_email(string $email, bool $hasPassword): void
{
    if (!may_mail($email)) return;
    $link = site_url() . '/login.html?reset=' . new_token('reset', $email, RESET_HOURS);
    $what = $hasPassword ? 'choose a new password' : 'set a password, so you can sign in with your email address as well as with Google';
    send_account_mail($email, 'Your Penny Whistle Tabs password', "Hello,\n\n"
        . "To $what, open this link within the hour:\n$link\n\n"
        . "If you didn't ask for this, you can ignore this email; your password hasn't changed.\n");
}

// ------------------------------------------------------------------ routes

/** Sign the user in on this browser, as login() does for Google. */
function start_user_session(array $account): never
{
    $info = user_info($account['sub']);
    $user = [
        'sub' => $account['sub'],
        'email' => $account['email'],
        'name' => $account['name'],
        'picture' => $info['picture'] ?? null, // kept from a Google sign-in with the same email
    ];
    $dir = user_dir($user['sub']);
    ensure_dir($dir);
    adopt_legacy_tunes($user);
    write_json_atomic("$dir/user.json", $user + ['lastLogin' => now_iso()]);

    start_session();
    session_regenerate_id(true);
    // Changing the password signs out every other password session (see current_user()).
    $_SESSION['user'] = $user + ['passwordChangedAt' => $account['passwordChangedAt']];
    session_write_close();
    send_json(200, $user);
}

/** Whether a password session is still good: the password hasn't changed since it signed in. */
function password_session_valid(array $user): bool
{
    if (!isset($user['passwordChangedAt'])) return true; // signed in with Google
    $a = load_account($user['email']);
    return $a !== null && $a['passwordChangedAt'] === $user['passwordChangedAt'] && ($a['sub'] ?? null) === $user['sub'];
}

function signup(array $body): never
{
    $email = valid_email((string) ($body['email'] ?? ''));
    $password = (string) ($body['password'] ?? '');
    $name = trim((string) preg_replace('/\s+/', ' ', (string) ($body['name'] ?? '')));
    if ($name === '') throw new HttpError('Enter your name', 400);
    check_password($password);
    if (!email_allowed($email)) throw new HttpError("$email is not allowed to use this site.", 403);

    $existing = load_account($email);
    if ($existing && $existing['verified']) {
        // Don't reveal that the account exists; tell its owner instead.
        if (may_mail($email)) send_account_mail($email, 'You already have a Penny Whistle Tabs account', "Hello,\n\n"
            . "Someone (hopefully you) tried to sign up to Penny Whistle Tabs with this email address, but it already has an account.\n\n"
            . "Sign in here, or use \"Forgot password?\" if you need a new one:\n" . site_url() . "/login.html\n");
    } else {
        // New, or never confirmed: whoever confirms the email owns it, with the details given last.
        save_account([
            'email' => $email,
            'name' => mb_substr($name, 0, 200),
            'passwordHash' => password_hash($password, PASSWORD_DEFAULT),
            'verified' => false,
            'createdAt' => now_iso(),
            'passwordChangedAt' => password_stamp(),
        ]);
        send_verify_email($email);
    }
    send_json(200, ['ok' => true, 'email' => $email]);
}

function verify_email(array $body): never
{
    $email = use_token('verify', (string) ($body['token'] ?? ''));
    $a = load_account($email);
    if (!$a) throw new HttpError('This account no longer exists. Please sign up again.', 404);
    if (!email_allowed($email)) throw new HttpError("$email is not allowed to use this site.", 403);
    if (!$a['verified']) {
        $a['verified'] = true;
        $a['sub'] = sub_for_email($email) ?? 'pw-' . bin2hex(random_bytes(12));
        save_account($a);
    }
    start_user_session($a);
}

function password_login(array $body): never
{
    $email = norm_email((string) ($body['email'] ?? ''));
    $password = (string) ($body['password'] ?? '');
    $wrong = 'That email and password don’t match an account. Check them, or sign up.';
    $a = $email !== '' ? load_account($email) : null;
    if (!$a) {
        password_verify($password, '$2y$12$UQQzR8Vc/zX73fQAc1U60.jB2tivj.XlamKuHVuE0lrb.cGtH.8f2'); // takes as long as a real check
        throw new HttpError($wrong, 401);
    }
    if (strtotime($a['lockedUntil'] ?? '') > time()) throw new HttpError('Too many wrong passwords. Wait ' . LOCK_MINUTES . ' minutes, or reset your password.', 429);
    if (!password_verify($password, $a['passwordHash'])) {
        $a['failedLogins'] = ($a['failedLogins'] ?? 0) + 1;
        if ($a['failedLogins'] >= MAX_FAILED_LOGINS) {
            $a['lockedUntil'] = now_iso(time() + LOCK_MINUTES * 60);
            $a['failedLogins'] = 0;
        }
        save_account($a);
        throw new HttpError($wrong, 401);
    }
    if (!$a['verified']) send_json(403, ['error' => "Confirm your email first: open the link we sent to $email.", 'unverified' => true]);
    if (!email_allowed($email)) throw new HttpError("$email is not allowed to use this site.", 403);
    unset($a['failedLogins'], $a['lockedUntil']);
    if (password_needs_rehash($a['passwordHash'], PASSWORD_DEFAULT)) $a['passwordHash'] = password_hash($password, PASSWORD_DEFAULT);
    save_account($a);
    start_user_session($a);
}

function resend_verification(array $body): never
{
    $email = norm_email((string) ($body['email'] ?? ''));
    $a = $email !== '' ? load_account($email) : null;
    if ($a && !$a['verified']) send_verify_email($email);
    send_json(200, ['ok' => true]);
}

/** Email a reset link: to a password account, or to a Google user so they can add a password. */
function forgot_password(string $email): void
{
    $email = valid_email($email);
    $a = load_account($email);
    if ($a || sub_for_email($email) !== null) send_reset_email($email, $a !== null);
}

function reset_password(array $body): never
{
    $password = (string) ($body['password'] ?? '');
    check_password($password); // before the one-time token is used up
    $email = use_token('reset', (string) ($body['token'] ?? ''));
    if (!email_allowed($email)) throw new HttpError("$email is not allowed to use this site.", 403);
    $a = load_account($email) ?? ['email' => $email, 'createdAt' => now_iso()];
    $sub = ($a['verified'] ?? false) ? $a['sub'] : (sub_for_email($email) ?? 'pw-' . bin2hex(random_bytes(12)));
    $a = [
        'name' => $a['name'] ?? user_info($sub)['name'] ?? $email,
        'passwordHash' => password_hash($password, PASSWORD_DEFAULT),
        'verified' => true, // the link proves they own the email
        'sub' => $sub,
        'passwordChangedAt' => password_stamp(),
    ] + $a;
    unset($a['failedLogins'], $a['lockedUntil']);
    save_account($a);
    start_user_session($a);
}

/** Routes under auth/ that work without signing in. */
function handle_accounts(string $route, string $method): void
{
    if ($method !== 'POST') return;
    $routes = ['auth/signup', 'auth/verify', 'auth/login', 'auth/resend', 'auth/forgot', 'auth/reset'];
    if (!in_array($route, $routes, true)) return;
    // A JSON content type can't be sent cross-site without a CORS preflight, which this API never grants.
    if (!str_starts_with($_SERVER['CONTENT_TYPE'] ?? '', 'application/json')) send_json(415, ['error' => 'Expected JSON']);
    $body = read_json_body();
    match ($route) {
        'auth/signup' => signup($body),
        'auth/verify' => verify_email($body),
        'auth/login' => password_login($body),
        'auth/resend' => resend_verification($body),
        'auth/reset' => reset_password($body),
        'auth/forgot' => (function () use ($body) {
            forgot_password((string) ($body['email'] ?? ''));
            send_json(200, ['ok' => true]);
        })(),
    };
}
