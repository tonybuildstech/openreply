#!/usr/bin/env bash
# Runs ON THE VPS via SSH after the bundle has been rsynced. Invoked by
# .github/workflows/deploy.yml with DEPLOY_PATH set. Keep it idempotent —
# re-running must always be safe.
set -euo pipefail

cd "${DEPLOY_PATH:?DEPLOY_PATH not set}"

# Load runtime secrets. This .env lives only on the server and is excluded from
# rsync, so deploys never overwrite or leak it.
set -a
# shellcheck disable=SC1091
source ./.env
set +a

# Apply pending migrations to the managed (Supabase) Postgres. npx fetches the
# CLI on demand, so the server needs no dev dependencies. Prisma 7 matches the
# repo; `migrate deploy` needs only the schema + migrations + DATABASE_URL
# (never the generated client, which ships bundled).
npx --yes prisma@7 migrate deploy --schema prisma/schema.prisma

# Zero-downtime reload (starts both apps on first deploy). --update-env makes
# PM2 pick up the secrets we just sourced.
pm2 startOrReload ecosystem.config.js --update-env
pm2 save
