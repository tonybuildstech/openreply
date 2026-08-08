import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import { refreshLongLivedToken } from "@/lib/meta/client";

const DAYS_BEFORE_EXPIRY = 10;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() + DAYS_BEFORE_EXPIRY);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const usageReset = await prisma.workspace.updateMany({
    where: { usagePeriodStart: { lt: monthStart } },
    data: {
      usagePeriodStart: monthStart,
      dmsSentThisPeriod: 0,
    },
  });

  const accountsToRefresh = await prisma.instagramAccount.findMany({
    where: {
      accessToken: { not: "" },
      tokenExpiresAt: {
        not: null,
        lte: cutoffDate,
      },
    },
    select: {
      id: true,
      workspaceId: true,
      username: true,
      accessToken: true,
    },
  });

  // The scheduler's Instagram rows live in ConnectedAccount and hold their own
  // copy of the long-lived token. They were never refreshed here, so publishing
  // silently died ~60 days after connecting while the DM connection kept
  // working. Same 60-day token, same refresh endpoint — just a second table.
  const connectedToRefresh = await prisma.connectedAccount.findMany({
    where: {
      platform: "INSTAGRAM",
      status: { not: "DISABLED" },
      tokenExpiresAt: {
        not: null,
        lte: cutoffDate,
      },
    },
    select: {
      id: true,
      workspaceId: true,
      displayName: true,
      accessToken: true,
    },
  });

  const results: Array<{
    instagramAccountId: string;
    username: string;
    status: "refreshed" | "failed";
    error?: string;
  }> = [];

  const connectedResults: Array<{
    connectedAccountId: string;
    displayName: string;
    status: "refreshed" | "failed";
    error?: string;
  }> = [];

  for (const account of accountsToRefresh) {
    try {
      const currentToken = decryptToken(account.accessToken);
      const { accessToken: newToken, expiresIn } =
        await refreshLongLivedToken(currentToken);
      const encryptedToken = encryptToken(newToken);
      const newExpiry = new Date(Date.now() + expiresIn * 1000);

      await prisma.instagramAccount.update({
        where: { id: account.id },
        data: {
          accessToken: encryptedToken,
          tokenExpiresAt: newExpiry,
        },
      });

      results.push({
        instagramAccountId: account.id,
        username: account.username,
        status: "refreshed",
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      await prisma.operationalEvent.create({
        data: {
          workspaceId: account.workspaceId,
          source: "TOKEN_REFRESH",
          level: "ERROR",
          message: `Token refresh failed for @${account.username}: ${errorMessage}`,
          payload: {
            instagramAccountId: account.id,
            username: account.username,
          },
        },
      });

      results.push({
        instagramAccountId: account.id,
        username: account.username,
        status: "failed",
        error: errorMessage,
      });
    }
  }

  for (const account of connectedToRefresh) {
    try {
      const currentToken = decryptToken(account.accessToken);
      const { accessToken: newToken, expiresIn } =
        await refreshLongLivedToken(currentToken);

      await prisma.connectedAccount.update({
        where: { id: account.id },
        data: {
          accessToken: encryptToken(newToken),
          tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
          // A previously expired connection is healthy again once it refreshes.
          status: "ACTIVE",
        },
      });

      connectedResults.push({
        connectedAccountId: account.id,
        displayName: account.displayName,
        status: "refreshed",
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";

      // A refresh that fails is unrecoverable without the user — Instagram
      // will not re-issue from a dead token. Flag it so the Connections page
      // shows "reconnect" instead of failing at publish time.
      await prisma.connectedAccount.update({
        where: { id: account.id },
        data: { status: "NEEDS_REAUTH" },
      });

      await prisma.operationalEvent.create({
        data: {
          workspaceId: account.workspaceId,
          source: "TOKEN_REFRESH",
          level: "ERROR",
          message: `Publishing token refresh failed for ${account.displayName}: ${errorMessage}`,
          payload: {
            connectedAccountId: account.id,
            platform: "INSTAGRAM",
            displayName: account.displayName,
          },
        },
      });

      connectedResults.push({
        connectedAccountId: account.id,
        displayName: account.displayName,
        status: "failed",
        error: errorMessage,
      });
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      totalProcessed: accountsToRefresh.length,
      workspacesReset: usageReset.count,
      results,
      connectedProcessed: connectedToRefresh.length,
      connectedResults,
    },
  });
}
