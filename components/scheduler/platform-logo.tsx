/**
 * Platform brand marks, inline.
 *
 * Inline SVG rather than image files on purpose: no network request, no
 * flash of missing logo, and they inherit size from the call site. Brand
 * colours are hardcoded because a monochrome logo is much harder to identify
 * at 20px than a coloured one.
 */

import type { PlatformKey } from "@/components/scheduler/platform-meta";

interface PlatformLogoProps {
  platform: PlatformKey;
  className?: string;
}

export const PLATFORM_BRAND_COLOR: Record<PlatformKey, string> = {
  INSTAGRAM: "#E4405F",
  TIKTOK: "#FE2C55",
  YOUTUBE: "#FF0000",
  FACEBOOK_PAGE: "#1877F2",
};

export default function PlatformLogo({
  platform,
  className = "h-5 w-5",
}: PlatformLogoProps) {
  const color = PLATFORM_BRAND_COLOR[platform];

  switch (platform) {
    case "INSTAGRAM":
      // Drawn geometrically (rounded square, lens, flash) rather than as the
      // official gradient mark — it stays crisp at small sizes and needs no
      // gradient <defs>, which would collide across repeated instances.
      return (
        <svg
          viewBox="0 0 24 24"
          className={className}
          fill="none"
          stroke={color}
          strokeWidth="2"
          aria-hidden="true"
        >
          <rect x="2" y="2" width="20" height="20" rx="6" />
          <circle cx="12" cy="12" r="4.6" />
          <circle cx="17.6" cy="6.4" r="1.3" fill={color} stroke="none" />
        </svg>
      );

    case "YOUTUBE":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
          <path
            fill={color}
            d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z"
          />
          <path fill="#fff" d="M9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
        </svg>
      );

    case "FACEBOOK_PAGE":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
          <path
            fill={color}
            d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"
          />
        </svg>
      );

    case "TIKTOK":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
          {/* The cyan offset behind the note is what makes TikTok's mark
              readable at a glance; without it this reads as a generic note. */}
          <path
            fill="#25F4EE"
            d="M10.7 9.9v-1.5a5.9 5.9 0 0 0-4.4 10.6 5.9 5.9 0 0 1 4.4-9.1z"
          />
          <path
            fill={color}
            d="M12.5.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97a10.6 10.6 0 0 1-1.62-.93c-.01 2.92.01 5.84-.02 8.75a7.5 7.5 0 0 1-1.35 3.94 7.34 7.34 0 0 1-5.91 3.21 7.2 7.2 0 0 1-4.08-1.03A7.36 7.36 0 0 1 1.57 17.2c-.02-.5-.03-1-.01-1.49a7.3 7.3 0 0 1 2.58-4.96 7.13 7.13 0 0 1 6.15-1.72c.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61a3.32 3.32 0 0 0 3.5 2.87 3.23 3.23 0 0 0 2.77-1.61c.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"
          />
        </svg>
      );
  }
}

/**
 * Logo + avatar together — the avatar carries a small platform badge so a
 * workspace with several accounts on several platforms stays scannable.
 */
export function AccountAvatar({
  platform,
  avatarUrl,
  displayName,
  size = "md",
}: {
  platform: PlatformKey;
  avatarUrl: string | null;
  displayName: string;
  size?: "sm" | "md";
}) {
  const box = size === "sm" ? "h-8 w-8" : "h-11 w-11";
  const badge = size === "sm" ? "h-3.5 w-3.5" : "h-4.5 w-4.5";

  return (
    <div className="relative shrink-0">
      {avatarUrl ? (
        // Platform CDN hostnames vary per account (scontent, ggpht, tiktokcdn,
        // fbsbx), so next/image would need an ever-growing remotePatterns list.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt=""
          className={`${box} rounded-full border border-border object-cover`}
        />
      ) : (
        <div
          className={`${box} flex items-center justify-center rounded-full border border-border bg-surface text-sm font-semibold text-muted`}
          aria-hidden="true"
        >
          {displayName.trim().charAt(0).toUpperCase() || "?"}
        </div>
      )}
      <span className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-background p-0.5">
        <PlatformLogo platform={platform} className={badge} />
      </span>
    </div>
  );
}
