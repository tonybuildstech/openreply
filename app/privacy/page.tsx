import type { Metadata } from "next";
import LegalShell from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Privacy Policy - OpenReply",
  description:
    "How OpenReply handles Instagram, YouTube, TikTok and Facebook account data, webhook payloads, and customer campaign information.",
};

export default function PrivacyPage() {
  return (
    <LegalShell
      title="Privacy Policy"
      description="OpenReply helps businesses send Meta-compliant private replies when people comment on connected Instagram posts or reels."
      updatedAt="May 24, 2026"
    >
      <section>
        <h2 className="text-xl font-bold text-white">Data We Collect</h2>
        <p className="mt-3">
          We collect account email addresses for authentication, workspace and
          billing metadata, connected Instagram account identifiers, encrypted
          Instagram access tokens, campaign settings, webhook payloads,
          comments needed to process campaigns, delivery logs, and operational
          diagnostics.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">How We Use Data</h2>
        <p className="mt-3">
          We use this data to authenticate users, connect Instagram
          integrations, match comment keywords, send private replies through the
          official Meta APIs, prevent duplicate sends, troubleshoot failures,
          and protect the service.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Instagram And Meta Data</h2>
        <p className="mt-3">
          OpenReply does not ask for Instagram passwords, scrape Instagram, or
          use browser automation. Instagram tokens are encrypted at rest and are
          used only to perform actions authorized by the connected business
          account.
        </p>
      </section>

      {/* Required by Google's OAuth verification: the privacy policy must
          disclose what Google user data is accessed and state Limited Use
          compliance verbatim. Keep the scope list in sync with
          lib/scheduler/oauth/providers.ts. */}
      <section>
        <h2 className="text-xl font-bold text-white">
          Google And YouTube Data
        </h2>
        <p className="mt-3">
          If you connect a YouTube channel, OpenReply requests two Google OAuth
          scopes and uses them only to schedule and publish the videos you
          choose: <code>youtube.upload</code> to upload your video file to your
          own channel and set the publication time you selected, and{" "}
          <code>youtube.readonly</code> to read the channel name and thumbnail
          shown in the app and to check whether a scheduled video has gone live.
        </p>
        <p className="mt-3">
          We store your Google access and refresh tokens encrypted at rest with
          AES-256-GCM, and your channel&apos;s name, ID, and thumbnail URL. We do
          not access your YouTube analytics, your viewers&apos; data, or comments
          on your videos. We do not sell or transfer Google user data, do not use
          it for advertising, and do not use it to develop, improve, or train
          generalized AI or machine-learning models. Human access to Google user
          data occurs only with your explicit permission for support, or where
          required by law.
        </p>
        <p className="mt-3">
          OpenReply&apos;s use of information received from Google APIs adheres
          to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
        <p className="mt-3">
          You can disconnect a YouTube channel at any time from the app&apos;s
          Scheduler settings, which deletes its stored tokens immediately, or
          revoke OpenReply&apos;s access at{" "}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            myaccount.google.com/permissions
          </a>
          .
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">
          TikTok And Facebook Data
        </h2>
        <p className="mt-3">
          If you connect a TikTok account or a Facebook Page, OpenReply stores
          encrypted access tokens and the account or Page name, ID, and avatar,
          and uses them only to publish the content you schedule. Video files you
          upload are stored on the server running this instance and are sent
          unmodified to the platform you selected.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Subprocessors</h2>
        <p className="mt-3">
          The production service may use hosting, database, Redis queue, email,
          and observability providers such as Vercel, Railway, PostgreSQL,
          Redis, and Resend. These providers process data only as needed to run
          the service.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Retention And Deletion</h2>
        <p className="mt-3">
          Customers can disconnect Instagram from settings, which removes the
          stored Instagram connection and stops campaigns. For account or data
          deletion, follow the Data Deletion page linked from the footer.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Contact</h2>
        <p className="mt-3">
          For privacy questions, contact the repository owner through GitHub or
          the support email configured for the hosted OpenReply service.
        </p>
      </section>
    </LegalShell>
  );
}
