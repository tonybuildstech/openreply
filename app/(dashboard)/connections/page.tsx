"use client";

/**
 * Connections — every account OpenReply talks to, grouped into a card per
 * platform. Not scheduler-specific: this is the one place an account is
 * connected or removed, whatever feature uses it.
 *
 * Instagram is the case that makes the page general rather than a publishing
 * list. One Instagram account can carry two capabilities — comment→DM
 * (InstagramAccount) and scheduled publishing (ConnectedAccount) — and the
 * default unified connect writes both rows from a single authorization. So the
 * Instagram card merges the two tables on the Instagram account ID and shows
 * one entry per real account with the capabilities it actually has, rather than
 * listing the same profile twice.
 *
 * The other rule the page keeps: a connected account is not necessarily one
 * that can post publicly. YouTube forces uploads private until the Cloud
 * project passes an audit, and TikTok delivers to the creator's inbox unless
 * the app passes theirs. Both are stated on the card, because a connect button
 * that leads to an invisible post is worse than no button.
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import PlatformLogo, {
  AccountAvatar,
} from "@/components/scheduler/platform-logo";
import {
  PLATFORM_META,
  PLATFORM_ORDER,
  type PlatformKey,
} from "@/components/scheduler/platform-meta";

interface ConnectedAccount {
  id: string;
  platform: PlatformKey;
  platformAccountId: string;
  displayName: string;
  avatarUrl: string | null;
  status: "ACTIVE" | "NEEDS_REAUTH" | "DISABLED";
  tokenExpiresAt: string | null;
  tiktokPostMode: "INBOX" | "DIRECT_POST" | null;
  limitation: string | null;
  createdAt: string;
}

/** An Instagram account connected for comment→DM. */
interface MessagingAccount {
  id: string;
  instagramId: string;
  username: string;
  tokenExpiresAt: string | null;
  webhookSubscribed: boolean;
}

/** One real Instagram profile, with whichever capabilities it is connected for. */
interface InstagramConnection {
  instagramId: string;
  displayName: string;
  avatarUrl: string | null;
  messaging: MessagingAccount | null;
  publishing: ConnectedAccount | null;
}

interface YouTubeQuota {
  used: number;
  limit: number;
  remainingUploads: number;
}

const ERROR_MESSAGES: Record<string, string> = {
  denied: "You cancelled the connection.",
  invalid_state: "That connection link expired. Try again.",
  forbidden: "You need admin access in this workspace to connect accounts.",
  not_configured:
    "This platform has no API credentials configured on the server yet.",
  failed: "The connection failed. Check the server logs for details.",
  unknown_platform: "Unknown platform.",
};

// Codes set by /api/instagram/connect and /api/instagram/callback, which used
// to land on Settings and now land here.
const INSTAGRAM_MESSAGES: Record<string, string> = {
  denied: "You cancelled the Instagram connection.",
  invalid: "That Instagram connection link expired. Try again.",
  forbidden:
    "You need admin access in this workspace to connect Instagram accounts.",
  already_connected:
    "That Instagram account is already connected to another workspace.",
  failed: "The Instagram connection failed. Check the server logs for details.",
};

function formatExpiry(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : "not available";
}

/**
 * Merge the two Instagram tables into one entry per profile, keyed on the
 * Instagram account ID (`InstagramAccount.instagramId` ===
 * `ConnectedAccount.platformAccountId`).
 */
function mergeInstagram(
  messaging: MessagingAccount[],
  publishing: ConnectedAccount[]
): InstagramConnection[] {
  const byInstagramId = new Map<string, InstagramConnection>();

  for (const account of messaging) {
    byInstagramId.set(account.instagramId, {
      instagramId: account.instagramId,
      displayName: `@${account.username}`,
      avatarUrl: null,
      messaging: account,
      publishing: null,
    });
  }

  for (const account of publishing) {
    const existing = byInstagramId.get(account.platformAccountId);
    if (existing) {
      existing.publishing = account;
      existing.avatarUrl ??= account.avatarUrl;
      continue;
    }
    byInstagramId.set(account.platformAccountId, {
      instagramId: account.platformAccountId,
      displayName: account.displayName,
      avatarUrl: account.avatarUrl,
      messaging: null,
      publishing: account,
    });
  }

  return [...byInstagramId.values()];
}

export default function ConnectionsPage() {
  const searchParams = useSearchParams();
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [messagingAccounts, setMessagingAccounts] = useState<
    MessagingAccount[]
  >([]);
  const [youtubeQuota, setYoutubeQuota] = useState<YouTubeQuota | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [unifiedInstagram, setUnifiedInstagram] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/scheduler/accounts");
    const payload = await res.json();
    if (payload.success) {
      setAccounts(payload.data.accounts);
      setMessagingAccounts(payload.data.instagramAccounts ?? []);
      setYoutubeQuota(payload.data.youtubeQuota);
      setCanManage(payload.data.canManage);
      setUnifiedInstagram(Boolean(payload.data.unifiedInstagramConnect));
    }
    setLoading(false);
  }, []);

  // Deferred so the fetch's setState lands after the first paint rather than
  // synchronously inside the effect — same pattern as the DM Logs page.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function disconnect(account: ConnectedAccount) {
    if (
      !confirm(
        `Disconnect ${account.displayName}? Any posts still scheduled to it will be cancelled.`
      )
    ) {
      return;
    }

    setBusy(account.id);
    await fetch("/api/scheduler/accounts", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectedAccountId: account.id }),
    });
    setBusy(null);
    void load();
  }

  /**
   * Removing an Instagram profile has to clear both rows it may own —
   * otherwise the account disappears from one feature and silently keeps
   * running in the other.
   */
  async function disconnectInstagram(entry: InstagramConnection) {
    const consequences = [
      entry.messaging ? "campaigns for it stop sending DMs" : null,
      entry.publishing ? "posts still scheduled to it are cancelled" : null,
    ].filter(Boolean);

    if (
      !confirm(`Disconnect ${entry.displayName}? ${consequences.join(" and ")}.`)
    ) {
      return;
    }

    setBusy(`instagram:${entry.instagramId}`);
    if (entry.messaging) {
      await fetch("/api/instagram/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instagramAccountId: entry.messaging.id }),
      });
    }
    if (entry.publishing) {
      await fetch("/api/scheduler/accounts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectedAccountId: entry.publishing.id }),
      });
    }
    setBusy(null);
    void load();
  }

  const error = searchParams.get("error");
  const connected = searchParams.get("connected");
  const connectedCount = searchParams.get("count");
  const instagramStatus = searchParams.get("instagram");
  // Set by /api/instagram/callback when a consent screen that included the
  // publishing scope came back refused — the cue to offer the DM-only retry.
  const instagramRetryMessaging =
    instagramStatus === "denied" && searchParams.get("retry") === "messaging";

  if (loading) {
    return <p className="text-sm text-muted">Loading connections…</p>;
  }

  const instagramConnections = mergeInstagram(
    messagingAccounts,
    accounts.filter((account) => account.platform === "INSTAGRAM")
  );

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Connections</h1>
        <p className="text-sm text-muted">
          Every account OpenReply works with — Instagram for comment→DM, and
          each platform you publish to. Connect as many per platform as you
          like.
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-error/40 bg-error/5 px-4 py-3 text-sm text-error">
          {ERROR_MESSAGES[error] ?? "Something went wrong."}
        </div>
      )}
      {connected && (
        <div className="rounded-lg border border-success/40 bg-success/5 px-4 py-3 text-sm text-success">
          Connected {connectedCount ?? 1} account
          {Number(connectedCount ?? 1) === 1 ? "" : "s"}.
        </div>
      )}
      {instagramStatus === "connected" && (
        <div className="rounded-lg border border-success/40 bg-success/5 px-4 py-3 text-sm text-success">
          Instagram connected.
        </div>
      )}
      {instagramStatus && instagramStatus !== "connected" && (
        <div className="rounded-lg border border-error/40 bg-error/5 px-4 py-3 text-sm text-error">
          {INSTAGRAM_MESSAGES[instagramStatus] ?? "Something went wrong."}
          {instagramRetryMessaging && (
            <>
              {" "}
              Consent screen refused?{" "}
              <a
                href="/api/instagram/connect?publish=0"
                className="underline hover:text-foreground"
              >
                Connect for DMs only
              </a>
              , which skips the publishing permission.
            </>
          )}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {PLATFORM_ORDER.map((platform) => {
          const meta = PLATFORM_META[platform];
          const isInstagram = platform === "INSTAGRAM";
          const platformAccounts = accounts.filter(
            (a) => a.platform === platform
          );
          const count = isInstagram
            ? instagramConnections.length
            : platformAccounts.length;

          // One Instagram authorization covers messaging and publishing, so
          // send people to the single connect rather than asking the same
          // account to consent a second time.
          const unifiedHere = unifiedInstagram && isInstagram;
          const connectHref = isInstagram
            ? "/api/instagram/connect"
            : `/api/connections/${meta.slug}/connect`;

          return (
            <section
              key={platform}
              className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface"
            >
              <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
                <div className="flex items-start gap-3">
                  <PlatformLogo platform={platform} className="mt-0.5 h-6 w-6" />
                  <div className="space-y-1">
                    <h2 className="text-base font-semibold leading-tight">
                      {meta.label}
                    </h2>
                    <p className="text-xs leading-5 text-muted">
                      {isInstagram
                        ? "Comment→DM automation, and OpenReply's worker publishes at the scheduled minute."
                        : meta.scheduling === "native"
                          ? "The platform holds the schedule."
                          : "OpenReply's worker publishes at the scheduled minute."}
                    </p>
                  </div>
                </div>

                <span className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-muted">
                  {count}
                </span>
              </header>

              <div className="flex-1 space-y-2 px-5 py-4">
                {platform === "YOUTUBE" && youtubeQuota && (
                  <div className="mb-3 rounded-lg border border-border bg-background px-3 py-2.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted">Daily upload quota</span>
                      <span className="font-medium">
                        {youtubeQuota.remainingUploads} left
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
                      <div
                        className="h-full rounded-full bg-foreground/50"
                        style={{
                          width: `${Math.min(100, (youtubeQuota.used / youtubeQuota.limit) * 100)}%`,
                        }}
                      />
                    </div>
                    <p className="mt-2 text-xs text-muted">
                      {youtubeQuota.used.toLocaleString()} /{" "}
                      {youtubeQuota.limit.toLocaleString()} units. Each upload
                      costs 1,600 — about six a day across the whole
                      installation.
                    </p>
                  </div>
                )}

                {unifiedHere && (
                  <p className="mb-3 rounded-lg border border-border bg-background px-3 py-2.5 text-xs leading-5 text-muted">
                    One authorization covers both comment→DM and scheduled
                    publishing — connect an account once and it does both.
                  </p>
                )}

                {isInstagram ? (
                  instagramConnections.length === 0 ? (
                    <p className="py-2 text-sm text-muted">
                      No Instagram accounts connected. Campaigns need a
                      professional account here before they can reply.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {instagramConnections.map((entry) => {
                        const publishing = entry.publishing;
                        const messaging = entry.messaging;
                        const busyKey = `instagram:${entry.instagramId}`;

                        return (
                          <li
                            key={entry.instagramId}
                            className="rounded-lg border border-border bg-background px-3 py-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex min-w-0 items-start gap-3">
                                <AccountAvatar
                                  platform="INSTAGRAM"
                                  avatarUrl={entry.avatarUrl}
                                  displayName={entry.displayName}
                                />
                                <div className="min-w-0 space-y-1.5">
                                  <p className="truncate text-sm font-medium">
                                    {entry.displayName}
                                  </p>

                                  <div className="flex flex-wrap gap-1.5">
                                    {messaging && (
                                      <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">
                                        Comment→DM
                                      </span>
                                    )}
                                    {publishing && (
                                      <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">
                                        Publishing
                                      </span>
                                    )}
                                  </div>

                                  {publishing?.status === "NEEDS_REAUTH" ? (
                                    <p className="text-xs text-error">
                                      Access expired — reconnect to resume
                                      posting
                                    </p>
                                  ) : publishing?.status === "DISABLED" ? (
                                    <p className="text-xs text-muted">
                                      Disabled
                                    </p>
                                  ) : (
                                    <p className="text-xs text-success">
                                      Connected
                                    </p>
                                  )}

                                  <p className="text-xs text-muted">
                                    Token expires{" "}
                                    {formatExpiry(
                                      messaging?.tokenExpiresAt ??
                                        publishing?.tokenExpiresAt ??
                                        null
                                    )}
                                    {messaging && (
                                      <>
                                        {" · "}
                                        {messaging.webhookSubscribed
                                          ? "Webhook ready"
                                          : "Webhook pending"}
                                      </>
                                    )}
                                  </p>
                                </div>
                              </div>

                              {canManage && (
                                <button
                                  onClick={() => void disconnectInstagram(entry)}
                                  disabled={busy === busyKey}
                                  className="shrink-0 rounded-md px-2 py-1 text-xs text-muted transition hover:bg-surface hover:text-error disabled:opacity-50"
                                >
                                  {busy === busyKey
                                    ? "Removing…"
                                    : "Disconnect"}
                                </button>
                              )}
                            </div>

                            {!messaging && (
                              <p className="mt-2.5 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-xs leading-5 text-warning">
                                Publishing only — this account cannot reply to
                                comments yet. Reconnect it to add comment→DM.
                              </p>
                            )}
                            {messaging && !publishing && (
                              <p className="mt-2.5 rounded-md border border-border bg-surface px-2.5 py-2 text-xs leading-5 text-muted">
                                Comment→DM only. Reconnect to also schedule
                                posts to this account.
                              </p>
                            )}
                            {publishing?.limitation && (
                              <p className="mt-2.5 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-xs leading-5 text-warning">
                                {publishing.limitation}
                              </p>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )
                ) : platformAccounts.length === 0 ? (
                  <p className="py-2 text-sm text-muted">
                    No {meta.label} accounts connected.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {platformAccounts.map((account) => (
                      <li
                        key={account.id}
                        className="rounded-lg border border-border bg-background px-3 py-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-start gap-3">
                            <AccountAvatar
                              platform={account.platform}
                              avatarUrl={account.avatarUrl}
                              displayName={account.displayName}
                            />
                            <div className="min-w-0 space-y-1">
                              <p className="truncate text-sm font-medium">
                                {account.displayName}
                              </p>
                              {account.status === "ACTIVE" ? (
                                <p className="text-xs text-success">Connected</p>
                              ) : account.status === "NEEDS_REAUTH" ? (
                                <p className="text-xs text-error">
                                  Access expired — reconnect to resume posting
                                </p>
                              ) : (
                                <p className="text-xs text-muted">Disabled</p>
                              )}
                            </div>
                          </div>

                          {canManage && (
                            <button
                              onClick={() => void disconnect(account)}
                              disabled={busy === account.id}
                              className="shrink-0 rounded-md px-2 py-1 text-xs text-muted transition hover:bg-surface hover:text-error disabled:opacity-50"
                            >
                              {busy === account.id ? "Removing…" : "Disconnect"}
                            </button>
                          )}
                        </div>

                        {account.limitation && (
                          <p className="mt-2.5 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-xs leading-5 text-warning">
                            {account.limitation}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {canManage && (
                <footer className="space-y-2 border-t border-border px-5 py-3">
                  <a
                    href={connectHref}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-background"
                  >
                    <PlatformLogo platform={platform} className="h-4 w-4" />
                    Connect {count > 0 ? "another" : meta.label}
                  </a>

                  {/* With IG_UNIFIED_CONNECT off, publishing is a separate
                      authorization and has to be offered separately. */}
                  {isInstagram && !unifiedInstagram && (
                    <a
                      href={`/api/connections/${meta.slug}/connect`}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted transition hover:bg-background hover:text-foreground"
                    >
                      Connect for publishing
                    </a>
                  )}
                </footer>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}