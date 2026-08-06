import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

export const metadata: Metadata = {
  title: "OpenReply - Open source Instagram comment-to-DM automation",
  description:
    "A free, self-hosted ManyChat alternative. Turn Instagram keyword comments into automatic private replies using the official Meta API.",
};

const GITHUB_URL = "https://github.com/diwenne/openreply";

function formatStars(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toLocaleString();
}

const githubIconPath =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z";

const heroStats = [
  { value: "24/7", label: "Comment monitoring" },
  { value: "1", label: "DM per matched comment" },
  { value: "0", label: "Scraping required" },
];

const flowSteps = [
  {
    eyebrow: "Connect",
    title: "Link your Instagram professional account",
    description:
      "Sign in by email and connect Instagram once. No password sharing, no browser automation.",
  },
  {
    eyebrow: "Build",
    title: "Pick a post, keywords, and the DM",
    description:
      "Create a campaign for a reel or post: the keyword to watch, the public reply, and the DM to send.",
  },
  {
    eyebrow: "Deliver",
    title: "Replies go out through the official API",
    description:
      "Webhooks catch comments instantly and a polling sweep catches the ones Instagram never pushes, so nothing is missed. Every send is queued, rate-limited, and logged.",
  },
];

const features = [
  "Password sign-in",
  "Multiple Instagram accounts",
  "Encrypted tokens at rest",
  "Webhook + polling reconciliation",
  "Queue-backed delivery worker",
  "Per-account rate limiting",
  "Tracked links with click stats",
  "DM logs with full status",
  "No plan limits, fully self-hosted",
];

/* Static, faithful copies of the real Overview and Dashboard screens, built in
   the app's own design tokens so what visitors see is what the app looks like. */

function AppWindow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background shadow-2xl shadow-black/50">
      <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-border" />
        <span className="h-2.5 w-2.5 rounded-full bg-border" />
        <span className="h-2.5 w-2.5 rounded-full bg-border" />
        <span className="ml-2 text-xs text-muted">{label}</span>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-surface p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
    </div>
  );
}

const overviewStats = [
  ["Views", "847.2K"],
  ["Reach", "612.4K"],
  ["Likes", "38.1K"],
  ["Comments", "4,204"],
  ["Saved", "9,712"],
  ["Shares", "2,340"],
];

const overviewPosts = [
  ["Spring drop reel", "214.8K", "9.1K", "Apr 3"],
  ["Restock haul", "88.4K", "5.2K", "Mar 28"],
  ["Behind the studio", "51.3K", "3.4K", "Mar 21"],
];

function OverviewPreview() {
  return (
    <AppWindow label="app / overview">
      <div className="flex items-end justify-between">
        <div>
          <h3 className="text-base font-semibold text-foreground">Overview</h3>
          <p className="mt-1 text-xs text-muted">
            Recent — 24 posts from @studio.store
          </p>
        </div>
        <span className="rounded border border-border px-2 py-1 text-xs text-muted">
          Last 50
        </span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {overviewStats.map(([label, value]) => (
          <Stat key={label} label={label} value={value} />
        ))}
      </div>

      <div className="mt-4 rounded border border-border bg-surface p-4">
        <p className="text-sm font-semibold text-foreground">Posts</p>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-zinc-500">
              <th className="pb-2 pr-3 font-medium">Post</th>
              <th className="pb-2 px-3 text-right font-medium">Views</th>
              <th className="pb-2 px-3 text-right font-medium">Likes</th>
              <th className="pb-2 pl-3 text-right font-medium">Date</th>
            </tr>
          </thead>
          <tbody>
            {overviewPosts.map(([post, views, likes, date]) => (
              <tr key={post} className="border-b border-border last:border-0">
                <td className="py-2 pr-3 text-foreground">{post}</td>
                <td className="py-2 px-3 text-right text-muted">{views}</td>
                <td className="py-2 px-3 text-right text-muted">{likes}</td>
                <td className="py-2 pl-3 text-right text-zinc-500">{date}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppWindow>
  );
}

function MatchedCommentCard() {
  return (
    <div className="w-64 rounded-lg border border-border bg-surface p-4 shadow-2xl shadow-black/50">
      <p className="text-xs text-muted">New comment</p>
      <p className="mt-1 text-sm font-semibold text-foreground">@maya.co</p>
      <p className="mt-1 text-sm text-muted">LINK please</p>
      <div className="mt-3 border-t border-border pt-3">
        <p className="text-xs text-muted">
          Matched <span className="text-accent">GUIDE</span>
        </p>
        <p className="mt-1 text-sm font-medium text-success">
          Queued private reply
        </p>
      </div>
    </div>
  );
}

const dashboardStats = [
  ["Active Campaigns", "8"],
  ["DMs Sent", "1,284"],
  ["Skipped", "42"],
  ["Failed", "3"],
  ["Clicks", "356"],
  ["CTR", "27.7%"],
];

const dashboardChart: [string, number][] = [
  ["Mon", 42],
  ["Tue", 68],
  ["Wed", 51],
  ["Thu", 94],
  ["Fri", 120],
  ["Sat", 86],
  ["Sun", 73],
];

const dashboardActivity = [
  ["@maya.co", "Product guide reply", "Sent", "text-success"],
  ["@founder.ray", "Price request", "Sent", "text-success"],
  ["@shop.ava", "Lead magnet", "Queued", "text-warning"],
];

function DashboardPreview() {
  const maxDM = Math.max(...dashboardChart.map(([, n]) => n));
  return (
    <AppWindow label="app / dashboard">
      <h3 className="text-base font-semibold text-foreground">Hello, Maya!</h3>
      <p className="mt-1 text-xs text-muted">2 connected accounts · 340 contacts</p>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {dashboardStats.map(([label, value]) => (
          <Stat key={label} label={label} value={value} />
        ))}
      </div>

      <div className="mt-4 rounded border border-border bg-surface p-4">
        <p className="text-sm font-semibold text-foreground">DMs — Last 7 Days</p>
        <div className="mt-4 flex h-32 items-end gap-2">
          {dashboardChart.map(([day, n]) => (
            <div key={day} className="flex flex-1 flex-col items-center gap-2">
              <span className="text-[10px] text-muted">{n}</span>
              <div
                className="w-full rounded-sm bg-accent"
                style={{ height: `${Math.max((n / maxDM) * 100, 4)}%` }}
              />
              <span className="text-[10px] text-zinc-500">{day}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded border border-border bg-surface p-4">
        <p className="text-sm font-semibold text-foreground">Recent Activity</p>
        <div className="mt-3 space-y-2">
          {dashboardActivity.map(([user, automation, status, color]) => (
            <div
              key={user}
              className="flex items-center justify-between gap-3 border-b border-border py-2 text-sm last:border-0"
            >
              <span className="truncate text-foreground">{user}</span>
              <span className="truncate text-muted">{automation}</span>
              <span className={`text-sm ${color}`}>{status}</span>
            </div>
          ))}
        </div>
      </div>
    </AppWindow>
  );
}

async function getGitHubStars(): Promise<number | null> {
  try {
    const res = await fetch("https://api.github.com/repos/diwenne/openreply", {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: number };
    return typeof data.stargazers_count === "number" ? data.stargazers_count : null;
  } catch {
    return null;
  }
}

export default async function Home() {
  const stars = await getGitHubStars();
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-3" aria-label="OpenReply home">
            <span className="text-lg font-bold text-white">OpenReply</span>
          </Link>

          <div className="flex items-center gap-4">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-400 transition hover:text-white"
              aria-label="View OpenReply on GitHub"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 fill-current">
                <path d={githubIconPath} />
              </svg>
              {stars !== null && <span>{formatStars(stars)}</span>}
            </a>
            <Link
              href="/login"
              className="inline-flex items-center justify-center gap-2 bg-cyan-300 px-4 py-2 text-sm font-bold text-zinc-950 transition hover:bg-cyan-200"
            >
              Get started
            </Link>
          </div>
        </div>
      </header>

      <section className="mx-auto grid w-full max-w-6xl items-center gap-10 px-5 pb-16 pt-12 sm:px-6 sm:pt-18 lg:grid-cols-[0.95fr_1.05fr] lg:px-8 lg:pb-24">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-semibold text-zinc-300">
            Open source · Official Meta, Google and TikTok APIs
          </div>

          {/* The product name leads the H1 on purpose: Google's OAuth
              verification checks that the name on this page matches the name on
              the consent screen, and a headline without it reads as a mismatch. */}
          <h1 className="mt-7 text-balance text-5xl font-black leading-[1.02] text-white sm:text-6xl lg:text-7xl">
            OpenReply makes every comment start the right DM
          </h1>

          <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-300">
            <strong className="font-semibold text-white">OpenReply</strong> is a
            free, self-hosted social media tool for businesses and creators. It
            does two things: it sends an automatic Instagram DM when someone
            comments your keyword on a post or reel, and it schedules your video
            content to Instagram, TikTok, YouTube and Facebook Pages. Everything
            runs on the platforms&apos; own official APIs — no scraping, no
            browser automation, and no password sharing.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/login"
              className="inline-flex items-center justify-center gap-2 bg-cyan-300 px-6 py-3 text-sm font-bold text-zinc-950 transition hover:bg-cyan-200"
            >
              Get started
            </Link>
            <a
              href="#how"
              className="inline-flex items-center justify-center border border-white/10 bg-white/[0.04] px-6 py-3 text-sm font-bold text-white transition hover:border-white/20 hover:bg-white/[0.08]"
            >
              See how it works
            </a>
          </div>

          <dl className="mt-10 grid max-w-xl grid-cols-3 gap-3">
            {heroStats.map((stat) => (
              <div key={stat.label} className="border border-white/10 bg-white/[0.035] p-4">
                <dt className="text-2xl font-black text-white">{stat.value}</dt>
                <dd className="mt-1 text-xs leading-5 text-zinc-500">{stat.label}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="relative">
          <OverviewPreview />
          <div className="absolute -bottom-8 -left-6 hidden lg:block">
            <MatchedCommentCard />
          </div>
        </div>
      </section>

      {/* Written for OAuth verification reviewers as much as for visitors.
          Google rejects apps whose home page does not state what the app is
          for, and rejects YouTube scopes that the page never mentions. Keep the
          scope names and their justifications in sync with
          lib/scheduler/oauth/providers.ts. */}
      <section
        id="about"
        className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-6 lg:px-8"
      >
        <p className="text-sm font-semibold uppercase tracking-widest text-cyan-300">
          About this application
        </p>
        <h2 className="mt-3 text-4xl font-black leading-tight text-white sm:text-5xl">
          What OpenReply does
        </h2>

        <div className="mt-6 max-w-3xl space-y-4 text-lg leading-8 text-zinc-300">
          <p>
            OpenReply is an open-source social media management application for
            businesses and creators who publish short-form video. You connect
            the accounts you already own, and OpenReply automates two jobs you
            would otherwise do by hand.
          </p>
          <p>
            <strong className="font-semibold text-white">
              Comment-to-DM automation.
            </strong>{" "}
            When someone comments a keyword you chose on one of your own
            Instagram posts or reels, OpenReply sends that person the private
            reply you wrote — a link, a discount code, an answer — through
            Instagram&apos;s official messaging API.
          </p>
          <p>
            <strong className="font-semibold text-white">
              Content scheduling.
            </strong>{" "}
            Upload a video once, choose a date and time, and select which of
            your connected accounts should receive it. OpenReply publishes it to
            Instagram Reels, TikTok, YouTube Shorts and Facebook Pages at the
            time you picked. Your original file is uploaded untouched — nothing
            is re-encoded, cropped, or watermarked.
          </p>
        </div>

        <div className="mt-10 max-w-3xl border border-white/10 bg-white/[0.025] p-6">
          <h3 className="text-xl font-bold text-white">
            How OpenReply uses your YouTube data
          </h3>
          <p className="mt-3 leading-7 text-zinc-300">
            When you connect a YouTube channel, OpenReply requests exactly two
            permissions, and uses them only for the scheduling feature described
            above:
          </p>
          <dl className="mt-5 space-y-4">
            <div>
              <dt className="font-mono text-sm text-cyan-300">
                .../auth/youtube.upload
              </dt>
              <dd className="mt-1 leading-7 text-zinc-300">
                Uploads the video file you selected to your own channel and sets
                the publication time you chose. OpenReply never uploads anything
                you did not schedule.
              </dd>
            </div>
            <div>
              <dt className="font-mono text-sm text-cyan-300">
                .../auth/youtube.readonly
              </dt>
              <dd className="mt-1 leading-7 text-zinc-300">
                Reads your channel&apos;s name and thumbnail so the app can show
                you which channel you are posting to, and checks whether a
                scheduled video has gone live.
              </dd>
            </div>
          </dl>
          <p className="mt-5 leading-7 text-zinc-300">
            OpenReply does not read your viewers&apos; data, your analytics, or
            your comments on YouTube. It does not sell, transfer, or use Google
            user data for advertising, and it does not use it to train any AI or
            machine-learning model. You can disconnect a channel at any time from
            the app, which deletes its stored credentials immediately, or revoke
            access at{" "}
            <a
              href="https://myaccount.google.com/permissions"
              target="_blank"
              rel="noreferrer"
              className="underline transition hover:text-white"
            >
              myaccount.google.com/permissions
            </a>
            .
          </p>
          <p className="mt-5 leading-7 text-zinc-300">
            OpenReply&apos;s use of information received from Google APIs
            adheres to the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noreferrer"
              className="underline transition hover:text-white"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements. Full detail is in our{" "}
            <Link href="/privacy" className="underline transition hover:text-white">
              Privacy Policy
            </Link>
            .
          </p>
        </div>
      </section>

      <section id="how" className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-6 lg:px-8">
        <div className="grid gap-10 lg:grid-cols-[0.82fr_1.18fr] lg:items-center">
          <div>
            <p className="text-sm font-bold uppercase text-cyan-200">How it works</p>
            <h2 className="mt-3 text-4xl font-black leading-tight text-white sm:text-5xl">
              A comment in, a DM out
            </h2>
            <p className="mt-5 text-base leading-8 text-zinc-400">
              Three steps. Connect an account, build a campaign, and let it run.
              The webhook handles it live and the poll sweeps up whatever the
              webhook misses.
            </p>
          </div>

          <div className="grid gap-4">
            {flowSteps.map((step) => (
              <article
                key={step.title}
                className="grid gap-4 border border-white/10 bg-white/[0.035] p-5 sm:grid-cols-[120px_1fr]"
              >
                <p className="text-sm font-bold text-cyan-200">{step.eyebrow}</p>
                <div>
                  <h3 className="text-xl font-bold text-white">{step.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-zinc-400">{step.description}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-white/10 bg-white/[0.025] py-20">
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-5 sm:px-6 lg:grid-cols-[1.08fr_0.92fr] lg:px-8 lg:items-center">
          <DashboardPreview />

          <div>
            <p className="text-sm font-bold uppercase text-cyan-200">The dashboard</p>
            <h2 className="mt-3 text-4xl font-black leading-tight text-white sm:text-5xl">
              See exactly what happened
            </h2>
            <p className="mt-5 text-base leading-8 text-zinc-400">
              Every comment event is traceable: queued, matched, sent, skipped,
              failed, or rate-limited. No black box.
            </p>
          </div>
        </div>
      </section>

      <section id="features" className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-6 lg:px-8">
        <div className="max-w-2xl">
          <p className="text-sm font-bold uppercase text-cyan-200">What&rsquo;s included</p>
          <h2 className="mt-3 text-4xl font-black leading-tight text-white sm:text-5xl">
            Everything, no tiers
          </h2>
          <p className="mt-5 text-base leading-8 text-zinc-400">
            It is self-hosted and open source, so there is nothing to unlock. You
            run it, you own it.
          </p>
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature}
              className="border border-white/10 bg-white/[0.035] p-4 text-sm font-semibold text-zinc-200"
            >
              {feature}
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-5 pb-20 sm:px-6 lg:px-8">
        <div className="grid gap-8 border border-white/10 bg-surface p-6 sm:p-10 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <h2 className="max-w-3xl text-4xl font-black leading-tight text-white sm:text-5xl">
              Turn your next reel&rsquo;s comments into DMs
            </h2>
            <p className="mt-4 text-base text-zinc-400">
              Free and open source. Star it if it saves you a subscription.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
            <Link
              href="/login"
              className="inline-flex items-center justify-center gap-2 bg-cyan-300 px-6 py-3 text-sm font-bold text-zinc-950 transition hover:bg-cyan-200"
            >
              Get started
            </Link>
            <a
              href={GITHUB_URL}
              className="inline-flex items-center justify-center border border-white/10 bg-white/[0.04] px-6 py-3 text-sm font-bold text-white transition hover:border-white/20 hover:bg-white/[0.08]"
            >
              View on GitHub
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/10 py-8">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-5 text-sm text-zinc-500 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
          <span className="font-semibold text-zinc-300">OpenReply</span>

          {/* OAuth verification (Google and Meta both) requires the privacy
              policy to be reachable from the home page, not just from a
              settings screen. */}
          <nav className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Link href="/privacy" className="transition hover:text-white">
              Privacy Policy
            </Link>
            <Link href="/terms" className="transition hover:text-white">
              Terms of Service
            </Link>
            <Link href="/data-deletion" className="transition hover:text-white">
              Data Deletion
            </Link>
          </nav>

          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 transition hover:text-white"
          >
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              className="h-4 w-4 fill-current"
            >
              <path d={githubIconPath} />
            </svg>
            {stars !== null && <span>{formatStars(stars)}</span>}
          </a>
        </div>
      </footer>
    </main>
  );
}
