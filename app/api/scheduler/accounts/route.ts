import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { isUnifiedInstagramConnectEnabled } from "@/lib/env";
import type { TikTokAccountMetadata } from "@/lib/scheduler/adapters/tiktok";
import { PLATFORM_CONSTRAINTS } from "@/lib/scheduler/constraints";
import { getYouTubeQuotaState } from "@/lib/scheduler/quota";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Connected publishing accounts for the workspace, grouped by platform, with
 * the caveats each one carries — TikTok's post mode, YouTube's audit state and
 * remaining daily quota, and any account that needs reconnecting.
 *
 * These caveats are returned rather than buried, because "connected" does not
 * mean "will post publicly" on either of those platforms.
 *
 * Also returns the workspace's comment→DM Instagram accounts. They live in a
 * different table (InstagramAccount, not ConnectedAccount) but describe the
 * same real profiles, and /connections merges the two on the Instagram account
 * ID so one profile shows as one entry with both capabilities. Fetching them
 * together keeps that page on a single request.
 */
export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const [accounts, instagramAccounts] = await Promise.all([
    prisma.connectedAccount.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: [{ platform: "asc" }, { displayName: "asc" }],
      select: {
        id: true,
        platform: true,
        platformAccountId: true,
        displayName: true,
        avatarUrl: true,
        status: true,
        tokenExpiresAt: true,
        metadata: true,
        createdAt: true,
      },
    }),
    prisma.instagramAccount.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: { connectedAt: "desc" },
      select: {
        id: true,
        instagramId: true,
        username: true,
        tokenExpiresAt: true,
        webhookSubscribed: true,
      },
    }),
  ]);

  const youtubeQuota = accounts.some((a) => a.platform === "YOUTUBE")
    ? await getYouTubeQuotaState()
    : null;

  return NextResponse.json({
    success: true,
    data: {
      accounts: accounts.map((account) => {
        const metadata = (account.metadata ?? {}) as TikTokAccountMetadata & {
          projectAudited?: boolean;
        };

        return {
          ...account,
          metadata: undefined,
          tiktokPostMode: metadata.postMode ?? null,
          // Both of these mean "posts will not be publicly visible".
          limitation:
            account.platform === "TIKTOK"
              ? metadata.postMode === "DIRECT_POST" && !metadata.auditApproved
                ? "Posts go up privately (SELF_ONLY) until TikTok audits this app."
                : metadata.postMode === "DIRECT_POST"
                  ? null
                  : "Videos are delivered to your TikTok inbox — you finish posting in the app."
              : account.platform === "YOUTUBE" && !metadata.projectAudited
                ? "Uploads stay private until this Google Cloud project passes YouTube's API audit."
                : null,
        };
      }),
      instagramAccounts,
      youtubeQuota,
      constraints: PLATFORM_CONSTRAINTS,
      canManage: canManageWorkspace(context.role),
      // When on, one Instagram authorization covers comment→DM and publishing,
      // so /connections offers a single connect button rather than two.
      unifiedInstagramConnect: isUnifiedInstagramConnectEnabled(),
    },
  });
}

const deleteSchema = z.object({ connectedAccountId: z.string().min(1) });

/** Disconnect an account. Queued posts for it are cancelled, not orphaned. */
export async function DELETE(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Forbidden" },
      { status: 403 }
    );
  }

  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "connectedAccountId is required" },
      { status: 400 }
    );
  }

  const account = await prisma.connectedAccount.findFirst({
    where: {
      id: parsed.data.connectedAccountId,
      workspaceId: context.workspaceId,
    },
    select: { id: true },
  });

  if (!account) {
    return NextResponse.json(
      { success: false, error: "Account not found" },
      { status: 404 }
    );
  }

  // Mark pending posts CANCELED before the cascade removes them, so the
  // dispatcher's cancellation check sees a definite state if one is mid-flight.
  await prisma.scheduledPost.updateMany({
    where: {
      connectedAccountId: account.id,
      status: { in: ["QUEUED", "UPLOADING", "PUBLISHING", "SCHEDULED_REMOTE"] },
    },
    data: { status: "CANCELED", lastError: "Account disconnected" },
  });

  await prisma.connectedAccount.delete({ where: { id: account.id } });

  return NextResponse.json({ success: true });
}
