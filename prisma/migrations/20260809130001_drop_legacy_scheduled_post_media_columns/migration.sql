-- Drops the three legacy single-file columns, now that every post's media
-- lives in "ScheduledPostMedia".
--
-- ⚠ DESTRUCTIVE AND NOT REVERSIBLE BY MIGRATION.
--
-- Run this ONLY when both are true:
--   1. The previous migration (20260809130000_add_scheduled_post_media) has run
--      and its backfill succeeded — verify with the guard below.
--   2. The application code deployed to this database no longer reads these
--      columns. Deploying the drop ahead of the code takes the scheduler down.
--
-- To back out: restore the columns and re-derive them from position 0 of
-- "ScheduledPostMedia". Take a dump first.

-- Guard: refuse to drop while any post would lose its only reference to a file.
-- A failed migration here is a good outcome — it means the backfill missed rows
-- and dropping would have destroyed the only copy of their storage keys.
DO $$
DECLARE
    orphaned integer;
BEGIN
    SELECT COUNT(*) INTO orphaned
    FROM "ScheduledPost" p
    WHERE NOT EXISTS (
        SELECT 1 FROM "ScheduledPostMedia" m WHERE m."scheduledPostId" = p."id"
    );

    IF orphaned > 0 THEN
        RAISE EXCEPTION
            'Refusing to drop legacy media columns: % ScheduledPost row(s) have no ScheduledPostMedia. Re-run the backfill from 20260809130000 first.',
            orphaned;
    END IF;
END $$;

-- AlterTable
ALTER TABLE "ScheduledPost" DROP COLUMN "mediaMimeType",
DROP COLUMN "mediaSizeBytes",
DROP COLUMN "mediaStorageKey";
