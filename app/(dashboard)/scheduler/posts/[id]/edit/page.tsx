"use client";

/**
 * Edit a scheduled post.
 *
 * What is editable depends entirely on whether the platform is already holding
 * the post — the server decides that (`lib/scheduler/editing.ts`) and returns a
 * policy, which this page renders rather than guessing. Anything not in
 * `policy.editable` is shown read-only with the reason, so the user learns why
 * instead of hitting a rejected save.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AccountAvatar } from "@/components/scheduler/platform-logo";
import PlatformOptions from "@/components/scheduler/platform-options";
import {
  PLATFORM_META,
  POST_STATUS_LABELS,
  type PlatformKey,
} from "@/components/scheduler/platform-meta";
import type { TargetOptions } from "@/components/scheduler/types";

type EditableField =
  | "caption"
  | "scheduledAt"
  | "platformOptions"
  | "mediaType"
  | "media";

interface EditablePost {
  id: string;
  mediaType: string;
  caption: string;
  scheduledAt: string;
  status: keyof typeof POST_STATUS_LABELS;
  platformOptions: TargetOptions | null;
  /**
   * Ordered by carousel position. Always at least one item; only Instagram
   * carousels have more than one, and this page edits the first — replacing a
   * whole carousel from here is not supported yet.
   */
  media: Array<{
    position: number;
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
    kind: "IMAGE" | "VIDEO";
  }>;
  lastError: string | null;
  connectedAccount: {
    id: string;
    platform: PlatformKey;
    displayName: string;
    avatarUrl: string | null;
    status: string;
    tiktokPostMode: "INBOX" | "DIRECT_POST" | null;
  };
  policy: {
    editable: EditableField[];
    requiresPlatformSync: boolean;
    reason: string | null;
  };
  constraints: { minLeadTimeMinutes: number; maxLeadTimeDays: number };
}

function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export default function EditScheduledPostPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const [post, setPost] = useState<EditablePost | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [caption, setCaption] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [mediaType, setMediaType] = useState("");
  const [options, setOptions] = useState<TargetOptions>({});
  const [newMedia, setNewMedia] = useState<{
    mediaStorageKey: string;
    mimeType: string;
    sizeBytes: number;
    filename: string | null;
  } | null>(null);

  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/scheduler/posts/${params.id}`);
    const payload = await res.json();

    if (!payload.success) {
      setNotFound(true);
      setLoading(false);
      return;
    }

    const data = payload.data as EditablePost;
    setPost(data);
    setCaption(data.caption);
    setScheduledAt(toLocalInputValue(data.scheduledAt));
    setMediaType(data.mediaType);
    setOptions(data.platformOptions ?? {});
    setLoading(false);
  }, [params.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function uploadReplacement(file: File) {
    setUploading(true);
    setError(null);
    try {
      const res = await fetch("/api/media/upload", {
        method: "POST",
        headers: {
          "Content-Type": file.type,
          "x-filename": encodeURIComponent(file.name),
        },
        body: file,
      });
      const payload = await res.json();
      if (!payload.success) {
        setError(payload.error ?? "Upload failed");
        return;
      }
      setNewMedia(payload.data);
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (!post) return;
    setSaving(true);
    setError(null);

    const can = (field: EditableField) => post.policy.editable.includes(field);

    const res = await fetch(`/api/scheduler/posts/${post.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(can("caption") ? { caption } : {}),
        ...(can("scheduledAt")
          ? { scheduledAt: new Date(scheduledAt).toISOString() }
          : {}),
        ...(can("mediaType") ? { mediaType } : {}),
        ...(can("platformOptions") ? { platformOptions: options } : {}),
        ...(can("media") && newMedia
          ? {
              mediaStorageKey: newMedia.mediaStorageKey,
              mediaMimeType: newMedia.mimeType,
            }
          : {}),
      }),
    });

    const payload = await res.json();
    setSaving(false);

    if (!payload.success) {
      setError(payload.error ?? "Could not save this post");
      return;
    }

    router.push("/scheduler");
  }

  if (loading) return <p className="text-sm text-muted">Loading…</p>;

  if (notFound || !post) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted">That scheduled post no longer exists.</p>
        <Link href="/scheduler" className="text-sm underline">
          Back to scheduled posts
        </Link>
      </div>
    );
  }

  const meta = PLATFORM_META[post.connectedAccount.platform];
  const status = POST_STATUS_LABELS[post.status] ?? POST_STATUS_LABELS.QUEUED;
  const can = (field: EditableField) => post.policy.editable.includes(field);
  const locked = post.policy.editable.length === 0;
  // Position 0. Every post has one; the fallback only guards against a row
  // whose media went missing, which would otherwise crash the whole page.
  const currentMedia = post.media[0] ?? {
    position: 0,
    storageKey: "(missing)",
    mimeType: "unknown",
    sizeBytes: 0,
    kind: "VIDEO" as const,
  };

  return (
    <div className="max-w-3xl space-y-5 pb-12">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Edit scheduled post</h1>
        <p className="text-sm text-muted">
          {meta.scheduling === "native"
            ? "This platform holds the schedule, so saving updates the post on the platform directly."
            : "OpenReply publishes this at the scheduled minute, so changes only touch your queue."}
        </p>
      </header>

      {/* Account + status */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="flex items-center gap-3">
          <AccountAvatar
            platform={post.connectedAccount.platform}
            avatarUrl={post.connectedAccount.avatarUrl}
            displayName={post.connectedAccount.displayName}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {post.connectedAccount.displayName}
            </p>
            <p className="text-xs text-muted">{meta.label}</p>
          </div>
          <span className={`text-xs ${status.text}`}>{status.label}</span>
        </div>

        {post.policy.reason && (
          <p
            className={`mt-4 rounded-md border px-3 py-2 text-xs leading-5 ${
              locked
                ? "border-error/30 bg-error/5 text-error"
                : "border-border bg-background text-muted"
            }`}
          >
            {post.policy.reason}
          </p>
        )}
      </section>

      {locked ? (
        <Link
          href="/scheduler"
          className="inline-block rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium transition hover:bg-background"
        >
          Back to scheduled posts
        </Link>
      ) : (
        <>
          {/* Media */}
          <section className="rounded-xl border border-border bg-surface p-5">
            <h2 className="mb-4 text-base font-semibold">Video</h2>
            <div className="rounded-lg border border-border bg-background px-4 py-3">
              <p className="truncate text-sm font-medium">
                {newMedia
                  ? newMedia.filename
                    ? decodeURIComponent(newMedia.filename)
                    : "New video"
                  : currentMedia.storageKey.split("/").pop()}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {(
                  (newMedia?.sizeBytes ?? currentMedia.sizeBytes) /
                  1024 ** 2
                ).toFixed(1)}{" "}
                MB · {newMedia?.mimeType ?? currentMedia.mimeType}
                {newMedia && " · replaces the current file when you save"}
              </p>
              {post.media.length > 1 && (
                <p className="mt-1 text-xs text-warning">
                  This post has {post.media.length} items. Only the first is
                  shown here — editing the file replaces the whole set.
                </p>
              )}
            </div>

            {can("media") ? (
              <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm transition hover:bg-background">
                {uploading ? "Uploading…" : "Replace video"}
                <input
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm"
                  disabled={uploading}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadReplacement(file);
                  }}
                  className="hidden"
                />
              </label>
            ) : (
              <p className="mt-3 text-xs text-muted">
                The file is already uploaded to {meta.label} and cannot be
                swapped — a different video would have to be scheduled fresh.
              </p>
            )}
          </section>

          {/* Caption */}
          <section className="rounded-xl border border-border bg-surface p-5">
            <h2 className="mb-4 text-base font-semibold">Caption</h2>
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              disabled={!can("caption")}
              rows={4}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted focus:border-foreground/30 focus:outline-none disabled:opacity-60"
            />
          </section>

          {/* Time */}
          <section className="rounded-xl border border-border bg-surface p-5">
            <h2 className="mb-4 text-base font-semibold">When</h2>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              disabled={!can("scheduledAt")}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-foreground/30 focus:outline-none disabled:opacity-60"
            />
            <p className="mt-2 text-xs text-muted">
              {Intl.DateTimeFormat().resolvedOptions().timeZone} · at least{" "}
              {post.constraints.minLeadTimeMinutes} minutes ahead, up to{" "}
              {post.constraints.maxLeadTimeDays} days.
            </p>
          </section>

          {/* Platform options */}
          <section className="rounded-xl border border-border bg-surface p-5">
            <h2 className="mb-4 text-base font-semibold">{meta.label} options</h2>

            {can("mediaType") && meta.mediaTypes.length > 1 && (
              <div className="mb-5 space-y-1.5">
                <span className="block text-sm font-medium">Post as</span>
                <div className="flex gap-2">
                  {meta.mediaTypes.map((type) => (
                    <button
                      key={type.value}
                      onClick={() => setMediaType(type.value)}
                      className={`rounded-md border px-3 py-1.5 text-sm transition ${
                        mediaType === type.value
                          ? "border-foreground/30 bg-background font-medium"
                          : "border-border text-muted hover:text-foreground"
                      }`}
                    >
                      {type.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {can("platformOptions") ? (
              <PlatformOptions
                platform={post.connectedAccount.platform}
                mediaType={mediaType}
                value={options}
                tiktokPostMode={post.connectedAccount.tiktokPostMode}
                onChange={(patch) =>
                  setOptions((current) => ({ ...current, ...patch }))
                }
              />
            ) : (
              <p className="text-sm text-muted">
                Options cannot be changed for this post.
              </p>
            )}
          </section>

          {error && (
            <div className="rounded-xl border border-error/40 bg-error/5 px-4 py-3 text-sm text-error">
              {error}
            </div>
          )}

          <div className="flex items-center gap-4">
            <button
              onClick={() => void save()}
              disabled={saving || uploading}
              className="rounded-lg border border-border bg-surface px-5 py-2.5 text-sm font-medium transition hover:bg-background disabled:opacity-50"
            >
              {saving
                ? "Saving…"
                : post.policy.requiresPlatformSync
                  ? `Save and update on ${meta.label}`
                  : "Save changes"}
            </button>
            <Link
              href="/scheduler"
              className="text-sm text-muted hover:underline"
            >
              Cancel
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
