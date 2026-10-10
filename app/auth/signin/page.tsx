"use client";

import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { pendingToast, useToast } from "@/hooks/use-toast";
import { FieldError, invalidProps } from "@/components/ui/field-error";
import { AuthEmailField } from "../AuthEmailField";
import {
  humanizeAuthError,
  normalizeAuthErrorCode,
  type AuthErrorAction,
  type AuthErrorField,
} from "@/lib/labels/auth-errors";
import {
  signIn,
  useSession,
  sendVerificationEmail,
  getSession,
} from "@/lib/auth-client";
import { safeSameOriginPath } from "@/lib/navigation/safe-path";
import { GlobeIcon } from "@/components/auth/auth-icons";
import { SocialLoginButtons } from "@/components/auth/social-login-buttons";
import {
  AuthErrorAffordance,
  type AuthActionTarget,
} from "@/components/auth/AuthErrorAffordance";
import { useRetryAfterCapture } from "@/components/auth/useRetryAfterCapture";
import { markExpectedUnreachable } from "@/lib/auth/expected-auth-failures";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useMemo, useRef, Suspense } from "react";
import { AuthFormSkeleton } from "../AuthFormSkeleton";

/** Customer-facing support mailbox. Mirrors `lib/labels/org-errors.ts`. */
const SUPPORT_EMAIL =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@familiarisenow.com";

/**
 * Resolve the redirect target for an already-authenticated visitor.
 *
 * `useSession()` can serve the ≤5-min cookie-cache payload, and acting on a
 * stale `onboardingCompleted` sent us one way while the server guard (always
 * force-fresh) immediately bounced the user back — the intermittent
 * signin↔dashboard↔onboarding flicker. Re-reading the session with
 * `disableCookieCache` aligns the client's decision with what the server
 * guard will decide.
 *
 * - Fresh read returns a user → trust its onboarding status.
 * - Fresh read FAILS (network) → fall back to the cached value.
 * - Fresh read returns NO user → the session is actually gone/revoked; do NOT
 *   navigate to a protected route (the server would only bounce us back).
 *   Stay put and let the session-store update drive the UI.
 */
function useAuthenticatedRedirectTarget(
  onboardingCompleted: boolean | undefined,
  isPending: boolean,
  callbackUrl: string | null,
  onboardingUrl: string,
) {
  const router = useRouter();
  const navigatedRef = useRef<string | null>(null);

  useEffect(() => {
    if (isPending || onboardingCompleted === undefined) return;

    let cancelled = false;
    const go = (target: string) => {
      if (cancelled) return;
      // Idempotency guard: re-renders / Strict-Mode double-invocation /
      // duplicate store emissions must not queue a second navigation.
      // (A delayed-state callbackUrl used to fire this effect twice with
      // different targets — flashing users through /dashboard en route to
      // their real destination.)
      if (navigatedRef.current === target) return;
      navigatedRef.current = target;
      router.replace(target);
    };
    const resolveAndGo = (completed: boolean) =>
      go(completed ? callbackUrl || "/dashboard" : onboardingUrl);

    getSession({ query: { disableCookieCache: true } })
      .then(({ data, error: sessionError }) => {
        // Better Auth resolves (rather than rejects) HTTP-level failures as
        // `{ data: null, error }` — fall back to the cached value instead of
        // stranding the page on the interstitial until the next store update.
        if (sessionError) {
          resolveAndGo(!!onboardingCompleted);
          return;
        }
        // Session revoked between paint and check — no protected redirect.
        if (!data?.user) return;
        // Server pages read an operator without 2FA as signed out
        // (lib/auth-server.ts), so any other target would bounce back here.
        if (
          isOperatorRole(data.user.role) &&
          data.user.twoFactorEnabled !== true
        ) {
          go("/auth/two-factor/setup");
          return;
        }
        resolveAndGo(!!data.user.onboardingCompleted);
      })
      .catch(() => {
        resolveAndGo(!!onboardingCompleted);
      });

    return () => {
      cancelled = true;
    };
  }, [onboardingCompleted, isPending, router, callbackUrl, onboardingUrl]);
}

export default function SignIn() {
  return (
    <Suspense fallback={<AuthFormSkeleton />}>
      <SignInContent />
    </Suspense>
  );
}

function SignInContent() {
  const router = useRouter();
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const { data: session, isPending } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [ssoCheck, setSsoCheck] = useState<{
    enforceSSO: boolean;
    organizationName: string;
    ssoBody: { providerId: string; domain: string; callbackURL: string };
  } | null>(null);
  const [ssoChecking, setSsoChecking] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);
  // The sentence under the input the server refused, cleared on retype.
  const [fieldError, setFieldError] = useState<
    Partial<Record<AuthErrorField, string>>
  >({});
  const [resending, setResending] = useState(false);
  // The catalog's "what to do next" for the last failure, so the page can
  // render the affordance instead of hardcoding one per failure.
  const [errorAction, setErrorAction] = useState<AuthErrorAction | null>(null);
  const retryAfter = useRetryAfterCapture();

  // Validate callbackUrl synchronously from the URL. safeSameOriginPath
  // resolves against a probe origin to reject backslash/scheme-relative
  // escapes ("/\attacker.example" passes naive prefix checks but parses to an
  // external origin) and returns the canonical same-origin path.
  const callbackUrl = useMemo(
    () => safeSameOriginPath(searchParams.get("callbackUrl")),
    [searchParams],
  );

  // #1856 — landed here because a session was revoked elsewhere
  // (another device, or "sign out other devices"). Exact-match on a fixed
  // string: the param carries no data, so there is nothing to inject.
  const wasRevokedElsewhere = searchParams.get("reason") === "session-revoked";

  // A refused Google or SSO callback lands back here as `?error=<code>`, e.g.
  // SSO_REQUIRED, whose action button runs the domain check and the SSO
  // redirect. Unknown codes are ignored, so the param cannot inject copy.
  const callbackError = normalizeAuthErrorCode(searchParams.get("error"));
  useEffect(() => {
    if (!callbackError) return;
    const copy = humanizeAuthError("signin", { code: callbackError });
    setErrorAction(copy.action ?? null);
    toast({
      title: copy.title,
      description: copy.description,
      variant: "destructive",
    });
  }, [callbackError, toast]);

  // #booking-journey — is this sign-in a detour out of a purchase? Derived
  // from the ALREADY-VALIDATED callbackUrl, never the raw param, so a crafted
  // "/\\evil.example/checkout/..." cannot light up a trust banner. Drives
  // only reassurance copy; nothing is authorized on the strength of it.
  const isPurchaseReturn = useMemo(
    () => callbackUrl?.startsWith("/checkout/") ?? false,
    [callbackUrl],
  );

  // Thread the validated callbackUrl through the onboarding + sign-up hand-offs
  // so a first-timer who came here to book/buy returns to their destination
  // after finishing onboarding, instead of being dropped on the dashboard
  // (mirrors the sign-up page, which already does this).
  const onboardingUrl = callbackUrl
    ? `/form/onboarding?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : "/form/onboarding";
  const signUpUrl = callbackUrl
    ? `/auth/signup?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : "/auth/signup";

  useAuthenticatedRedirectTarget(
    session?.user?.onboardingCompleted,
    isPending,
    callbackUrl,
    onboardingUrl,
  );

  // Show loading while checking session status (fallback for when middleware doesn't catch)
  if (isPending) {
    return <AuthFormSkeleton />;
  }

  // If already logged in, show redirecting message. Deliberately generic:
  // the cached `onboardingCompleted` can be ≤5-min stale, and naming the
  // destination from it flashed "dashboard" one frame before the force-fresh
  // check above sent the user to onboarding (or vice-versa).
  if (session?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950">
        <p className="text-white">Redirecting…</p>
      </div>
    );
  }

  const handleEmailBlur = async () => {
    if (!email || !email.includes("@")) return;
    setSsoChecking(true);
    try {
      const res = await fetch(
        `/api/auth/sso/domain-check?email=${encodeURIComponent(email)}`,
      );
      if (res.ok) {
        const data = await res.json();
        setSsoCheck(
          data.ssoBody
            ? {
                enforceSSO: data.enforceSSO === true,
                organizationName: data.organizationName,
                ssoBody: data.ssoBody,
              }
            : null,
        );
      }
    } catch {
      // ignore — fall through to normal login
    } finally {
      setSsoChecking(false);
    }
  };

  const startSsoSignIn = async (ssoBody: {
    providerId: string;
    domain: string;
    callbackURL: string;
  }) => {
    try {
      const res = await signIn.sso(ssoBody);
      if (res?.error) {
        const copy = humanizeAuthError("signin", res.error);
        setErrorAction(copy.action ?? null);
        toast({
          title: copy.title,
          description: copy.description,
          variant: "destructive",
        });
      }
    } catch {
      const copy = humanizeAuthError("signin", { status: 0 });
      setErrorAction(copy.action ?? null);
      toast({
        title: copy.title,
        description: copy.description,
        variant: "destructive",
      });
    }
  };

  const handleSSOSignIn = async () => {
    if (!ssoCheck) return;
    await startSsoSignIn(ssoCheck.ssoBody);
  };

  // Manual SSO trigger for IT admins testing their setup before enforcement
  // is turned on. Same domain-check logic as the email blur handler, but
  // immediately fires the redirect if a provider is found.
  const handleManualSSOClick = async () => {
    if (!email || !email.includes("@")) {
      toast({
        title: "Enter your work email first",
        description: "Type your corporate email address above, then try again.",
      });
      return;
    }
    setSsoChecking(true);
    try {
      const res = await fetch(
        `/api/auth/sso/domain-check?email=${encodeURIComponent(email)}`,
      );
      if (!res.ok) throw new Error("check failed");
      const data = await res.json();
      if (data.ssoBody) {
        setSsoCheck({
          enforceSSO: data.enforceSSO === true,
          organizationName: data.organizationName,
          ssoBody: data.ssoBody,
        });
        await startSsoSignIn(data.ssoBody);
      } else {
        toast({
          title: "No SSO provider found",
          description:
            "No corporate SSO is configured for this email domain. Contact your IT admin.",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "SSO check failed",
        description: "Could not verify SSO for this domain. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSsoChecking(false);
    }
  };

  const handleResendVerification = async () => {
    if (!email || !email.includes("@")) {
      toast({
        title: "Enter your email address first",
        variant: "destructive",
      });
      return;
    }
    setResending(true);
    try {
      // Preserve the validated callbackUrl so the original destination survives
      // verification (callbackUrl state is only set for relative paths).
      const verificationCallbackUrl = callbackUrl
        ? `/auth/verify-email?callbackUrl=${encodeURIComponent(callbackUrl)}`
        : "/auth/verify-email";
      await sendVerificationEmail({
        email,
        callbackURL: verificationCallbackUrl,
      });
      toast({
        title: "Verification email sent",
        description: `If ${email} belongs to an unverified account, the link is on its way.`,
      });
    } catch {
      toast({
        title: "Couldn't resend the email",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setResending(false);
    }
  };

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    // Clear any stale "verify your email" banner from a previous attempt.
    setNeedsVerification(false);
    setFieldError({});
    setErrorAction(null);
    retryAfter.clear();
    setIsLoading(true);
    const settle = pendingToast({ title: "Signing in..." });

    /** Everything that depends on the *result* of `signIn.email`. */
    const applyResult = (data: object | null | undefined, error: unknown) => {
      if (error) {
        const copy = humanizeAuthError("signin", error, {
          retryAfterSeconds: retryAfter.take(),
        });
        setErrorAction(copy.action ?? null);
        if (copy.needsVerification) {
          setNeedsVerification(true);
          settle({ title: copy.title, description: copy.description });
        } else {
          if (copy.field) setFieldError({ [copy.field]: copy.description });
          settle({
            title: copy.title,
            description: copy.description,
            variant: "destructive",
          });
        }
        return;
      }
      if (!data) return;
      // An enrolled operator: the password was right, but there is no session
      // yet (and no `user` on this response) until the authenticator code is
      // verified on the challenge page.
      if ("twoFactorRedirect" in data && data.twoFactorRedirect) {
        settle({ title: "Enter your authenticator code" });
        router.push(
          callbackUrl
            ? `/auth/two-factor?callbackUrl=${encodeURIComponent(callbackUrl)}`
            : "/auth/two-factor",
        );
        return;
      }
      // The Sentry user is NOT set here. `AuthSyncProvider` mirrors the
      // resolved session onto the identity, which also covers the SSO and
      // social sign-in redirects that never touch this handler.
      settle({
        title: "Sign In Successful",
        description: callbackUrl
          ? "Redirecting to your destination..."
          : "Redirecting to dashboard...",
      });
      // Defer the redirect to the useSession-driven effect above so it honours
      // onboarding status — a non-onboarded user signing in from a booking/trial
      // callback must go through onboarding first, not straight to callbackUrl.
    };

    try {
      const { data, error } = await signIn.email({
        email,
        password,
        // The `fetchOptions` bag is the client-level fetch configuration: the
        // proxy (`better-auth/dist/client/proxy.mjs`) lifts it to the top-level
        // fetch options, which is where `onResponse` (which reads `Retry-After`
        // off the response — see `components/auth/useRetryAfterCapture.ts` for
        // why the error object alone cannot carry it) is consumed. The
        // limiter's body field is the fallback when it is not present.
        fetchOptions: retryAfter.fetchOptions,
      });
      applyResult(data, error);
    } catch (error) {
      // Thrown fetch only (BetterAuth resolves API failures as `{ error }`
      // handled above): the request never completed, so this is a
      // connection problem, not an account problem — safe to say so.
      //
      // `markExpectedUnreachable` marks only the shapes where the request never
      // reached the service (failure-modes row 6's cold-instance stall as the
      // browser sees it, plus a `status: 0` resolve). Marked → warning +
      // `expected:true`, which is what row 19 asks for: the event still arrives
      // and is still the detector for that row, but it stops paging on-call for
      // something Netlify has already confirmed it does. Anything that is *not*
      // recognisably a transport failure keeps its error level — a genuine bug in
      // this handler must still page, and a marker applied too widely is an alert
      // that never fires.
      const { error: reported, marked } = markExpectedUnreachable(error);
      Sentry.captureException(reported, {
        tags: {
          subsystem: "auth",
          ...(marked ? {} : { auth_unreachable: "false" }),
        },
      });
      console.error("Sign in error:", error);
      // Still routed through the catalog rather than hand-written: a thrown
      // `APIError` is the shape that carries a real `code` and `status`, and
      // `status: 0` is the "never reached the service" half of
      // `copyForStatus`. No raw `error.message` is shown.
      const copy = humanizeAuthError("signin", { status: 0 });
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
   * Which catalog actions this page can service, and how.
   *
   * Every entry points at something the page *already* has — the sign-up link
   * at the foot of the card, the manual SSO trigger, the forgot-password
   * route. Nothing here invents a new affordance, which is the point: the
   * catalog says what the customer should do, the page says how.
   *
   * Deliberately absent:
   *   - `sign-in` — the visitor is already on this page.
   *   - `resend-verification` — `needsVerification` lights the banner above,
   *     which carries its own resend button.
   *   - `enroll-2fa` — no 2FA settings page is reachable from an auth page; a
   *     button that goes nowhere is worse than no button.
   *   - `retry` — never renderable (see `AuthErrorAffordance`).
   *
   * Rebuilt per render rather than memoised: the callbacks close over this
   * render's `email` / `ssoCheck`, and a memo would pin a stale closure. The
   * child is not memoised, so a new object identity costs nothing.
   */
  const actionTargets: Partial<Record<AuthErrorAction, AuthActionTarget>> = {
    "forgot-password": { kind: "link", href: "/auth/forgot-password" },
    "request-new-link": { kind: "link", href: "/auth/forgot-password" },
    "sign-up": { kind: "link", href: signUpUrl },
    "switch-to-sso": {
      kind: "callback",
      onClick: () => void handleManualSSOClick(),
      disabled: ssoChecking,
    },
    "contact-support": { kind: "link", href: `mailto:${SUPPORT_EMAIL}` },
  };

  const errorTarget = errorAction ? actionTargets[errorAction] : undefined;

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <div className="hidden flex-col justify-between bg-pearl p-6 text-black md:flex md:w-1/2 md:p-12">
        <Link href="/">
          <div className="flex items-center justify-start space-x-2">
            <GlobeIcon className="h-5 w-5 text-black md:h-6 md:w-6" />
            <h1 className="text-2xl font-semibold tracking-tight md:text-4xl">
              Familiarise
            </h1>
          </div>
        </Link>
        <div className="my-8 md:my-0">
          <blockquote className="text-fluid-lg leading-relaxed text-neutral-700">
            &ldquo;The mentors on this platform have been incredible. Their deep
            industry expertise and personalized guidance helped me navigate
            complex career decisions and accelerate my professional growth. The
            insights I gained were truly transformative.&rdquo;
          </blockquote>
          <p className="mt-4 text-sm font-medium md:text-base">
            Shubham, Software Engineer
          </p>
        </div>
        <div className="text-xs text-neutral-600 md:text-sm">
          Connect with experienced mentors who can guide you towards your
          professional goals.
        </div>
      </div>
      <div className="flex flex-1 flex-col justify-center bg-neutral-950 p-6 text-white md:w-1/2 md:p-12">
        <div className="mx-auto flex w-full max-w-md flex-col">
          <h2 className="mb-2 text-fluid-3xl font-semibold tracking-tight">
            Sign in to your account
          </h2>
          {/* #booking-journey — when the callback is a checkout return, say
              so: a guest bounced from a Buy/Subscribe click must see that
              their purchase survived the detour, or they read this page as an
              error and abandon. */}
          {isPurchaseReturn && (
            <div className="mb-4 rounded-md border border-emerald-600/60 bg-emerald-900/30 p-3">
              <p className="text-sm text-emerald-300">
                You&apos;re almost there — sign in to continue your booking.
                Your selection is saved and will resume right where you left
                off.
              </p>
            </div>
          )}
          {wasRevokedElsewhere && (
            <div className="mb-4 rounded-md border border-sky-600/60 bg-sky-900/30 p-3">
              <p className="text-sm text-sky-300">
                You were signed out — on this device or another one. Sign in
                again to continue.
              </p>
            </div>
          )}
          {needsVerification && (
            <div className="mb-4 rounded-md border border-yellow-600 bg-yellow-900/40 p-3">
              <p className="mb-2 text-sm text-yellow-300">
                Your email isn&apos;t verified yet. Check your inbox, or resend
                the link.
              </p>
              <Button
                type="button"
                onClick={handleResendVerification}
                disabled={resending}
                className="bg-zinc-800 hover:bg-zinc-700"
              >
                {resending ? "Resending…" : "Resend verification email"}
              </Button>
            </div>
          )}
          <p className="mb-6 text-sm text-zinc-400 md:text-base">
            Enter your email and password below to sign in.
          </p>
          <form onSubmit={handleEmailSignIn}>
            <AuthEmailField
              value={email}
              onChange={(v) => {
                setEmail(v);
                setFieldError((f) => ({ ...f, email: undefined }));
              }}
              onBlur={handleEmailBlur}
              disabled={isLoading || ssoChecking}
              error={fieldError.email}
            />
            {!ssoCheck?.enforceSSO && (
              <div className="grid gap-2 mt-4">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <Link
                    href="/auth/forgot-password"
                    className="text-sm font-medium text-zinc-300 underline-offset-4 hover:text-white hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setFieldError((f) => ({ ...f, password: undefined }));
                  }}
                  required
                  disabled={isLoading}
                  {...invalidProps(fieldError.password, "password-error")}
                />
                <FieldError id="password-error" message={fieldError.password} />
              </div>
            )}
            {ssoCheck?.enforceSSO ? (
              <Button
                type="button"
                className="mt-4 w-full bg-white text-black hover:bg-white/90"
                onClick={handleSSOSignIn}
              >
                Sign in with {ssoCheck.organizationName} SSO &rarr;
              </Button>
            ) : (
              <Button
                type="submit"
                className="mt-4 w-full bg-white text-black hover:bg-white/90"
                disabled={isLoading}
              >
                {isLoading ? "Signing In..." : "Sign In with Email"}
              </Button>
            )}
            {ssoCheck && !ssoCheck.enforceSSO && (
              <Button
                type="button"
                variant="outline"
                className="mt-2 w-full"
                onClick={handleSSOSignIn}
                disabled={isLoading}
              >
                Sign in with {ssoCheck.organizationName} SSO &rarr;
              </Button>
            )}
            {/* The catalog's next step for the last failure, if this page can
                service it. One line, no repeated sentence — the toast above
                already carried the title and description. */}
            <AuthErrorAffordance
              action={errorAction ?? undefined}
              target={errorTarget}
            />
          </form>
          {!ssoCheck?.enforceSSO && (
            <>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-white/15" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="bg-neutral-950 px-2 text-zinc-400">
                    OR CONTINUE WITH
                  </span>
                </div>
              </div>
              <SocialLoginButtons
                callbackURL={callbackUrl || "/dashboard"}
                newUserCallbackURL={onboardingUrl}
                isLoading={isLoading}
                ssoEnforced={false}
                onSSOClick={handleManualSSOClick}
                ssoChecking={ssoChecking}
              />
            </>
          )}
          <p className="mt-6 text-xs text-zinc-400">
            Don't have an account?{" "}
            <Link
              href={signUpUrl}
              className="font-medium text-white underline-offset-4 hover:underline"
            >
              Sign up
            </Link>
          </p>
          <p className="mt-2 text-xs text-zinc-400">
            By clicking continue, you agree to our{" "}
            <Link
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-zinc-300 underline-offset-4 hover:text-white hover:underline"
            >
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-zinc-300 underline-offset-4 hover:text-white hover:underline"
            >
              Privacy Policy
            </Link>
            .
          </p>
        </div>
        <div />
      </div>
    </div>
  );
}
