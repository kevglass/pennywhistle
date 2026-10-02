#!/usr/bin/env bash
# Local development server (PHP's built-in web server), same layout as the live site.
#   ./dev.sh            uses PORT from .env, or 6000
#   PORT=8080 ./dev.sh
set -euo pipefail
cd "$(dirname "$0")"
command -v php >/dev/null || { echo "php (8.1+) is required: brew install php" >&2; exit 1; }
[[ -f vendor/autoload.php ]] || { echo "Run 'composer install' first" >&2; exit 1; }
if [[ -z "${PORT:-}" && -f .env ]]; then PORT=$(sed -n 's/^PORT=//p' .env | tail -1); fi
PORT="${PORT:-6000}"
echo "Penny Whistle Tabs dev server: http://localhost:$PORT  (tunes are saved in ./data)"
# Raise PHP's upload limits to match public/api/.user.ini (the built-in server ignores that file).
exec php -d upload_max_filesize=40M -d post_max_size=64M -d memory_limit=256M -d max_execution_time=600 \
  -d output_buffering=0 -S "localhost:$PORT" -t public
