import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

/* `applicationName` and `openGraph.siteName` both render the app name into the
   document head. Google's OAuth verification checks that the name on the
   consent screen matches the name on the home page, so these MUST stay exactly
   "OpenReply" — the same string configured in the Google Cloud console and in
   the Meta app dashboard. Do not append a tagline to them. */
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXTAUTH_URL ?? "http://localhost:3000"),
  applicationName: "OpenReply",
  title: "OpenReply - Instagram comment-to-DM automation and video scheduling",
  description:
    "OpenReply is a free social media tool. It sends an automatic Instagram DM when someone comments your keyword on a post or reel, and schedules your videos to Instagram, TikTok, YouTube and Facebook Pages — all through the platforms' official APIs.",
  openGraph: {
    siteName: "OpenReply",
    title: "OpenReply - Instagram comment-to-DM automation and video scheduling",
    description:
      "Free comment-to-DM automation and multi-platform video scheduling, built on the official Meta, Google and TikTok APIs.",
    type: "website",
  },
  keywords: [
    "instagram automation",
    "comment to DM",
    "instagram private replies",
    "social media scheduler",
    "manychat alternative",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full dark">
      <body className="min-h-full bg-background text-foreground font-sans antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
