# Deploy — OpenReply on a VPS (Apache + PM2, managed Postgres)

Push-to-`main` (or the manual **Run workflow** button) builds in GitHub Actions and
ships a minimal bundle to the VPS. The server runs three things — **web app**
(dashboard + webhook + OAuth), **worker** (queue + comment poller), and **Redis** —
against a **managed Supabase Postgres**. The heavy `next build` happens on the runner,
never on the VPS.

```
git push main ─▶ Actions: npm ci → build web (standalone) → build worker (esbuild ESM)
                          → assemble bundle → rsync → ssh: prisma migrate deploy + pm2 reload
VPS: Apache :443 ─▶ 127.0.0.1:3001 (web)   ·   PM2: openreply-web + openreply-worker   ·   Redis :6379
Supabase ◀── web + worker connect over SSL
```

## Files here

| File | Role |
|---|---|
| `../.github/workflows/deploy.yml` | The pipeline (build → bundle → rsync → migrate → reload) |
| `../scripts/build-worker.mjs` | esbuild step: bundles the worker to `dist/worker.mjs` (ESM) |
| `ecosystem.config.js` | PM2: `openreply-web` (cluster×1) + `openreply-worker` (fork×1) |
| `remote-deploy.sh` | Runs on the VPS: sources `.env`, `prisma migrate deploy`, `pm2 startOrReload` |
| `apache-vhost.conf.example` | Reverse proxy for `openreply.ivanovic.dev` |
| `cron.sh` | Daily `refresh-tokens` + `attach-next-reel` (replaces `vercel.json` crons) |

## [HUMAN] one-time setup — the pipeline can't do these

1. **Supabase** — create a project; copy the connection string (use the
   connection-pooler URI) into the server `.env` as `DATABASE_URL`.
2. **GitHub secrets** (repo → Settings → Secrets and variables → Actions):
   `VPS_SSH_KEY` (private deploy key, full PEM), `VPS_HOST`, `VPS_USER` = `root`,
   and `VPS_PORT` if not 22. Generate a dedicated key:
   `ssh-keygen -t ed25519 -C github-deploy -f deploy_key -N ""` — the private half
   is the secret; append `deploy_key.pub` to `/root/.ssh/authorized_keys`. Deploys
   run as **root** (this box has no separate deploy user), so a leaked key = full
   root — keep it dedicated and rotate if exposed. Ensure `sshd_config` has
   `PermitRootLogin prohibit-password` (the Debian default — allows key auth,
   blocks password login).
3. **VPS provisioning (as root):** Node 20 (`node -v`), `npm i -g pm2` then
   `pm2 startup`, Apache with `a2enmod proxy proxy_http headers`,
   `mkdir -p /var/www/openreply.ivanovic.dev` (root owns it), and Redis
   (`apt install redis-server`).
4. **Server `.env`** at `/var/www/openreply.ivanovic.dev/.env` with every var from
   `../.env.example` — real secrets, `DATABASE_URL` = Supabase,
   `REDIS_URL=redis://127.0.0.1:6379`, `NEXTAUTH_URL=https://openreply.ivanovic.dev`.
   This file is **never** rsynced (excluded), so it survives every deploy.
5. **HTTPS:** `certbot --apache -d openreply.ivanovic.dev`; set
   `X-Forwarded-Proto "https"` in the generated `:443` vhost.
6. **Cron:** `crontab -e` →
   `0 5 * * * bash /var/www/openreply.ivanovic.dev/cron.sh >> /var/log/openreply-cron.log 2>&1`
7. **Meta app** (docs/setup.md Steps 7–9) — register the OAuth redirect
   `https://openreply.ivanovic.dev/api/instagram/callback` and the webhook callback
   `https://openreply.ivanovic.dev/api/webhook`, then publish.

## First deploy & verify

```bash
gh workflow run deploy.yml      # or just push to main
gh run watch
# On the VPS:
pm2 status                      # openreply-web + openreply-worker both "online"
curl -s http://127.0.0.1:3001/api/health   # status: ok, worker.healthy: true
```
