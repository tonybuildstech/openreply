"use client";

/**
 * Connections — every publishing account, grouped by platform.
 *
 * The design rule here: a connected account is not necessarily an account that
 * can post publicly. YouTube forces uploads private until the Google Cloud
 * project passes an audit, and TikTok delivers to the creator's inbox unless
 * the app passes theirs. Both are stated on the card, because a connect button
 * leading to an invisible post is worse than no button at all.
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
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
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Connections</h1>
        <p className="text-sm text-muted">
          Accounts OpenReply can publish to. Connect as many per platform as you
          like.
        </p>
      </header>

      {error && (
        <p className="text-sm text-error">
          {ERROR_MESSAGES[error] ?? "Something went wrong."}
        </p>
      )}
      {connected && (
        <p className="text-sm text-success">
          Connected {connectedCount ?? 1} account
          {Number(connectedCount ?? 1) === 1 ? "" : "s"}.
        </p>
      )}

      {PLATFORM_ORDER.map((platform) => {
        const meta = PLATFORM_META[platform];
        const platformAccounts = accounts.filter(
          (a) => a.platform === platform
        );

        return (
          <section key={platform} className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-medium">{meta.label}</h2>
                <p className="text-sm text-muted">{meta.schedulingNote}</p>
              </div>
              {canManage && (
                <a
                  href={`/api/connections/${meta.slug}/connect`}
                  className="shrink-0 rounded border border-border px-3 py-1.5 text-sm hover:bg-surface"
                >
                  Connect{platformAccounts.length > 0 ? " another" : ""}
                </a>
              )}
            </div>

            {platform === "YOUTUBE" && youtubeQuota && (
              <p className="text-sm text-muted">
                Daily quota: {youtubeQuota.used.toLocaleString()} /{" "}
                {youtubeQuota.limit.toLocaleString()} units used —{" "}
                <strong>{youtubeQuota.remainingUploads} upload(s) left</strong>{" "}
                today. Each upload costs 1,600 units, so the default Google quota
                allows about six per day across the whole installation.
              </p>
            )}

            {platformAccounts.length === 0 ? (
              <p className="rounded border border-border bg-surface px-4 py-3 text-sm text-muted">
                No {meta.label} accounts connected.
              </p>
            ) : (
              <ul className="space-y-2">
                {platformAccounts.map((account) => (
                  <li
                    key={account.id}
                    className="flex items-start justify-between gap-4 rounded border border-border bg-surface px-4 py-3"
                  >
                    <div className="flex items-start gap-3">
                      {account.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={account.avatarUrl}
                          alt=""
                          className="h-9 w-9 rounded-full object-cover"
                        />
                      ) : (
                        <div className="h-9 w-9 rounded-full bg-border" />
                      )}
                      <div className="space-y-1">
                        <p className="text-sm font-medium">
                          {account.displayName}
                        </p>
                        {account.status === "NEEDS_REAUTH" && (
                          <p className="text-sm text-error">
                            Access expired — reconnect this account to resume
                            posting.
                          </p>
                        )}
                        {account.limitation && (
                          <p className="text-sm text-warning">
                            {account.limitation}
                          </p>
                        )}
                      </div>
                    </div>

                    {canManage && (
                      <button
                        onClick={() => void disconnect(account)}
                        disabled={busy === account.id}
                        className="shrink-0 text-sm text-error hover:underline disabled:opacity-50"
                      >
                        {busy === account.id ? "Removing…" : "Disconnect"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
