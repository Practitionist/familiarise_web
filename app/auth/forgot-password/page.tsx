"use client";

import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { pendingToast } from "@/hooks/use-toast";
import {
  humanizeAuthError,
  type AuthErrorAction,
} from "@/lib/labels/auth-errors";
import {
  AuthErrorAffordance,
  type AuthActionTarget,
} from "@/components/auth/AuthErrorAffordance";
import { useRetryAfterCapture } from "@/components/auth/useRetryAfterCapture";
import { authClient, useSession } from "@/lib/auth-client";
import { GlobeIcon } from "@/components/auth/auth-icons";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";

/** Customer-facing support mailbox. Mirrors `lib/labels/org-errors.ts`. */
const SUPPORT_EMAIL =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@familiarisenow.com";

export default function ForgotPassword() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  // The catalog's "what to do next" for the last failure.
  const [errorAction, setErrorAction] = useState<AuthErrorAction | null>(null);
  const retryAfter = useRetryAfterCapture();

  // Redirect authenticated users away from forgot-password. `replace` (not
  // push) so /auth/* never lands in history — Back from the dashboard used to
  // remount this page and bounce forward again. Idempotency ref keeps
  // duplicate session-store emissions from queueing repeat navigations.
  const navigatedRef = useRef(false);
  useEffect(() => {
    if (!isPending && session?.user?.id && !navigatedRef.current) {
      navigatedRef.current = true;
      router.replace("/dashboard");
    }
  }, [isPending, session, router]);

  const handleRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setMessage(null); // Clear previous messages
    setErrorAction(null);
    retryAfter.clear();
    const settle = pendingToast({ title: "Sending reset link..." });

    try {
      const { error } = await authClient.requestPasswordReset({
        email,
        redirectTo: "/auth/reset-password",
        // Reads `Retry-After` off the response — see
        // `components/auth/useRetryAfterCapture.ts`. Reset requests are a
        // classic enumeration vector, so the limiter is tight here and the
        // honest wait is the most useful thing the page can say.
        ...retryAfter.fetchOptions,
      });
      if (error) {
        const copy = humanizeAuthError("forgot", error, {
          retryAfterSeconds: retryAfter.take(),
        });
        setErrorAction(copy.action ?? null);
        setMessage({ kind: "error", text: copy.description });
        settle({
          title: copy.title,
          description: copy.description,
          variant: "destructive",
        });
      } else {
        // The server answers the same way whether or not the address exists.
        const successMessage = `If an account exists for ${email}, we've sent a reset link. It works once and expires in 30 minutes.`;
        setMessage({ kind: "success", text: successMessage });
        settle({ title: "Request Sent", description: successMessage });
      }
    } catch (error: unknown) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "auth" } },
      );
      console.error("Forgot password error:", error);
      const copy = humanizeAuthError("forgot", { status: 0 });
      setErrorAction(copy.action ?? null);
      setMessage({ kind: "error", text: copy.description });
      settle({
        title: copy.title,
        description: copy.description,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Which catalog actions this page can service.
   *
   * Only `contact-support`: the two other actions that can arise here
   * (`retry`, `request-new-link`) are answered by the form itself — the
   * submit button is the retry, and *this page* is the new-link request.
   * Rendering either would be a control that navigates to the page you are
   * already on.
   */
  const actionTargets: Partial<Record<AuthErrorAction, AuthActionTarget>> = {
    "contact-support": { kind: "link", href: `mailto:${SUPPORT_EMAIL}` },
  };

  const errorTarget = errorAction ? actionTargets[errorAction] : undefined;

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 p-6 text-white">
      <div className="mx-auto flex w-full max-w-md flex-col">
        <div className="mb-6 flex justify-center">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm font-semibold tracking-wider text-white uppercase"
          >
            <GlobeIcon className="h-5 w-5" /> Familiarise
          </Link>
        </div>
        <div className="rounded-2xl border border-white/10 bg-zinc-900/40 p-6 sm:p-8">
          <div className="text-center">
            <h2 className="text-fluid-3xl font-semibold tracking-tight">
              Forgot your password?
            </h2>
            <p className="mt-2 text-sm text-zinc-400 md:text-base">
              Enter your email address and we&apos;ll send you a link to reset
              it.
            </p>
          </div>
          <form className="mt-6 space-y-5" onSubmit={handleRequestReset}>
            <div className="grid gap-2">
              <Label htmlFor="email" className="sr-only">
                Email address
              </Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isLoading}
              />
            </div>

            {message && (
              <p
                className={`text-sm ${message.kind === "error" ? "text-red-400" : "text-green-400"}`}
              >
                {message.text}
              </p>
            )}

            {/* The catalog's next step for the last failure, if this page can
                service it. One line, no repeated sentence — the toast already
                carried the title and description. */}
            <AuthErrorAffordance
              action={errorAction ?? undefined}
              target={errorTarget}
            />

            <Button
              type="submit"
              className="w-full bg-white text-black hover:bg-white/90"
              disabled={isLoading}
            >
              {isLoading ? "Sending..." : "Send Reset Link"}
            </Button>
          </form>
          <div className="mt-6 text-center text-sm">
            <Link
              href="/auth/signin"
              className="font-medium text-zinc-300 underline-offset-4 hover:text-white hover:underline"
            >
              Remembered your password? Sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
