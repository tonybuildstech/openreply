import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Emit a self-contained server (.next/standalone/server.js + traced
  // node_modules) so the VPS runs the build artifact without the source tree
  // or dev dependencies. See deploy/ and .github/workflows/deploy.yml.
  output: "standalone",
  // Keep the worker's runtime deps UNBUNDLED so Next traces them (with their
  // transitive deps) into .next/standalone/node_modules. The DM worker
  // (dist/worker.mjs, esbuild `packages: "external"`) resolves these from that
  // shipped node_modules at runtime. Without this, Next bundles bullmq into the
  // web app's server chunks and never emits node_modules/bullmq, so the worker
  // crashes on boot with ERR_MODULE_NOT_FOUND. See scripts/build-worker.mjs.
  // This list must cover EVERY bare package in the worker's import graph
  // (worker/dm-worker.ts → lib/queue/dm-worker, lib/polling/comment-reconciler,
  // lib/ops/worker-health). Miss one and the worker crash-loops on boot.
  // zod arrives via lib/meta/oauth → lib/env; @prisma/adapter-pg via lib/db/client.
  serverExternalPackages: [
    "bullmq",
    "ioredis",
    "pg",
    "@prisma/client",
    "@prisma/adapter-pg",
    "zod",
  ],
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
