"use client";

/**
 * Connections — publishing accounts, grouped into a card per platform.
 *
 * The design rule: a connected account is not necessarily one that can post
 * publicly. YouTube forces uploads private until the Cloud project passes an
 * audit, and TikTok delivers to the creator's inbox unless the app passes
 * theirs. Both are stated on the card, because a connect button that leads to
 * an invisible post is worse than no button.
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

export default function ConnectionsPage() {
  const searchParams = useSearchParams();
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [youtubeQuota, setYoutubeQuota] = useState<YouTubeQuota | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/scheduler/accounts");
    const payload = await res.json();
    if (payload.success) {
      setAccounts(payload.data.accounts);
      setYoutubeQuota(payload.data.youtubeQuota);
      setCanManage(payload.data.canManage);
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

  const error = searchParams.get("error");
  const connected = searchParams.get("connected");
  const connectedCount = searchParams.get("count");

  if (loading) {
    return <p className="text-sm text-muted">Loading connections…</p>;
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Connections</h1>
        <p className="text-sm text-muted">
          Accounts OpenReply can publish to. Connect as many per platform as you
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

      <div className="grid gap-4 xl:grid-cols-2">
        {PLATFORM_ORDER.map((platform) => {
          const meta = PLATFORM_META[platform];
          const platformAccounts = accounts.filter(
            (a) => a.platform === platform
          );

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
                      {meta.scheduling === "native"
                        ? "The platform holds the schedule."
                        : "OpenReply's worker publishes at the scheduled minute."}
                    </p>
                  </div>
                </div>

                <span className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-muted">
                  {platformAccounts.length}
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

                {platformAccounts.length === 0 ? (
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
                <footer className="border-t border-border px-5 py-3">
                  <a
                    href={`/api/connections/${meta.slug}/connect`}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-background"
                  >
                    <PlatformLogo platform={platform} className="h-4 w-4" />
                    Connect {platformAccounts.length > 0 ? "another" : meta.label}
                  </a>
                </footer>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
