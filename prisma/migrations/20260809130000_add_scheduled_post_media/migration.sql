-- Moves ScheduledPost from "exactly one file in three columns" to an ordered
-- child table, so an Instagram carousel can hold 2-10 items.
--
-- This migration is ADDITIVE and reversible: the legacy mediaStorageKey /
-- mediaMimeType / mediaSizeBytes columns are left in place and still populated.
-- They are dropped by the NEXT migration, which must not run until the
-- application code reading them has shipped.
--
-- Transaction safety: `ALTER TYPE ... ADD VALUE` may not have its new values
-- USED in the same transaction that adds them. The backfill below only uses
-- "ScheduledPostMediaKind", which is created fresh here (CREATE TYPE is fully
-- transactional), never the new 'IMAGE'/'CAROUSEL' values added to
-- "ScheduledPostMediaType". So this is safe as one transaction.

-- CreateEnum
CREATE TYPE "ScheduledPostMediaKind" AS ENUM ('IMAGE', 'VIDEO');

-- AlterEnum
ALTER TYPE "ScheduledPostMediaType" ADD VALUE 'IMAGE';
ALTER TYPE "ScheduledPostMediaType" ADD VALUE 'CAROUSEL';

-- CreateTable
CREATE TABLE "ScheduledPostMedia" (
    "id" TEXT NOT NULL,
    "scheduledPostId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "kind" "ScheduledPostMediaKind" NOT NULL,
    "widthPx" INTEGER,
    "heightPx" INTEGER,
    "durationMs" INTEGER,
    "croppedToRatio" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledPostMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledPostMedia_scheduledPostId_idx" ON "ScheduledPostMedia"("scheduledPostId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledPostMedia_scheduledPostId_position_key" ON "ScheduledPostMedia"("scheduledPostId", "position");

-- AddForeignKey
ALTER TABLE "ScheduledPostMedia" ADD CONSTRAINT "ScheduledPostMedia_scheduledPostId_fkey" FOREIGN KEY ("scheduledPostId") REFERENCES "ScheduledPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one media row per existing post, at position 0.
--
-- Hand-written; `prisma migrate diff` does not infer data movement. Without
-- this, every already-scheduled post loses its file and the worker publishes
-- nothing.
--
-- `kind` is derived from the stored MIME type rather than assumed: everything
-- in the table today is video, but deriving it costs nothing and means a
-- re-run against a partially-migrated database is still correct.
--
-- gen_random_uuid() is pgcrypto/PG13+ built-in. These IDs are not cuids like
-- the rest of the schema, which is cosmetic — nothing parses them, and Prisma
-- only generates cuids for NEW rows.
INSERT INTO "ScheduledPostMedia" (
    "id", "scheduledPostId", "position", "storageKey", "mimeType", "sizeBytes", "kind"
)
SELECT
    gen_random_uuid()::text,
    "id",
    0,
    "mediaStorageKey",
    "mediaMimeType",
    "mediaSizeBytes",
    CASE
        WHEN "mediaMimeType" LIKE 'image/%' THEN 'IMAGE'::"ScheduledPostMediaKind"
        ELSE 'VIDEO'::"ScheduledPostMediaKind"
    END
FROM "ScheduledPost"
-- Idempotent: re-running this migration cannot duplicate a post's media.
WHERE NOT EXISTS (
    SELECT 1 FROM "ScheduledPostMedia" m WHERE m."scheduledPostId" = "ScheduledPost"."id"
);
