// PM2 process config — rsynced to the app root on the VPS next to server.js and
// worker.mjs. Started by deploy/remote-deploy.sh with:
//   pm2 startOrReload ecosystem.config.js --update-env
// `--update-env` makes PM2 pick up the environment that remote-deploy.sh sourced
// from the server-side .env, so secrets (DATABASE_URL, REDIS_URL, ENCRYPTION_KEY,
// META_*, INSTAGRAM_*, ...) are intentionally NOT listed here — only process-level
// settings are.
module.exports = {
  apps: [
    {
      // Next.js standalone server: dashboard + webhook receiver + OAuth callback.
      name: "openreply-web",
      script: "server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "cluster", // cluster + 1 instance gives zero-downtime `pm2 reload`
      max_memory_restart: "400M",
      env: {
        NODE_ENV: "production",
        PORT: 3003, // Apache reverse-proxies here; bound to loopback only
        HOSTNAME: "127.0.0.1",
      },
    },
    {
      // BullMQ consumer + comment poller + heartbeat. Single fork — NEVER
      // clustered, or duplicate consumers would double-process the queue.
      name: "openreply-worker",
      script: "worker.mjs",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "250M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
