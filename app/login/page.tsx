import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn } from "@/lib/auth";
import { getCampaignTemplate } from "@/lib/templates/campaign-templates";

export const metadata = {
  title: "Login - OpenReply",
  description: "Sign in to manage Instagram comment-to-DM campaigns.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    callbackUrl?: string;
    template?: string;
  }>;
}) {
  const params = await searchParams;
  const hasError = params.error != null;
  const selectedTemplate = getCampaignTemplate(params.template);
  const templateCallbackUrl = selectedTemplate
    ? `/campaigns/new?template=${selectedTemplate.slug}`
    : null;
  const callbackUrl = params.callbackUrl ?? templateCallbackUrl ?? "/dashboard";

  async function login(formData: FormData) {
    "use server";
    try {
      await signIn("credentials", {
        email: String(formData.get("email") ?? ""),
        password: String(formData.get("password") ?? ""),
        redirectTo: callbackUrl,
      });
    } catch (error) {
      // signIn throws a redirect on success — only swallow real auth failures.
      if (error instanceof AuthError) {
        redirect(
          `/login?error=1&callbackUrl=${encodeURIComponent(callbackUrl)}`
        );
      }
      throw error;
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-foreground">OpenReply</h1>
          <p className="text-muted text-sm leading-relaxed mt-2">
            {selectedTemplate
              ? `Sign in to use the ${selectedTemplate.title} template.`
              : "Sign in to manage your comment-to-DM campaigns."}
          </p>
        </div>

        <div className="panel rounded p-8 shadow-black/40">
          {selectedTemplate && (
            <div className="mb-5 border border-cyan-200/20 bg-cyan-300/10 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-cyan-100">
                Template selected
              </p>
              <p className="mt-2 text-sm font-semibold text-white">
                {selectedTemplate.title}
              </p>
            </div>
          )}

          {hasError && (
            <div
              role="alert"
              className="mb-5 border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-200"
            >
              Invalid email or password.
            </div>
          )}

          <form action={login} className="space-y-5">
            <div className="space-y-2">
              <label
                htmlFor="email"
                className="block text-sm font-medium text-foreground"
              >
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@company.com"
                className="w-full px-4 py-3 rounded bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none transition-colors"
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="password"
                className="block text-sm font-medium text-foreground"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                placeholder="••••••••"
                className="w-full px-4 py-3 rounded bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none transition-colors"
              />
            </div>

            <button
              type="submit"
              className="w-full inline-flex items-center justify-center gap-2 rounded bg-accent px-6 py-3.5 text-sm font-semibold text-white shadow-indigo-500/25 transition-all hover:shadow-indigo-500/30"
            >
              Sign in
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-muted">
          Accounts are created by your administrator.
        </p>
      </div>
    </div>
  );
}
