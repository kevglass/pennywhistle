#!/usr/bin/env node
// Encrypt .env -> .env.enc (safe to commit) and decrypt it back, using a local password.
//   npm run secrets:encrypt     (prompts for a password twice)
//   npm run secrets:decrypt     (prompts for the password, writes .env)
// For non-interactive use (CI/deploy) set SECRETS_PASSWORD instead of typing it.
// Crypto: scrypt (N=2^17, r=8, p=1) key derivation + AES-256-GCM.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAIN = path.join(ROOT, '.env');
const ENC = path.join(ROOT, '.env.enc');
const KDF = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function deriveKey(password, salt) {
  return crypto.scryptSync(password.normalize('NFKC'), salt, 32, KDF);
}

function encrypt(plaintext, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1, kdf: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, cipher: 'aes-256-gcm',
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  }, null, 2) + '\n';
}

function decrypt(json, password) {
  const box = JSON.parse(json);
  if (box.v !== 1 || box.kdf !== 'scrypt' || box.cipher !== 'aes-256-gcm') throw new Error('Unsupported .env.enc format');
  const key = crypto.scryptSync(password.normalize('NFKC'), Buffer.from(box.salt, 'base64'), 32, { N: box.N, r: box.r, p: box.p, maxmem: KDF.maxmem });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Wrong password (or .env.enc has been modified)');
  }
}

/** Read a line from the terminal without echoing it. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error('No terminal to prompt on: set SECRETS_PASSWORD'));
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n');
          return resolve(value);
        }
        if (c === '\u0003') { stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function password(confirm) {
  if (process.env.SECRETS_PASSWORD) return process.env.SECRETS_PASSWORD;
  const pw = await askHidden('Secrets password: ');
  if (confirm) {
    if (pw.length < 10) throw new Error('Use a password of at least 10 characters');
    if ((await askHidden('Repeat password: ')) !== pw) throw new Error('Passwords do not match');
  }
  return pw;
}

const cmd = process.argv[2];
try {
  if (cmd === 'encrypt') {
    if (!fs.existsSync(PLAIN)) throw new Error('No .env file to encrypt');
    fs.writeFileSync(ENC, encrypt(fs.readFileSync(PLAIN, 'utf8'), await password(true)));
    console.log('Wrote .env.enc (commit this file; .env stays git-ignored).');
  } else if (cmd === 'decrypt') {
    if (!fs.existsSync(ENC)) throw new Error('No .env.enc file to decrypt');
    const text = decrypt(fs.readFileSync(ENC, 'utf8'), await password(false));
    if (fs.existsSync(PLAIN) && fs.readFileSync(PLAIN, 'utf8') !== text && !process.argv.includes('--force')) {
      throw new Error('.env already exists with different contents (use --force to overwrite)');
    }
    fs.writeFileSync(PLAIN, text, { mode: 0o600 });
    console.log('Wrote .env');
  } else {
    console.log('Usage: node scripts/secrets.mjs encrypt|decrypt [--force]');
    process.exit(1);
  }
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
