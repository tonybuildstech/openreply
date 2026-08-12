import Image from "next/image";

/* The static import (rather than a bare "/openreply-logo.jpg" string) is
   deliberate: it makes the build fail loudly if the brand file is ever moved or
   renamed, instead of silently shipping a broken image. `scripts/generate-icons.mjs`
   derives favicon.ico / icon.png / apple-icon.png from this exact same file, so
   the tab icon and the on-page icon can never disagree. */
import brandLogo from "@/public/openreply-logo.jpg";

/* Single source of truth for the product name.
   Google's OAuth verification and Meta's app review both compare the name on
   the consent screen against the name rendered on the home page, so this string
   must stay byte-identical to the name configured in the Google Cloud console,
   the Meta app dashboard and TikTok's Basic Info. Do not append a tagline. */
export const BRAND_NAME = "OpenReply";

interface BrandMarkProps {
  /** Rendered size of the square icon tile, in px. */
  size?: number;
  /** Set false to render the icon alone (the name is supplied by the caller). */
  showName?: boolean;
  /** Extra classes on the wrapper — e.g. "justify-center" for centred layouts. */
  className?: string;
  /** Extra classes on the wordmark, for pages that size their own type. */
  nameClassName?: string;
}

/**
 * The OpenReply logo lockup: the square app icon followed by the wordmark.
 *
 * ── Why the icon is shown at all ─────────────────────────────────────────────
 *
 * TikTok rejected the app in August 2026 for "Icon does not match brand". Every
 * header on the site rendered the product name as plain text and nothing else,
 * so there was no icon on the website for a reviewer to match against the square
 * uploaded to TikTok's Basic Info — and the browser tab was still showing the
 * stock Next.js favicon. Reviewers check three places: the platform dashboard,
 * the website, and the tab. This component covers the middle one.
 *
 * ── Why the tile has a border ────────────────────────────────────────────────
 *
 * The logo's own background is #0b0b0d, which is exactly `--color-background`.
 * Without the border the tile blends perfectly into the page and reads as
 * nothing at all, which is the very failure we are fixing. The border is what
 * makes it legible AS an icon.
 *
 * Presentational on purpose: callers already wrap their lockup in their own
 * <Link>, so this renders a <span> and stays nestable inside a link or heading.
 */
export default function BrandMark({
  size = 36,
  showName = true,
  className = "",
  nameClassName = "text-lg font-bold text-white",
}: BrandMarkProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <Image
        src={brandLogo}
        alt={showName ? "" : BRAND_NAME}
        width={size}
        height={size}
        /* Always in the header, so never lazy-load it — a logo that pops in
           after paint is exactly what a reviewer screenshots. */
        priority
        className="shrink-0 rounded-md border border-white/15"
        style={{ width: size, height: size }}
      />
      {showName && <span className={nameClassName}>{BRAND_NAME}</span>}
    </span>
  );
}
