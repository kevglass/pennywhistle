#!/usr/bin/env bash
# Deploy Penny Whistle Tabs to a PHP web host over SSH/rsync.
#
#   ./deploy.sh            deploy
#   ./deploy.sh --dry-run  show what would be copied, change nothing
#
# Remote layout (inside the web root):
#   <DEPLOY_PATH>/            public files (index.html, js/, css/, vendor/, api/index.php)
#   <DEPLOY_PATH>/_private/   app/ code, Composer vendor/, .env secrets, data/ (saved tunes)
#                             blocked from the web by .htaccess; this script checks that.
# Saved tunes in _private/data are never overwritten or deleted.
set -euo pipefail
cd "$(dirname "$0")"

DEPLOY_HOST="${DEPLOY_HOST:-kevglass@cokeandcode.com}"
DEPLOY_PATH="${DEPLOY_PATH:-cokeandcode.com/pennywhistle}"
SITE_URL="${SITE_URL:-https://cokeandcode.com/pennywhistle}"

DRY=()
[[ "${1:-}" == "--dry-run" ]] && DRY=(--dry-run --itemize-changes)

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

command -v php >/dev/null || die "php is required locally"
command -v rsync >/dev/null || die "rsync is required"

# ---------------------------------------------------------------- secrets
say "Secrets"
if [[ -f .env ]]; then
  if [[ ! -f .env.enc || .env -nt .env.enc ]]; then
    echo ".env has changed since it was last encrypted: encrypting it to .env.enc"
    php scripts/secrets.php encrypt
  else
    echo ".env.enc is up to date"
  fi
elif [[ -f .env.enc ]]; then
  echo "No .env yet: decrypting .env.enc"
  php scripts/secrets.php decrypt
else
  die "No .env or .env.enc. Copy .env.example to .env and add your ANTHROPIC_API_KEY."
fi
grep -q '^ANTHROPIC_API_KEY=.\+' .env || echo "Warning: ANTHROPIC_API_KEY is empty in .env (reading music will be disabled)"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if ! git ls-files --error-unmatch .env.enc >/dev/null 2>&1 || ! git diff --quiet HEAD -- .env.enc; then
    echo "Reminder: .env.enc has changes that are not committed (git add .env.enc && git commit)."
  fi
fi

# ---------------------------------------------------------------- PHP packages
say "PHP packages"
if command -v composer >/dev/null; then
  composer install --no-dev --optimize-autoloader --no-interaction --quiet
elif [[ -f composer.phar ]]; then
  php composer.phar install --no-dev --optimize-autoloader --no-interaction --quiet
elif [[ -f vendor/autoload.php ]]; then
  echo "composer not found; deploying the existing vendor/ folder"
else
  die "vendor/ is missing. Install Composer (https://getcomposer.org) and run: composer install"
fi
php -l app/api.php >/dev/null && php -l public/api/index.php >/dev/null && echo "PHP syntax OK"

# ---------------------------------------------------------------- upload
say "Uploading to ${DEPLOY_HOST}:${DEPLOY_PATH}"
RSYNC=(rsync -az ${DRY[@]+"${DRY[@]}"} --exclude='.DS_Store')
if [[ ${#DRY[@]} -eq 0 ]]; then
  ssh "$DEPLOY_HOST" "mkdir -p '$DEPLOY_PATH/_private/data' && chmod 711 '$DEPLOY_PATH/_private' && chmod 700 '$DEPLOY_PATH/_private/data'"
fi
# Public files. /_private is excluded so --delete never touches it.
"${RSYNC[@]}" --delete --exclude='/_private' public/ "$DEPLOY_HOST:$DEPLOY_PATH/"
# Private code and packages (data/ and .env are left alone by these).
"${RSYNC[@]}" --delete app/ "$DEPLOY_HOST:$DEPLOY_PATH/_private/app/"
"${RSYNC[@]}" --delete vendor/ "$DEPLOY_HOST:$DEPLOY_PATH/_private/vendor/"
chmod 644 deploy/private.htaccess; chmod 600 .env   # -a carries these permissions across
"${RSYNC[@]}" deploy/private.htaccess "$DEPLOY_HOST:$DEPLOY_PATH/_private/.htaccess"
"${RSYNC[@]}" .env "$DEPLOY_HOST:$DEPLOY_PATH/_private/.env"

if [[ ${#DRY[@]} -gt 0 ]]; then
  say "Dry run finished: nothing was changed"
  exit 0
fi
ssh "$DEPLOY_HOST" "chmod 600 '$DEPLOY_PATH/_private/.env'"

# ---------------------------------------------------------------- verify
say "Checking ${SITE_URL}"
code=$(curl -s -o /dev/null -w '%{http_code}' "$SITE_URL/_private/.env" || true)
if [[ "$code" == "200" ]]; then
  ssh "$DEPLOY_HOST" "rm -f '$DEPLOY_PATH/_private/.env'"
  die "$SITE_URL/_private/.env was downloadable (HTTP 200), so it has been removed from the server. The host is not honouring .htaccess; move _private outside the web root (see README)."
fi
echo "Private folder is blocked from the web (HTTP $code)"
cfg=$(curl -s "$SITE_URL/api/index.php?r=config" || true)
if [[ "$cfg" == *'"transcribe":true'* ]]; then
  echo "API is up and Claude transcription is configured: $cfg"
elif [[ "$cfg" == *'"transcribe":false'* ]]; then
  echo "Warning: API is up but the server can't read ANTHROPIC_API_KEY from _private/.env (check file permissions): $cfg"
else
  echo "Warning: the API did not answer as expected. Check that the host runs PHP 8.1+. Response:"
  echo "$cfg" | head -c 600; echo
fi
# Pages and code must never be served from a stale browser cache (see public/.htaccess).
stale=0
for p in "" index.html tune.html editor.html js/ui.js css/app.css; do
  h=$(curl -s -D - -o /dev/null "$SITE_URL/$p" | tr -d '\r' || true)
  if ! grep -qi '^cache-control:.*no-cache' <<<"$h" || grep -qi '^cache-control:.*max-age=[1-9]' <<<"$h"; then
    echo "Warning: /$p could be cached by browsers:"; grep -i -E '^(cache-control|expires):' <<<"$h" || echo "  (no Cache-Control header)"
    stale=1
  fi
done
h=$(curl -s -D - -o /dev/null "$SITE_URL/api/index.php?r=config" | tr -d '\r' || true)
if grep -qi '^cache-control:.*max-age=[1-9]' <<<"$h" || grep -qi '^expires:' <<<"$h"; then
  echo "Warning: the API is being given a cache lifetime by the host:"; grep -i -E '^(cache-control|expires):' <<<"$h"
  stale=1
fi
[[ $stale -eq 0 ]] && echo "Pages, code and API are all served with no-cache"
say "Deployed: $SITE_URL/"
