// Bundles the queue worker into a single portable file for production.
//
// The worker (`worker/dm-worker.ts`) and everything it pulls in from `lib/` is
// TypeScript that Next's `output: "standalone"` trace does NOT emit — that trace
// only covers the web app. So we bundle the worker's own source here and leave
// every npm package (and the generated Prisma client) external, to be resolved
// at runtime from the node_modules that Next's standalone output already ships.
// Run the result from inside `.next/standalone/` so those requires resolve.
import { build } from "esbuild";

await build({
  entryPoints: ["worker/dm-worker.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  // ESM, because the generated Prisma client reads `import.meta.url` at load
  // time to set up a `__dirname` shim — that is empty (and throws) under CJS.
  format: "esm",
  outfile: "dist/worker.mjs",
  // Leave node_modules packages as runtime require()s (resolved on the server).
  // Our own TS (worker + lib + the generated Prisma client under app/) is
  // bundled; only bare packages like @prisma/client, bullmq, ioredis, pg stay
  // external and load from the shipped node_modules.
  packages: "external",
  // Pick up the `@/*` path alias.
  tsconfig: "tsconfig.json",
  logLevel: "info",
});
