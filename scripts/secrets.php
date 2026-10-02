<?php
// Encrypt .env -> .env.enc (safe to commit) and decrypt it back with a local password.
//   php scripts/secrets.php encrypt      (prompts for a password twice)
//   php scripts/secrets.php decrypt      (prompts for the password, writes .env)
// Set SECRETS_PASSWORD to skip the prompt (e.g. in a deploy job).
// Crypto (libsodium): Argon2id key derivation + XChaCha20-Poly1305 authenticated encryption.
declare(strict_types=1);

const ROOT = __DIR__ . '/..';
const PLAIN = ROOT . '/.env';
const ENC = ROOT . '/.env.enc';

function fail(string $msg): never
{
    fwrite(STDERR, "Error: $msg\n");
    exit(1);
}

if (!extension_loaded('sodium')) fail('PHP sodium extension is required');

function derive_key(string $password, string $salt, int $ops, int $mem): string
{
    return sodium_crypto_pwhash(
        SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_KEYBYTES,
        $password, $salt, $ops, $mem, SODIUM_CRYPTO_PWHASH_ALG_ARGON2ID13,
    );
}

function encrypt_text(string $plain, string $password): string
{
    $salt = random_bytes(SODIUM_CRYPTO_PWHASH_SALTBYTES);
    $nonce = random_bytes(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES);
    $ops = SODIUM_CRYPTO_PWHASH_OPSLIMIT_MODERATE;
    $mem = SODIUM_CRYPTO_PWHASH_MEMLIMIT_MODERATE;
    $key = derive_key($password, $salt, $ops, $mem);
    $box = [
        'v' => 2, 'kdf' => 'argon2id', 'ops' => $ops, 'mem' => $mem, 'cipher' => 'xchacha20poly1305',
        'salt' => base64_encode($salt), 'nonce' => base64_encode($nonce),
        'data' => base64_encode(sodium_crypto_aead_xchacha20poly1305_ietf_encrypt($plain, 'pennywhistle-env', $nonce, $key)),
    ];
    sodium_memzero($key);
    return json_encode($box, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
}

function decrypt_text(string $json, string $password): string
{
    $box = json_decode($json, true);
    if (!is_array($box) || ($box['v'] ?? 0) !== 2) fail('Unsupported .env.enc format');
    $key = derive_key($password, base64_decode($box['salt']), (int) $box['ops'], (int) $box['mem']);
    $plain = sodium_crypto_aead_xchacha20poly1305_ietf_decrypt(base64_decode($box['data']), 'pennywhistle-env', base64_decode($box['nonce']), $key);
    sodium_memzero($key);
    if ($plain === false) fail('Wrong password (or .env.enc has been modified)');
    return $plain;
}

function ask_hidden(string $prompt): string
{
    if (!stream_isatty(STDIN)) fail('No terminal to prompt on: set SECRETS_PASSWORD');
    fwrite(STDOUT, $prompt);
    shell_exec('stty -echo');
    $line = fgets(STDIN);
    shell_exec('stty echo');
    fwrite(STDOUT, "\n");
    return rtrim((string) $line, "\r\n");
}

function password(bool $confirm): string
{
    $env = getenv('SECRETS_PASSWORD');
    if ($env !== false && $env !== '') return $env;
    $pw = ask_hidden('Secrets password: ');
    if ($confirm) {
        if (strlen($pw) < 10) fail('Use a password of at least 10 characters');
        if (ask_hidden('Repeat password: ') !== $pw) fail('Passwords do not match');
    }
    return $pw;
}

$cmd = $argv[1] ?? '';
$force = in_array('--force', $argv, true);
if ($cmd === 'encrypt') {
    if (!is_file(PLAIN)) fail('No .env file to encrypt');
    file_put_contents(ENC, encrypt_text((string) file_get_contents(PLAIN), password(true)));
    echo "Wrote .env.enc (commit this file; .env stays git-ignored).\n";
} elseif ($cmd === 'decrypt') {
    if (!is_file(ENC)) fail('No .env.enc file to decrypt');
    $text = decrypt_text((string) file_get_contents(ENC), password(false));
    if (is_file(PLAIN) && file_get_contents(PLAIN) !== $text && !$force) fail('.env already exists with different contents (use --force to overwrite)');
    $old = umask(0077);
    file_put_contents(PLAIN, $text);
    umask($old);
    chmod(PLAIN, 0600);
    echo "Wrote .env\n";
} elseif ($cmd === 'check') {
    // exit 0 when .env.enc decrypts to exactly the current .env
    if (!is_file(ENC) || !is_file(PLAIN)) exit(1);
    exit(decrypt_text((string) file_get_contents(ENC), password(false)) === file_get_contents(PLAIN) ? 0 : 1);
} else {
    fwrite(STDERR, "Usage: php scripts/secrets.php encrypt|decrypt|check [--force]\n");
    exit(1);
}
