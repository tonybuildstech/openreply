#!/usr/bin/env bash
# Daily maintenance for the self-hosted VPS — replaces the vercel.json crons,
# which only fire on Vercel. Ships in the bundle at the app root. Install in the
# deploy user's crontab (use bash explicitly so no execute bit is required):
#
#   0 5 * * *  bash /var/www/openreply.ivanovic.dev/cron.sh >> /var/log/openreply-cron.log 2>&1
#
# Hits the loopback app with the CRON_SECRET bearer token the routes expect.
set -euo pipefail

APP_DIR="/var/www/openreply.ivanovic.dev"
BASE_URL="http://127.0.0.1:3001"

set -a
# shellcheck disable=SC1091
source "$APP_DIR/.env"
set +a
SECRET="${CRON_SECRET:-${NEXTAUTH_SECRET:?CRON_SECRET or NEXTAUTH_SECRET must be set}}"

for path in /api/cron/refresh-tokens /api/cron/attach-next-reel; do
  echo "[cron] $(date -Is) GET $path"
  curl -fsS -H "Authorization: Bearer $SECRET" "$BASE_URL$path" \
    || echo "[cron] $path FAILED"
  echo
done
