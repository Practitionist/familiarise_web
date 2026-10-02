"use client";

import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { pendingToast, useToast } from "@/hooks/use-toast";
import {
  humanizeAuthError,
  type AuthErrorAction,
} from "@/lib/labels/auth-errors";
import {
  AuthErrorAffordance,
  type AuthActionTarget,
} from "@/components/auth/AuthErrorAffordance";
import { useRetryAfterCapture } from "@/components/auth/useRetryAfterCapture";
import { authClient } from "@/lib/auth-client";
import { GlobeIcon } from "@/components/auth/auth-icons";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, Suspense } from "react";
import { AuthCardSkeleton } from "../AuthCardSkeleton";

/** Customer-facing support mailbox. Mirrors `lib/labels/org-errors.ts`. */
const SUPPORT_EMAIL =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@familiarisenow.com";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <ResetPasswordContent />
    </Suspense>
  );
}

function ResetPasswordContent() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  // Better Auth redirects here with ?error=INVALID_TOKEN when the link's
  // token fails before the form is ever shown.
  const linkError = searchParams.get("error");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  // The catalog's "what to do next" for the last failure — on this page it
  // is almost always `request-new-link`, which the effect below only reaches
  // after a 3-second auto-redirect; the affordance lets the customer skip
  // the wait.
  const [errorAction, setErrorAction] = useState<AuthErrorAction | null>(null);
  const retryAfter = useRetryAfterCapture();

  useEffect(() => {
    if (!token || linkError) {
      const copy = humanizeAuthError("reset", {
        code: linkError ?? "INVALID_TOKEN",
      });
      setError(copy.description);
      setErrorAction(copy.action ?? null);
      toast({
        title: copy.title,
        description: copy.description,
        variant: "destructive",
      });
      // Auto-redirect to forgot-password after 3 seconds
      const timer = setTimeout(() => {
        router.push("/auth/forgot-password");
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [token, linkError, router, toast]);

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) {
      setError("Invalid or missing password reset token.");
      return;
    }
    if (password !== confirmPassword) {
      setError("The two passwords don't match.");
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    if (password.length < 8 || password.length > 128) {
      setError("Use 8 to 128 characters.");
      return;
    }

    setIsLoading(true);
    setMessage("");
    setError("");
    setErrorAction(null);
    retryAfter.clear();
    const settle = pendingToast({ title: "Resetting password..." });

    try {
      const { error: resetError } = await authClient.resetPassword({
        newPassword: password,
        token,
        // Reads `Retry-After` off the response — see
        // `components/auth/useRetryAfterCapture.ts`.
        ...retryAfter.fetchOptions,
      });
      if (resetError) {
        const copy = humanizeAuthError("reset", resetError, {
          retryAfterSeconds: retryAfter.take(),
        });
        setError(copy.description);
        setErrorAction(copy.action ?? null);
        settle({
          title: copy.title,
          description: copy.description,
          variant: "destructive",
        });
      } else {
        const successMessage = "Password has been reset successfully.";
        setMessage(successMessage);
        settle({ title: "Success", description: successMessage });
        setTimeout(() => router.push("/auth/signin"), 3000);
      }
    } catch (err: unknown) {
      Sentry.captureException(
        err instanceof Error ? err : new Error(String(err)),
        { tags: { subsystem: "auth" } },
      );
      console.error("Reset password error:", err);
      const copy = humanizeAuthError("reset", { status: 0 });
      setError(copy.description);
      setErrorAction(copy.action ?? null);
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
   * `request-new-link` is the one that matters — it is the answer to every
   * `INVALID_TOKEN` / `TOKEN_EXPIRED` / `PASSWORD_ALREADY_SET` on this page,
   * and pointing it at the forgot-password route is what turns the passive
   * "Redirecting … in 3 seconds" into something the customer drives.
   *
   * `sign-in` is here because a reset link that is already spent is also a
   * link whose owner may not know they are signed in; the catalog reaches for
   * it on `EMAIL_ALREADY_VERIFIED` and the session codes. `retry` is never
   * renderable (see `AuthErrorAffordance`) — the submit button is the retry.
   */
  const actionTargets: Partial<Record<AuthErrorAction, AuthActionTarget>> = {
    "request-new-link": { kind: "link", href: "/auth/forgot-password" },
    "sign-in": { kind: "link", href: "/auth/signin" },
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
              Reset your password
            </h2>
            <p className="mt-2 text-sm text-zinc-400 md:text-base">
              Enter your new password below.
            </p>
          </div>

          {error && !token && (
            <div
              className="relative mt-6 rounded-xl border border-red-500/40 bg-red-950/50 p-4 text-sm text-red-200"
              role="alert"
            >
              <strong className="font-semibold text-red-100">Error!</strong>
              <span className="block sm:inline"> {error}</span>
              <p className="mt-2 text-sm text-red-300">
                Redirecting to the{" "}
                <Link
                  href="/auth/forgot-password"
                  className="font-medium text-white underline underline-offset-4 hover:text-red-100"
                >
                  forgot password page
                </Link>{" "}
                in 3 seconds...
              </p>
              <AuthErrorAffordance
                action={errorAction ?? undefined}
                target={errorTarget}
                className="mt-2 inline-block text-sm font-medium text-white underline-offset-4 hover:underline"
              />
            </div>
          )}

          {token && (
            <form className="mt-6 space-y-5" onSubmit={handleResetPassword}>
              <div className="grid gap-2">
                <Label htmlFor="password">New Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  required
                  placeholder="New password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isLoading}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="confirm-password">Confirm New Password</Label>
                <Input
                  id="confirm-password"
                  name="confirm-password"
                  type="password"
                  required
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={isLoading}
                />
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}
              {message && <p className="text-sm text-green-400">{message}</p>}

              <AuthErrorAffordance
                action={errorAction ?? undefined}
                target={errorTarget}
              />

              <Button
                type="submit"
                className="w-full bg-white text-black hover:bg-white/90"
                disabled={isLoading || !!message} // Disable button after success message
              >
                {isLoading ? "Resetting..." : "Reset Password"}
              </Button>
            </form>
          )}

          <div className="mt-6 text-center text-sm">
            <Link
              href="/auth/signin"
              className="font-medium text-zinc-300 underline-offset-4 hover:text-white hover:underline"
            >
              Back to Sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
