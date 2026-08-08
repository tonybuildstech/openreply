"use client";

/**
 * Tag people in one media item.
 *
 * Per ITEM, not per post, because that is how Instagram works: a person is
 * tagged in a specific photo of a carousel, and the container that carries the
 * tag is that photo's own child container. A post-level list has no way to say
 * which photo someone is in — which is why the old composer-wide "Tag people"
 * field could never work for a carousel.
 *
 * ── Why you place the tag ────────────────────────────────────────────────────
 *
 * Meta documents image tags as `{username, x, y}` with the coordinates
 * REQUIRED, as fractions from the top-left. Clicking the photo to place a tag
 * is both the familiar gesture and the only way to supply them honestly; the
 * adapter falls back to the centre for anything left unplaced rather than
 * sending an incomplete tag.
 *
 * Video is different: Meta documents video tags as `{username}` alone, so the
 * placement step is hidden there rather than collecting a number we discard.
 */

import { useEffect, useRef, useState } from "react";
import type { MediaUserTag } from "@/components/scheduler/types";

interface TagPeopleModalProps {
  open: boolean;
  previewUrl: string;
  filename: string;
  kind: "IMAGE" | "VIDEO";
  /** Item number in the carousel, for the heading. */
  position: number;
  maxTags: number;
  tags: MediaUserTag[];
  onSave: (tags: MediaUserTag[]) => void;
  onClose: () => void;
}

/** Instagram usernames: letters, digits, dots, underscores. */
const USERNAME_PATTERN = /^[A-Za-z0-9._]+$/;

export default function TagPeopleModal({
  open,
  previewUrl,
  filename,
  kind,
  position,
  maxTags,
  tags,
  onSave,
  onClose,
}: TagPeopleModalProps) {
  /*
   * Edited as a local copy and committed on save, so Cancel really cancels.
   * Keyed by `open` in the parent, which remounts this on each opening — that
   * is what seeds the draft from the current tags without an effect that would
   * fight the user's typing.
   */
  const [draft, setDraft] = useState<MediaUserTag[]>(tags);
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Which tag is being positioned. Null means the next click adds nothing. */
  const [placing, setPlacing] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const canPlace = kind === "IMAGE";

  function addTag() {
    const cleaned = username.trim().replace(/^@/, "");

    if (!cleaned) return;
    if (!USERNAME_PATTERN.test(cleaned)) {
      setError("Usernames use letters, numbers, dots and underscores.");
      return;
    }
    if (draft.length >= maxTags) {
      setError(`Instagram allows up to ${maxTags} people per item.`);
      return;
    }
    if (
      draft.some((tag) => tag.username.toLowerCase() === cleaned.toLowerCase())
    ) {
      setError(`${cleaned} is already tagged here.`);
      return;
    }

    // Centred until placed. The adapter uses the same default, so an unplaced
    // tag behaves identically whether or not the user opens this again.
    setDraft([...draft, { username: cleaned, x: 0.5, y: 0.5 }]);
    setUsername("");
    setError(null);
    if (canPlace) setPlacing(draft.length);
  }

  function placeAt(event: React.MouseEvent<HTMLDivElement>) {
    if (placing === null || !canPlace) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;

    const x = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
    const y = Math.min(Math.max((event.clientY - box.top) / box.height, 0), 1);

    setDraft(
      draft.map((tag, index) => (index === placing ? { ...tag, x, y } : tag))
    );
    setPlacing(null);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Tag people in item ${position}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-surface p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Tag people</h2>
            <p className="text-xs text-muted">
              Item {position} · {filename}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded border border-border px-2 py-0.5 text-sm text-muted transition hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <div className="mb-4 flex justify-center rounded-lg bg-background p-2">
          <div
            onClick={placeAt}
            className={`relative inline-block ${
              placing !== null ? "cursor-crosshair" : ""
            }`}
          >
            {kind === "IMAGE" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt={filename}
                draggable={false}
                className="block max-h-64 max-w-full select-none"
              />
            ) : (
              <video
                src={previewUrl}
                muted
                playsInline
                className="block max-h-64 max-w-full"
              />
            )}

            {canPlace &&
              draft.map((tag, index) => (
                <span
                  key={tag.username}
                  className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-black/75 px-1.5 py-0.5 text-[11px] text-white ${
                    placing === index ? "ring-2 ring-white" : ""
                  }`}
                  style={{
                    left: `${(tag.x ?? 0.5) * 100}%`,
                    top: `${(tag.y ?? 0.5) * 100}%`,
                  }}
                >
                  @{tag.username}
                </span>
              ))}
          </div>
        </div>

        {canPlace ? (
          <p className="mb-3 text-xs text-muted">
            {placing !== null
              ? `Click the photo to place @${draft[placing]?.username}.`
              : "Add a username, then click the photo to place the tag. Unplaced tags sit in the centre."}
          </p>
        ) : (
          <p className="mb-3 text-xs text-muted">
            Instagram tags people on a video by username only — there is nothing
            to position.
          </p>
        )}

        <div className="mb-2 flex gap-2">
          <input
            ref={inputRef}
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addTag();
              }
            }}
            placeholder="username"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted focus:border-foreground/30 focus:outline-none"
          />
          <button
            type="button"
            onClick={addTag}
            disabled={draft.length >= maxTags}
            className="shrink-0 rounded-md border border-border px-3 py-2 text-sm transition hover:bg-background disabled:opacity-40"
          >
            Add
          </button>
        </div>

        {error && <p className="mb-2 text-xs text-error">{error}</p>}

        {draft.length > 0 ? (
          <ul className="mb-4 space-y-1">
            {draft.map((tag, index) => (
              <li
                key={tag.username}
                className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">@{tag.username}</span>
                {canPlace && (
                  <button
                    type="button"
                    onClick={() => setPlacing(index)}
                    className="shrink-0 text-xs text-muted underline transition hover:text-foreground"
                  >
                    {placing === index ? "click the photo…" : "move"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setDraft(draft.filter((_, i) => i !== index));
                    setPlacing(null);
                  }}
                  aria-label={`Remove ${tag.username}`}
                  className="shrink-0 text-xs text-muted transition hover:text-error"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-4 text-xs text-muted">Nobody tagged yet.</p>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onSave(draft)}
            className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium transition hover:bg-surface"
          >
            Save {draft.length > 0 ? `${draft.length} tag${draft.length === 1 ? "" : "s"}` : ""}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-muted hover:underline"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
