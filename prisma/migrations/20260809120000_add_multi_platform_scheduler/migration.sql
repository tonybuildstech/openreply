-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('FACEBOOK_PAGE', 'INSTAGRAM', 'YOUTUBE', 'TIKTOK');

-- CreateEnum
CREATE TYPE "ConnectedAccountStatus" AS ENUM ('ACTIVE', 'NEEDS_REAUTH', 'DISABLED');

-- CreateEnum
CREATE TYPE "ScheduledPostMediaType" AS ENUM ('REEL', 'SHORT', 'TIKTOK_VIDEO', 'FACEBOOK_REEL', 'FACEBOOK_VIDEO');

-- CreateEnum
CREATE TYPE "ScheduledPostStatus" AS ENUM ('QUEUED', 'UPLOADING', 'PUBLISHING', 'SCHEDULED_REMOTE', 'PUBLISHED', 'FAILED', 'CANCELED');

-- CreateTable
CREATE TABLE "ConnectedAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "platformAccountId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "metadata" JSONB,
    "status" "ConnectedAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledPost" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectedAccountId" TEXT NOT NULL,
    "mediaStorageKey" TEXT NOT NULL,
    "mediaMimeType" TEXT NOT NULL,
    "mediaSizeBytes" BIGINT NOT NULL,
    "mediaType" "ScheduledPostMediaType" NOT NULL,
    "caption" TEXT NOT NULL DEFAULT '',
    "platformOptions" JSONB,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "ScheduledPostStatus" NOT NULL DEFAULT 'QUEUED',
    "platformPostId" TEXT,
    "platformContainerId" TEXT,
    "lastError" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishJobLog" (
    "id" TEXT NOT NULL,
    "scheduledPostId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "responseSnippet" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublishJobLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformQuotaUsage" (
    "id" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "connectedAccountId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "unitsUsed" INTEGER NOT NULL DEFAULT 0,
    "postsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformQuotaUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConnectedAccount_workspaceId_idx" ON "ConnectedAccount"("workspaceId");

-- CreateIndex
CREATE INDEX "ConnectedAccount_status_idx" ON "ConnectedAccount"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedAccount_workspaceId_platform_platformAccountId_key" ON "ConnectedAccount"("workspaceId", "platform", "platformAccountId");

-- CreateIndex
CREATE INDEX "ScheduledPost_status_scheduledAt_idx" ON "ScheduledPost"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "ScheduledPost_workspaceId_scheduledAt_idx" ON "ScheduledPost"("workspaceId", "scheduledAt");

-- CreateIndex
CREATE INDEX "ScheduledPost_connectedAccountId_idx" ON "ScheduledPost"("connectedAccountId");

-- CreateIndex
CREATE INDEX "ScheduledPost_batchId_idx" ON "ScheduledPost"("batchId");

-- CreateIndex
CREATE INDEX "PublishJobLog_scheduledPostId_idx" ON "PublishJobLog"("scheduledPostId");

-- CreateIndex
CREATE INDEX "PublishJobLog_createdAt_idx" ON "PublishJobLog"("createdAt");

-- CreateIndex
CREATE INDEX "PlatformQuotaUsage_platform_date_idx" ON "PlatformQuotaUsage"("platform", "date");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformQuotaUsage_platform_connectedAccountId_date_key" ON "PlatformQuotaUsage"("platform", "connectedAccountId", "date");

-- AddForeignKey
ALTER TABLE "ConnectedAccount" ADD CONSTRAINT "ConnectedAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_connectedAccountId_fkey" FOREIGN KEY ("connectedAccountId") REFERENCES "ConnectedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishJobLog" ADD CONSTRAINT "PublishJobLog_scheduledPostId_fkey" FOREIGN KEY ("scheduledPostId") REFERENCES "ScheduledPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformQuotaUsage" ADD CONSTRAINT "PlatformQuotaUsage_connectedAccountId_fkey" FOREIGN KEY ("connectedAccountId") REFERENCES "ConnectedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
