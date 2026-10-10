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
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULE_HINT,
  passwordTooLong,
} from "@/lib/auth/password-rules";
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
  // Better Auth redirects here with `?error=` when the link's token is bad.
  const linkError = searchParams.get("error");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  // The catalog's "what to do next" for the last failure.
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
      const timer = setTimeout(() => {
        router.replace("/auth/forgot-password");
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
    if (password.length < PASSWORD_MIN_LENGTH || passwordTooLong(password)) {
      setError(PASSWORD_RULE_HINT);
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
        fetchOptions: retryAfter.fetchOptions,
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
        // Replace so the single-use token URL leaves history.
        setTimeout(() => router.replace("/auth/signin"), 3000);
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

  const actionTargets: Partial<Record<AuthErrorAction, AuthActionTarget>> = {
    "request-new-link": { kind: "link", href: "/auth/forgot-password" },
    "sign-in": { kind: "link", href: "/auth/signin" },
    "contact-support": { kind: "link", href: `mailto:${SUPPORT_EMAIL}` },
  };

  const errorTarget = errorAction ? actionTargets[errorAction] : undefined;

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 p-6 text-white">
      <div className="mx-auto flex w-full max-w-md flex-col">
        <div className="text-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mx-auto h-10 w-auto text-white"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="2" x2="22" y1="12" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <h2 className="mt-6 text-fluid-3xl font-semibold tracking-tight">
            Reset your password
          </h2>
          <p className="mt-2 text-sm text-zinc-400 md:text-base">
            Enter your new password below.
          </p>
        </div>

        {error && !token && (
          <div
            className="relative mt-8 rounded border border-red-400 bg-red-100 px-4 py-3 text-red-700"
            role="alert"
          >
            <strong className="font-bold">Error!</strong>
            <span className="block sm:inline"> {error}</span>
            <p className="mt-2 text-sm">
              Redirecting to the{" "}
              <Link
                href="/auth/forgot-password"
                className="font-medium text-red-800 hover:underline"
              >
                forgot password page
              </Link>{" "}
              in 3 seconds...
            </p>
            <AuthErrorAffordance
              action={errorAction ?? undefined}
              target={errorTarget}
              className="mt-2 inline-block text-sm font-medium text-red-800 underline-offset-4 hover:underline"
            />
          </div>
        )}

        {token && (
          <form className="mt-8 space-y-6" onSubmit={handleResetPassword}>
            <div className="grid gap-2">
              <Label htmlFor="password">New Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading}
              />
              <p className="text-xs text-zinc-400">{PASSWORD_RULE_HINT}</p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="confirm-password">Confirm New Password</Label>
              <Input
                id="confirm-password"
                name="confirm-password"
                type="password"
                autoComplete="new-password"
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
              disabled={isLoading || !!message}
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
  );
}
