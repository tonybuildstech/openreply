"use client";

/**
 * Scheduled posts — grouped by day, with per-item retry and cancel.
 *
 * Status wording is deliberately literal. "Scheduled" means the platform is
 * holding it (YouTube, Facebook); "Queued" means OpenReply's worker will
 * publish it (Instagram, TikTok) and therefore depends on the worker running.
 * Those are genuinely different promises and the list does not blur them.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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
    if (
      action === "cancel" &&
      !confirm("Cancel this scheduled post?")
    ) {
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

  const grouped = posts.reduce<Record<string, ScheduledPost[]>>((acc, post) => {
    const key = dayKey(post.scheduledAt);
    (acc[key] ??= []).push(post);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Scheduled posts</h1>
          <p className="text-sm text-muted">
            Everything queued, scheduled, and published across your accounts.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link
            href="/scheduler/connections"
            className="rounded border border-border px-3 py-1.5 text-sm hover:bg-surface"
          >
            Connections
          </Link>
          <Link
            href="/scheduler/compose"
            className="rounded border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface"
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
            className={`rounded border px-3 py-1 text-sm ${
              filter === option
                ? "border-border bg-surface font-medium"
                : "border-transparent text-muted hover:bg-surface"
            }`}
          >
            {option === "ALL"
              ? "All"
              : POST_STATUS_LABELS[option]?.label ?? option}
          </button>
        ))}
      </div>

      {actionError && <p className="text-sm text-error">{actionError}</p>}

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : posts.length === 0 ? (
        <p className="rounded border border-border bg-surface px-4 py-3 text-sm text-muted">
          Nothing scheduled yet.{" "}
          <Link href="/scheduler/compose" className="underline">
            Schedule your first post
          </Link>
          .
        </p>
      ) : (
        Object.entries(grouped).map(([day, dayPosts]) => (
          <section key={day} className="space-y-2">
            <h2 className="text-sm font-medium text-muted">{day}</h2>
            <ul className="space-y-2">
              {dayPosts.map((post) => {
                const status =
                  POST_STATUS_LABELS[post.status] ?? POST_STATUS_LABELS.QUEUED;
                const platform = PLATFORM_META[post.connectedAccount.platform];
                const pending =
                  post.status === "QUEUED" ||
                  post.status === "SCHEDULED_REMOTE" ||
                  post.status === "UPLOADING";

                return (
                  <li
                    key={post.id}
                    className="rounded border border-border bg-surface px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm">
                          <span className="font-medium">
                            {new Date(post.scheduledAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>{" "}
                          <span className="text-muted">
                            {platform?.label} · {post.connectedAccount.displayName}
                          </span>
                        </p>
                        {post.caption && (
                          <p className="truncate text-sm text-muted">
                            {post.caption}
                          </p>
                        )}
                        {post.lastError && (
                          <p
                            className={`text-sm ${
                              post.status === "FAILED"
                                ? "text-error"
                                : "text-muted"
                            }`}
                          >
                            {post.lastError}
                          </p>
                        )}
                        {post.attemptCount > 1 && (
                          <p className="text-sm text-muted">
                            {post.attemptCount} attempts
                          </p>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-3">
                        <span className={`text-sm ${status.text}`}>
                          {status.label}
                        </span>
                        {pending && (
                          <button
                            onClick={() => void act(post, "cancel")}
                            disabled={busy === post.id}
                            className="text-sm text-muted hover:underline disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        )}
                        {(post.status === "FAILED" ||
                          post.status === "CANCELED") && (
                          <button
                            onClick={() => void act(post, "retry")}
                            disabled={busy === post.id}
                            className="text-sm hover:underline disabled:opacity-50"
                          >
                            Retry
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
