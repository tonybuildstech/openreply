/**
 * Makes `import logo from "@/public/openreply-logo.jpg"` typecheck without a build.
 *
 * Next.js declares the `*.jpg` / `*.png` / `*.svg` modules in `next-env.d.ts`, but that
 * file is **generated** by `next dev` / `next build` and is **gitignored**
 * (`.gitignore` → `next-env.d.ts`). CI runs `npm run db:generate` then
 * `npm run typecheck` with no Next build in between (`.github/workflows/ci.yml`), so on
 * a fresh clone the declarations are absent and any static image import fails with:
 *
 *   error TS2307: Cannot find module '@/public/openreply-logo.jpg'
 *                 or its corresponding type declarations.
 *
 * It typechecks fine locally, because a previous build left `next-env.d.ts` lying
 * around — which is exactly what makes this a nasty trap. This file is committed, so
 * the declarations are present regardless of build order.
 *
 * Re-referencing the same declarations that `next-env.d.ts` pulls in is safe:
 * TypeScript dedupes `/// <reference>` by resolved file path, so having both costs
 * nothing and does NOT produce duplicate-identifier errors. Do not hand-roll
 * `declare module "*.jpg"` here instead — that WOULD collide with `next-env.d.ts`
 * whenever a build has run.
 *
 * Used by `components/brand-mark.tsx`. See `.dev/changes/tiktok-icon-brand-consistency/`.
 */

/// <reference types="next/image-types/global" />
