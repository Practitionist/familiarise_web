"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  humanizeAuthError,
  type AuthErrorAction,
  type AuthErrorCopy,
} from "@/lib/labels/auth-errors";
import {
  AuthErrorAffordance,
  type AuthActionTarget,
} from "@/components/auth/AuthErrorAffordance";
import {
  sendVerificationEmail,
  useSession,
  getSession,
} from "@/lib/auth-client";
import { reportSentryError } from "@/lib/observability/report";
import { safeSameOriginPath } from "@/lib/navigation/safe-path";
import { GlobeIcon } from "@/components/auth/auth-icons";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { AuthCardSkeleton } from "../AuthCardSkeleton";

/** Customer-facing support mailbox. Mirrors `lib/labels/org-errors.ts`. */
const SUPPORT_EMAIL =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@familiarisenow.com";

export default function VerifyEmail() {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <VerifyEmailContent />
    </Suspense>
  );
}

// Better Auth appends the failing code to the callbackURL when the
// verification link is bad (see api/routes/email-verification redirectOnError),
// so the whole copy for this page is derived once, from the code, in the
// catalog — including which affordance to offer. The returned object is the
// catalog entry, not a pre-joined string, so the action survives to the
// renderer below.
function copyFromCallbackError(code: string | null): AuthErrorCopy | null {
  if (!code) return null;
  return humanizeAuthError("verify", { code });
}

function VerifyEmailContent() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, isPending } = useSession();
  const errorCopy = copyFromCallbackError(searchParams.get("error"));
  const error = errorCopy
    ? `${errorCopy.title}. ${errorCopy.description}`
    : null;
  // Preserve an upstream invite/deep-link destination through verification.
  // E2E-audit fix — hardened validator: the naive prefix check passed
  // "/\attacker.example" (WHATWG backslash normalization → off-origin).
  const safeCallbackUrl = safeSameOriginPath(searchParams.get("callbackUrl"));
  const onboardingUrl = safeCallbackUrl
    ? `/form/onboarding?callbackUrl=${encodeURIComponent(safeCallbackUrl)}`
    : "/form/onboarding";
  const [email, setEmail] = useState("");
  const [resending, setResending] = useState(false);

  // Success path: after the link is clicked, BetterAuth verifies + auto-signs-in
  // (autoSignInAfterVerification) and redirects here authenticated. Send the
  // user on to onboarding — the referral capture (if any) is applied there.
  //
  // `useSession()` can serve the ≤5-min cookie-cache payload, and acting on a
  // stale `onboardingCompleted` sent us one way while the server guard (always
  // force-fresh) immediately bounced us back — the same signin↔dashboard↔
  // onboarding flicker fixed on signin/signup. Re-read force-fresh before
  // committing, and keep the navigation idempotent (single replace).
  const navigatedRef = useRef<string | null>(null);
  useEffect(() => {
    if (isPending || !session?.user) return;
    const cachedCompleted = !!session.user.onboardingCompleted;

    let cancelled = false;
    const resolveAndGo = (completed: boolean) => {
      if (cancelled) return;
      const target = completed
        ? safeCallbackUrl || "/dashboard"
        : onboardingUrl;
      if (navigatedRef.current === target) return;
      navigatedRef.current = target;
      router.replace(target);
    };

    getSession({ query: { disableCookieCache: true } })
      .then(({ data, error: sessionError }) => {
        // Better Auth resolves (rather than rejects) HTTP-level failures as
        // `{ data: null, error }` — fall back to the cached value instead of
        // stranding the page on the skeleton until the next store update.
        if (sessionError) {
          resolveAndGo(cachedCompleted);
          return;
        }
        // Session revoked between paint and check — no protected redirect.
        if (!data?.user) return;
        resolveAndGo(!!data.user.onboardingCompleted);
      })
      .catch(() => {
        resolveAndGo(cachedCompleted);
      });

    return () => {
      cancelled = true;
    };
  }, [isPending, session, router, safeCallbackUrl, onboardingUrl]);

  const handleResend = async () => {
    if (!email || !email.includes("@")) {
      toast({ title: "Enter your email address", variant: "destructive" });
      return;
    }
    setResending(true);
    try {
      const verificationCallbackUrl = safeCallbackUrl
        ? `/auth/verify-email?callbackUrl=${encodeURIComponent(safeCallbackUrl)}`
        : "/auth/verify-email";
      await sendVerificationEmail({
        email,
        callbackURL: verificationCallbackUrl,
      });
      toast({
        title: "Verification email sent",
        description: `If ${email} belongs to an unverified account, the link is on its way. It expires in 1 hour.`,
      });
    } catch (err) {
      reportSentryError(err, {
        subsystem: "auth",
        op: "verify_email_resend",
        expected: false,
      });
      toast({
        title: "Couldn't send the email",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setResending(false);
    }
  };

  /**
   * Which catalog actions this page can service.
   *
   * `resend-verification` is the whole point of this page: the
   * `verify`-flow overrides in the catalog rewrite `INVALID_TOKEN` and
   * `TOKEN_EXPIRED` to name the 1-hour window and answer with *this* action,
   * so a bad link now says "request a fresh one" in words and in one click.
   * The button below the form is that affordance's permanent twin; the copy
   * no longer has to describe it.
   *
   * `request-new-link` is absent for the same reason — it means the same
   * thing here, and two controls for one action is noise. `sign-in` is
   * `EMAIL_ALREADY_VERIFIED`'s answer, and the link at the foot of the card
   * is already it; it is mapped anyway so the failure names its own exit.
   */
  const actionTargets: Partial<Record<AuthErrorAction, AuthActionTarget>> = {
    "resend-verification": {
      kind: "callback",
      onClick: () => void handleResend(),
      disabled: resending,
    },
    "sign-in": { kind: "link", href: "/auth/signin" },
    "contact-support": { kind: "link", href: `mailto:${SUPPORT_EMAIL}` },
  };

  const errorTarget = errorCopy?.action
    ? actionTargets[errorCopy.action]
    : undefined;

  if (isPending || session?.user) {
    return <AuthCardSkeleton />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 p-6">
      <div className="w-full max-w-md text-white">
        <div className="mb-6 flex justify-center">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm font-semibold tracking-wider text-white uppercase"
          >
            <GlobeIcon className="h-5 w-5" /> Familiarise
          </Link>
        </div>
        <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-8">
          <h1 className="mb-3 text-fluid-3xl font-semibold tracking-tight">
            {error ? "Link expired or invalid" : "Verify your email"}
          </h1>
          <p className="text-sm md:text-base text-zinc-400 mb-6">
            {error ??
              "Check your inbox for the verification link we sent. It expires in 1 hour. Enter your email below to send a new one."}
          </p>

          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="name@example.com"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={resending}
            />
          </div>
          <Button
            type="button"
            className="w-full mt-4 bg-white text-black hover:bg-white/90"
            onClick={handleResend}
            disabled={resending}
          >
            {resending ? "Sending…" : "Resend verification email"}
          </Button>

          {/* The catalog's next step for the bad-link copy above, when it is not
              already the button directly above. */}
          <AuthErrorAffordance action={errorCopy?.action} target={errorTarget} />

          <p className="mt-6 text-xs text-zinc-400">
            Already verified?{" "}
            <Link
              href="/auth/signin"
              className="font-medium text-zinc-300 underline-offset-4 hover:text-white hover:underline"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
