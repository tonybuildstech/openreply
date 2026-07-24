// Prisma 7 config. The datasource URL lives here because Prisma 7 no longer
// accepts `url` in schema.prisma.
//
// IMPORTANT — do not add top-level `import ... from "prisma/config"` or
// `import "dotenv/config"` here. Prisma's config loader resolves this file's
// imports relative to THIS directory. On the deployed VPS bundle that directory
// has no node_modules (only the web app's traced deps ship, and neither `prisma`
// nor `dotenv` is among them), so any bare import makes `prisma migrate deploy`
// fail with "Cannot find module". A plain object export needs nothing resolvable.
//
// `.env` is only loaded for LOCAL CLI use — Prisma 7 stopped auto-loading it. In
// production the deploy script (deploy/remote-deploy.sh) already exports these
// vars, so we reach for dotenv only when the URL is absent and tolerate it being
// unavailable.
if (!process.env.DATABASE_URL) {
  try {
    await import("dotenv/config");
  } catch {
    // dotenv isn't shipped to production; env is provided by the deploy script.
  }
}

export default {
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Migrations need a real session (advisory locks, etc.). Supabase's
    // transaction pooler (port 6543) can't hold one, so `migrate deploy` hangs
    // against it. Point Prisma at a direct/session connection when provided
    // (DIRECT_URL = Supabase "Session pooler", port 5432), and fall back to
    // DATABASE_URL for local/direct setups where the URL is already direct.
    url: process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"],
  },
};
