"use client";

/**
 * Scheduled posts — grouped by day, one card per post.
 *
 * Status wording is deliberately literal. "Scheduled" means the platform is
 * holding it (YouTube, Facebook); "Queued" means OpenReply's worker will
 * publish it (Instagram, TikTok) and therefore depends on the worker running.
 * Those are different promises and the list does not blur them.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AccountAvatar } from "@/components/scheduler/platform-logo";
import {
  PLATFORM_META,
  POST_STATUS_LABELS,
  type PlatformKey,
} from "@/components/scheduler/platform-meta";

interface ScheduledPost {
  id: string;
  mediaType: string;
  caption: string;
  scheduledAt: string;
  status: keyof typeof POST_STATUS_LABELS;
  platformPostId: string | null;
  lastError: string | null;
  attemptCount: number;
  publishedAt: string | null;
  batchId: string | null;
  connectedAccount: {
    id: string;
    platform: PlatformKey;
    displayName: string;
    avatarUrl: string | null;
    status: string;
  };
}

const FILTERS = [
  "ALL",
  "QUEUED",
  "SCHEDULED_REMOTE",
  "PUBLISHED",
  "FAILED",
] as const;

const STATUS_DOT: Record<string, string> = {
  QUEUED: "bg-warning",
  UPLOADING: "bg-warning",
  PUBLISHING: "bg-warning",
  SCHEDULED_REMOTE: "bg-muted",
  PUBLISHED: "bg-success",
  FAILED: "bg-error",
  CANCELED: "bg-border",
};

function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default function SchedulerPage() {
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("ALL");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = filter === "ALL" ? "" : `?status=${filter}`;
    const res = await fetch(`/api/scheduler/posts${params}`);
    const payload = await res.json();
    if (payload.success) setPosts(payload.data);
    setLoading(false);
  }, [filter]);

  // Deferred so the fetch's setState lands after the first paint rather than
  // synchronously inside the effect — same pattern as the DM Logs page.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function act(post: ScheduledPost, action: "retry" | "cancel") {
    if (action === "cancel" && !confirm("Cancel this scheduled post?")) {
      return;
    }

    setBusy(post.id);
    setActionError(null);

    const res = await fetch(`/api/scheduler/posts/${post.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const payload = await res.json();

    setBusy(null);
    if (!payload.success) {
      // Cancelling a natively-scheduled post can genuinely fail — Facebook
      // documents no cancel path for Reels. Surface it rather than pretending.
      setActionError(payload.error ?? "That action failed");
      return;
    }
    void load();
  }

  /**
   * Offered on failed posts, which are otherwise stuck in the list forever:
   * retrying is not always wanted and cancelling a post that already failed
   * says nothing. This drops the record and its video for good.
   */
  async function remove(post: ScheduledPost) {
    if (
      !confirm(
        "Delete this failed post? The record and its uploaded video are removed for good."
      )
    ) {
      return;
    }

    setBusy(post.id);
    setActionError(null);

    const res = await fetch(`/api/scheduler/posts/${post.id}`, {
      method: "DELETE",
    });
    const payload = await res.json().catch(() => ({ success: false }));

    setBusy(null);
    if (!payload.success) {
      setActionError(payload.error ?? "Could not delete that post");
      return;
    }
    void load();
  }

  const grouped = posts.reduce<Record<string, ScheduledPost[]>>((acc, post) => {
    const key = dayKey(post.scheduledAt);
    (acc[key] ??= []).push(post);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Scheduled posts</h1>
          <p className="text-sm text-muted">
            Everything queued, scheduled, and published across your accounts.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link
            href="/connections"
            className="rounded-lg border border-border px-3 py-2 text-sm transition hover:bg-surface"
          >
            Connections
          </Link>
          <Link
            href="/scheduler/compose"
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium transition hover:bg-background"
          >
            New post
          </Link>
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((option) => (
          <button
            key={option}
            onClick={() => setFilter(option)}
            className={`rounded-full border px-3.5 py-1.5 text-sm transition ${
              filter === option
                ? "border-foreground/25 bg-surface font-medium"
                : "border-border text-muted hover:text-foreground"
            }`}
          >
            {option === "ALL"
              ? "All"
              : (POST_STATUS_LABELS[option]?.label ?? option)}
          </button>
        ))}
      </div>

      {actionError && (
        <div className="rounded-lg border border-error/40 bg-error/5 px-4 py-3 text-sm text-error">
          {actionError}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : posts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <p className="text-sm text-muted">Nothing scheduled yet.</p>
          <Link
            href="/scheduler/compose"
            className="mt-3 inline-block rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium transition hover:bg-background"
          >
            Schedule your first post
          </Link>
        </div>
      ) : (
        Object.entries(grouped).map(([day, dayPosts]) => (
          <section key={day} className="space-y-2">
            <h2 className="text-sm font-medium text-muted">{day}</h2>
            <div className="grid gap-3 lg:grid-cols-2">
              {dayPosts.map((post) => {
                const status =
                  POST_STATUS_LABELS[post.status] ?? POST_STATUS_LABELS.QUEUED;
                const platform = PLATFORM_META[post.connectedAccount.platform];
                const pending =
                  post.status === "QUEUED" ||
                  post.status === "SCHEDULED_REMOTE" ||
                  post.status === "UPLOADING";
                // Mirrors lib/scheduler/editing.ts. A SCHEDULED_REMOTE post is
                // editable only on platforms whose adapter can push the change;
                // the edit page re-checks with the server and explains why if
                // not, so this only decides whether to offer the link.
                const editable =
                  post.status === "QUEUED" ||
                  post.status === "FAILED" ||
                  post.status === "CANCELED" ||
                  (post.status === "SCHEDULED_REMOTE" &&
                    (post.connectedAccount.platform === "YOUTUBE" ||
                      post.connectedAccount.platform === "FACEBOOK_PAGE"));

                return (
                  <article
                    key={post.id}
                    className="flex flex-col justify-between rounded-xl border border-border bg-surface p-4"
                  >
                    <div className="flex items-start gap-3">
                      <AccountAvatar
                        platform={post.connectedAccount.platform}
                        avatarUrl={post.connectedAccount.avatarUrl}
                        displayName={post.connectedAccount.displayName}
                      />

                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold">
                            {new Date(post.scheduledAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                          <span className="truncate text-sm text-muted">
                            {post.connectedAccount.displayName}
                          </span>
                        </div>
                        <p className="text-xs text-muted">
                          {platform?.label} ·{" "}
                          {platform?.mediaTypes.find(
                            (t) => t.value === post.mediaType
                          )?.label ?? post.mediaType}
                        </p>
                        {post.caption && (
                          <p className="line-clamp-2 text-sm text-muted">
                            {post.caption}
                          </p>
                        )}
                      </div>

                      <span className="flex shrink-0 items-center gap-1.5">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[post.status] ?? "bg-border"}`}
                        />
                        <span className={`text-xs ${status.text}`}>
                          {status.label}
                        </span>
                      </span>
                    </div>

                    {post.lastError && (
                      <p
                        className={`mt-3 rounded-md px-2.5 py-2 text-xs leading-5 ${
                          post.status === "FAILED"
                            ? "border border-error/30 bg-error/5 text-error"
                            : "border border-border bg-background text-muted"
                        }`}
                      >
                        {post.lastError}
                      </p>
                    )}

                    <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
                      <span className="text-xs text-muted">
                        {post.attemptCount > 1
                          ? `${post.attemptCount} attempts`
                          : ""}
                      </span>
                      <div className="flex items-center gap-3">
                        {editable && (
                          <Link
                            href={`/scheduler/posts/${post.id}/edit`}
                            className="text-xs transition hover:underline"
                          >
                            Edit
                          </Link>
                        )}
                        {pending && (
                          <button
                            onClick={() => void act(post, "cancel")}
                            disabled={busy === post.id}
                            className="text-xs text-muted transition hover:text-error disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        )}
                        {(post.status === "FAILED" ||
                          post.status === "CANCELED") && (
                          <button
                            onClick={() => void act(post, "retry")}
                            disabled={busy === post.id}
                            className="text-xs transition hover:underline disabled:opacity-50"
                          >
                            Retry
                          </button>
                        )}
                        {post.status === "FAILED" && (
                          <button
                            onClick={() => void remove(post)}
                            disabled={busy === post.id}
                            className="text-xs text-muted transition hover:text-error disabled:opacity-50"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
