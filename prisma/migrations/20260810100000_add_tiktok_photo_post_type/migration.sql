-- TikTok photo carousels.
--
-- TikTok publishes stills through a DIFFERENT endpoint from video
-- (/v2/post/publish/content/init/ with media_type=PHOTO, not
-- /v2/post/publish/video/init/), and with different limits: up to 35 items
-- against Instagram's 10, and the files are PULLED from this server rather than
-- uploaded to TikTok. None of that is expressible as "CAROUSEL on TikTok", so
-- it gets its own post type.
--
-- Purely additive: one new enum value, no column, no backfill. Every existing
-- row keeps its type and meaning.
--
-- Transaction safety: `ALTER TYPE ... ADD VALUE` may not have its new value
-- USED in the same transaction that adds it. Nothing here uses it — there is no
-- backfill — so this is safe as one transaction.

-- AlterEnum
ALTER TYPE "ScheduledPostMediaType" ADD VALUE 'TIKTOK_PHOTO';
