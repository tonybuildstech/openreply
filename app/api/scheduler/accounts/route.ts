import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  isTikTokContentPostingAudited,
  isTikTokDirectPostEnabled,
  isUnifiedInstagramConnectEnabled,
} from "@/lib/env";
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
        scopes: true,
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

        /* Read from the environment, NOT from `metadata.auditApproved`.
           That field was written from the `video.publish` scope flag until the
           two approvals were separated, so every account connected before then
           holds a `true` that was never about the audit. The flag is the live
           answer and needs no backfill; the stored value is only refreshed the
           next time the post mode is changed. */
        const auditApproved = isTikTokContentPostingAudited();

        return {
          ...account,
          metadata: undefined,
          scopes: undefined,
          tiktokPostMode: metadata.postMode ?? null,
          /* Whether this account could switch to Direct Post right now. Needs
             BOTH the app-level approval and a token minted after it — scopes
             are fixed at authorize time, so an older account must reconnect.
             Sent per account so the UI can explain which of the two is missing
             instead of offering a switch that fails. */
          tiktokCanDirectPost:
            account.platform === "TIKTOK" &&
            isTikTokDirectPostEnabled() &&
            account.scopes.includes("video.publish"),
          /* Whether a Direct Post from this app may be seen by anyone but the
             creator. The composer needs it to decide which privacy levels to
             offer: `creator_info` reports what the CREATOR may use and knows
             nothing about the app's audit, so offering its list unfiltered
             proposes "Everyone" to an install TikTok will refuse. */
          tiktokAuditApproved: account.platform === "TIKTOK" && auditApproved,
          // Both of these mean "posts will not be publicly visible".
          limitation:
            account.platform === "TIKTOK"
              ? metadata.postMode === "DIRECT_POST" && !auditApproved
                ? 'Posts can only go up privately ("Only me") until TikTok audits this app for Direct Post.'
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

const patchSchema = z.object({
  connectedAccountId: z.string().min(1),
  postMode: z.enum(["INBOX", "DIRECT_POST"]),
});

/**
 * Switch a TikTok account between inbox delivery and Direct Post.
 *
 * Without this the mode was frozen at whatever it was set to when the account
 * was connected, so an app that later passed TikTok's audit had no way to
 * actually use Direct Post — posts kept landing in the creator's inbox as
 * drafts with no explanation.
 *
 * Two guards, because Direct Post can fail for two unrelated reasons and the
 * error TikTok returns for either is opaque:
 *
 *  - the APP may not be approved for `video.publish` at all; and
 *  - this ACCOUNT's token may predate the approval. Scopes are baked into the
 *    token at authorize time, so an account connected before the flag went on
 *    holds `video.upload` only and has to be reconnected. `scopes` records what
 *    TikTok actually granted, which is exactly the right thing to check.
 *
 * Catching both here turns a mid-publish failure — after the file has already
 * been uploaded — into an immediate, actionable message.
 */
export async function PATCH(request: NextRequest) {
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

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "connectedAccountId and postMode (INBOX|DIRECT_POST) are required",
      },
      { status: 400 }
    );
  }

  const { connectedAccountId, postMode } = parsed.data;

  const account = await prisma.connectedAccount.findFirst({
    where: { id: connectedAccountId, workspaceId: context.workspaceId },
    select: { id: true, platform: true, scopes: true, metadata: true },
  });

  if (!account) {
    return NextResponse.json(
      { success: false, error: "Account not found" },
      { status: 404 }
    );
  }
  if (account.platform !== "TIKTOK") {
    return NextResponse.json(
      { success: false, error: "Post mode applies to TikTok accounts only" },
      { status: 400 }
    );
  }

  const directPostApproved = isTikTokDirectPostEnabled();

  if (postMode === "DIRECT_POST") {
    if (!directPostApproved) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Direct Post is off for this app. TikTok must approve the video.publish scope, then set TIKTOK_ENABLE_DIRECT_POST=true and restart both the web app and the worker.",
        },
        { status: 400 }
      );
    }
    if (!account.scopes.includes("video.publish")) {
      return NextResponse.json(
        {
          success: false,
          error:
            "This account was connected before Direct Post was enabled, so its token cannot publish. Disconnect it and connect it again, then switch.",
        },
        { status: 409 }
      );
    }
  }

  const existing = (account.metadata ?? {}) as TikTokAccountMetadata;

  await prisma.connectedAccount.update({
    where: { id: account.id },
    data: {
      // Spread first: `creatorUsername` and anything else stored alongside the
      // post mode must survive the write.
      metadata: {
        ...existing,
        postMode,
        // The AUDIT flag, not the scope flag above. The two are separate
        // approvals: holding `video.publish` gets as far as calling the Direct
        // Post endpoints, and only the Content Posting audit lifts SELF_ONLY.
        // Nothing reads this to make a decision — every caller asks the
        // environment directly, so an install that passes the audit needs no
        // backfill — but it is kept current so the stored row is not lying.
        auditApproved: isTikTokContentPostingAudited(),
      },
    },
  });

  return NextResponse.json({ success: true, data: { postMode } });
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
