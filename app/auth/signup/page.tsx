"use client";

import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { pendingToast, useToast } from "@/hooks/use-toast";
import {
  signUp,
  useSession,
  sendVerificationEmail,
  getSession,
} from "@/lib/auth-client";
import { safeSameOriginPath } from "@/lib/navigation/safe-path";
import { setPendingReferral } from "@/lib/pending-referral";
import { ReferralCodeField } from "./ReferralCodeField";
import { FieldError, invalidProps } from "@/components/ui/field-error";
import { AuthEmailField } from "../AuthEmailField";
import {
  humanizeAuthError,
  type AuthErrorAction,
  type AuthErrorField,
} from "@/lib/labels/auth-errors";
import { ssoSigninWithGuard } from "@/lib/sso/signin-with-toast";
import { GlobeIcon } from "@/components/auth/auth-icons";
import { SocialLoginButtons } from "@/components/auth/social-login-buttons";
import {
  AuthErrorAffordance,
  type AuthActionTarget,
} from "@/components/auth/AuthErrorAffordance";
import { useRetryAfterCapture } from "@/components/auth/useRetryAfterCapture";
import { markExpectedUnreachable } from "@/lib/auth/expected-auth-failures";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { AuthFormSkeleton } from "../AuthFormSkeleton";

/** Customer-facing support mailbox. Mirrors `lib/labels/org-errors.ts`. */
const SUPPORT_EMAIL =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@familiarisenow.com";

/**
 * Pull a code, status and wait out of a *thrown* Better Auth error.
 *
 * A rejected `signUp.email(...)` is not the same object as the `error` field
 * of a resolved call, and the difference matters: better-fetch's
 * resolve-with-error path hands the page a parsed body, whereas a throw
 * carries Better Auth's own `APIError`, whose `body` holds `{ code, message }`
 * and whose `status` is the HTTP status. Reading only `error.message` there
 * is what put a raw developer-facing sentence on the sign-up page; reading
 * `body.code` instead is what makes the catalog able to answer.
 *
 * Everything here is structural (no property is trusted for its *content*
 * except as an opaque code candidate, which `humanizeAuthError` narrows
 * against `AUTH_ERROR_CODES`).
 */
function thrownAuthError(error: unknown): {
  code?: string;
  status?: number;
  message?: string;
} {
  if (!error || typeof error !== "object") return {};
  const e = error as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    body?: unknown;
    response?: unknown;
  };
  const body =
    e.body && typeof e.body === "object"
      ? (e.body as { code?: unknown; message?: unknown })
      : {};
  // The `message` is read only so `humanizeAuthError` can pick a *field* out
  // of a zod validation failure (see `fieldFromValidationMessage`); it is
  // never returned to the page.
  return {
    ...(typeof e.code === "string" ? { code: e.code } : {}),
    ...(typeof body.code === "string" ? { code: body.code } : {}),
    ...(typeof e.status === "number" ? { status: e.status } : {}),
    ...(typeof body.message === "string" ? { message: body.message } : {}),
  };
}

export default function SignUp() {
  return (
    <Suspense fallback={<AuthFormSkeleton />}>
      <SignUpContent />
    </Suspense>
  );
}

function SignUpContent() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const referralCode = searchParams.get("ref");
  const callbackUrl = searchParams.get("callbackUrl");
  const { data: session, isPending } = useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [refCode, setRefCode] = useState(referralCode || "");
  const [ssoCheck, setSsoCheck] = useState<{
    enforceSSO: boolean;
    organizationName: string;
    ssoBody: { providerId: string; domain: string; callbackURL: string };
  } | null>(null);
  const [ssoChecking, setSsoChecking] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  const [resending, setResending] = useState(false);
  // The sentence under the input the server refused, cleared on retype.
  const [fieldError, setFieldError] = useState<
    Partial<Record<AuthErrorField, string>>
  >({});
  // The catalog's "what to do next" for the last failure.
  const [errorAction, setErrorAction] = useState<AuthErrorAction | null>(null);
  const retryAfter = useRetryAfterCapture();

  // Validate the callbackUrl once and reuse the safe value across onboarding,
  // verification, and social login. safeSameOriginPath rejects backslash /
  // scheme-relative escapes that naive prefix checks let through.
  const safeCallbackUrl = safeSameOriginPath(callbackUrl);

  // Build onboarding URL with optional callbackUrl passthrough (for org invite flow)
  const onboardingUrl = safeCallbackUrl
    ? `/form/onboarding?callbackUrl=${encodeURIComponent(safeCallbackUrl)}`
    : "/form/onboarding";

  // Thread the validated callbackUrl through the verification link so an
  // invite/deep-link destination survives email verification.
  const verificationCallbackUrl = safeCallbackUrl
    ? `/auth/verify-email?callbackUrl=${encodeURIComponent(safeCallbackUrl)}`
    : "/auth/verify-email";

  // Thread it back to sign-in too, so toggling sign-up ↔ sign-in preserves the
  // destination in both directions (only the org-invite deep-link set it before).
  const signInUrl = safeCallbackUrl
    ? `/auth/signin?callbackUrl=${encodeURIComponent(safeCallbackUrl)}`
    : "/auth/signin";

  // Redirect authenticated users based on onboarding status.
  //
  // `useSession()` can serve the ≤5-min cookie-cache payload; acting on a
  // stale `onboardingCompleted` sent the client one way while the server
  // guard (always force-fresh) bounced the user back — an intermittent
  // flicker. Re-verify with a force-fresh read before committing, and keep
  // the navigation idempotent (single replace, never push: leaving /auth/*
  // in history made Back from the dashboard ping-pong forward again).
  const navigatedRef = useRef<string | null>(null);
  useEffect(() => {
    if (isPending || !session?.user) return;

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
        // stranding the page on the interstitial until the next store update.
        if (sessionError) {
          resolveAndGo(!!session.user?.onboardingCompleted);
          return;
        }
        // Session revoked between paint and check — no protected redirect.
        if (!data?.user) return;
        resolveAndGo(!!data.user.onboardingCompleted);
      })
      .catch(() => {
        resolveAndGo(!!session.user?.onboardingCompleted);
      });

    return () => {
      cancelled = true;
    };
  }, [session, isPending, router, safeCallbackUrl, onboardingUrl]);

  // Persist the referral code at first touch so it survives the OAuth redirect
  // and the email-verification gap; it is applied after authentication on the
  // onboarding landing. #880
  // #891 — landing here WITHOUT ?ref= must not wipe a previously-stashed code;
  // an explicit different code simply overwrites the stash.
  useEffect(() => {
    if (refCode) setPendingReferral(refCode);
  }, [refCode]);

  // Show loading while checking session status (fallback for when middleware doesn't catch)

  if (isPending) {
    return <AuthFormSkeleton />;
  }

  // If already logged in, show redirecting message. Generic on purpose —
  // the cached `onboardingCompleted` can be stale (see the force-fresh effect
  // above); naming the destination flashed the wrong one for a frame.
  if (session?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950">
        <p className="text-white">Redirecting…</p>
      </div>
    );
  }

  const handleResendVerification = async () => {
    setResending(true);
    try {
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

  // After a verification-required signup there is no session yet — show a
  // check-your-email panel with a resend instead of the form.
  if (verificationSent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950 p-6">
        <div className="w-full max-w-md text-center text-white">
          <h2 className="mb-3 text-fluid-3xl font-semibold tracking-tight">
            Check your email
          </h2>
          <p className="mb-6 text-sm text-zinc-400 md:text-base">
            We sent a verification link to{" "}
            <span className="font-medium text-white">{email}</span>. Click it to
            activate your account. The link expires in 1 hour.
          </p>
          <Button
            onClick={handleResendVerification}
            disabled={resending}
            className="w-full bg-zinc-800 hover:bg-zinc-700"
          >
            {resending ? "Resending…" : "Resend verification email"}
          </Button>
          <p className="mt-4 text-xs text-zinc-400">
            Already verified?{" "}
            <Link
              href={signInUrl}
              className="font-medium text-zinc-300 underline-offset-4 hover:text-white hover:underline"
            >
              Sign in
            </Link>
          </p>
        </div>
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
          data.enforceSSO
            ? {
                enforceSSO: true,
                organizationName: data.organizationName,
                ssoBody: data.ssoBody,
              }
            : null,
        );
      }
    } catch {
      // ignore — fall through to normal signup
    } finally {
      setSsoChecking(false);
    }
  };

  /**
   * Translate BetterAuth's developer-facing validation errors into
   * user-friendly messages. Raw errors look like:
   *   "[body.email] Invalid email address; [body.password] Too small: ..."
   */
  const handleSSOSignIn = async () => {
    if (!ssoCheck) return;
    // Use the guarded wrapper around signIn.sso() so SSO failures
    // (resolve-with-error, 500-with-empty-body, no-redirect-after-2s)
    // surface as a destructive toast instead of a silent dead-end on
    // the signup form. See `lib/sso/signin-with-toast.ts` + audit B.1.
    reportSsoFailure(
      await ssoSigninWithGuard({
        providerId: ssoCheck.ssoBody.providerId,
        domain: ssoCheck.ssoBody.domain,
        callbackURL: ssoCheck.ssoBody.callbackURL,
      }),
    );
  };

  /**
   * The guard answers with a *code*, not a sentence to print — see the twin
   * function in `app/auth/signin/page.tsx` for the full reasoning. Short
   * version: when an `errorCode` is present we re-enter the catalog through
   * `humanizeAuthError` so this page has exactly one error vocabulary, and
   * the guard's pre-baked `errorMessage` is only used for its own generic
   * sentences (which have no catalog code and are still our own copy).
   */
  const reportSsoFailure = (result: {
    ok: boolean;
    errorMessage: string | null;
    errorCode: string | null;
    action: AuthErrorAction | null;
  }) => {
    if (result.ok || !result.errorMessage) return;
    const copy = result.errorCode
      ? humanizeAuthError("signup", { code: result.errorCode })
      : null;
    toast({
      title: copy?.title ?? "SSO sign-in failed",
      description: copy?.description ?? result.errorMessage,
      variant: "destructive",
    });
    setErrorAction(result.action);
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldError({});
    setErrorAction(null);
    retryAfter.clear();
    if (password !== confirmPassword) {
      setFieldError({ password: "The two passwords don't match." });
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    setIsLoading(true);
    const settle = pendingToast({ title: "Creating account..." });

    /** Everything that depends on the *result* of `signUp.email`. */
    const applyResult = (
      data: { token?: string | null } | null | undefined,
      error: unknown,
    ) => {
      if (error) {
        const copy = humanizeAuthError("signup", error, {
          retryAfterSeconds: retryAfter.take(),
        });
        setErrorAction(copy.action ?? null);
        if (copy.field) setFieldError({ [copy.field]: copy.description });
        settle({
          title: copy.title,
          description: copy.description,
          variant: "destructive",
        });
      } else if (data && !data.token) {
        // requireEmailVerification: the account is created but no session is
        // issued until the email is verified. Show the check-your-email panel.
        setVerificationSent(true);
        settle({
          title: "Check your email",
          description: `We sent a verification link to ${email}.`,
        });
      } else if (data) {
        // Session created (verification-disabled fallback). The referral code
        // was persisted at first touch and is applied on the onboarding landing
        // (covers OAuth + verified-email paths uniformly). #880
        // Replace, never push: leaving /auth/signup in history makes Back from
        // onboarding/dashboard ping-pong forward again.
        settle({
          title: "Account Created Successfully!",
          description: "Redirecting to onboarding...",
        });
        router.replace(onboardingUrl);
      }
    };

    try {
      const { data, error } = await signUp.email({
        name,
        email,
        password,
        callbackURL: verificationCallbackUrl,
        // The `fetchOptions` bag is lifted to the top-level fetch options by
        // the client proxy — see the same call on the signin page.
        fetchOptions: retryAfter.fetchOptions,
      });
      applyResult(data, error);
    } catch (error: unknown) {
      // Marked only for the "never reached the service" shapes — see
      // `lib/auth/expected-auth-failures.ts` and the same block on the signin
      // page. Anything else keeps error level on purpose.
      const { error: reported, marked } = markExpectedUnreachable(error);
      Sentry.captureException(reported, {
        tags: {
          subsystem: "auth",
          ...(marked ? {} : { auth_unreachable: "false" }),
        },
      });
      console.error("Sign up error:", error);
      // BEFORE: `error.message` was rendered verbatim here — Better Auth's
      // developer-facing text ("Invalid email or password", a zod
      // "[body.email] …" dump) reaching a customer who had just typed that
      // email. The thrown path is exactly where those messages live, because
      // it is where the request *failed* rather than resolved. Now: extract
      // `code` / `status` structurally and let the catalog write the sentence.
      // A network failure (status 0 / absent) still answers `UNREACHABLE`,
      // which says "nothing was changed" — the honest thing when the create
      // may or may not have landed.
      const thrown = thrownAuthError(error);
      const copy = humanizeAuthError(
        "signup",
        // No `status` on a thrown error means the request never completed
        // (fetch/CORS/timeout), which is status 0 — `copyForStatus`'s
        // "we couldn't reach the service" branch, and the one honest answer
        // when the create may or may not have landed.
        { ...thrown, status: thrown.status ?? 0 },
        { retryAfterSeconds: retryAfter.take() },
      );
      setErrorAction(copy.action ?? null);
      if (copy.field) setFieldError({ [copy.field]: copy.description });
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
   * Which catalog actions this page can service, and how — every entry points
   * at something the page already has (the sign-in link threaded with the
   * validated `callbackUrl`, the SSO panel, a mailto).
   *
   * Deliberately absent:
   *   - `resend-verification` — only the post-signup "check your email" panel
   *     has a resend, and no failure can reach it from the form.
   *   - `forgot-password` — the address does not belong to this visitor yet.
   *   - `enroll-2fa` / `upgrade-plan` — not reachable from an auth page.
   *   - `retry` — never renderable (see `AuthErrorAffordance`).
   *
   * Rebuilt per render rather than memoised: the callback closes over this
   * render's `ssoCheck`, and a memo would pin a stale one.
   */
  const actionTargets: Partial<Record<AuthErrorAction, AuthActionTarget>> = {
    "sign-in": { kind: "link", href: signInUrl },
    "switch-to-sso": {
      kind: "callback",
      onClick: () => void handleSSOSignIn(),
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
            &ldquo;Joining Familiarise was the best decision for my startup.
            Access to top-tier mentors gave us the clarity and direction we
            desperately needed.&rdquo;
          </blockquote>
          <p className="mt-4 text-sm font-medium md:text-base">
            Priya Sharma, Founder @ TechNova
          </p>
        </div>
        <div className="text-xs text-neutral-600 md:text-sm">
          Start your journey with Familiarise today. Sign up to unlock a world
          of expert mentorship.
        </div>
      </div>
      <div className="flex flex-1 flex-col justify-center bg-neutral-950 p-6 text-white md:w-1/2 md:p-12">
        <div className="mx-auto flex w-full max-w-md flex-col">
          <h2 className="mb-2 text-fluid-3xl font-semibold tracking-tight">
            Create your account
          </h2>
          <p className="mb-6 text-sm text-zinc-400 md:text-base">
            Enter your details below to get started.
          </p>
          <form onSubmit={handleSignUp}>
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="Your Name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                disabled={isLoading}
              />
            </div>
            <AuthEmailField
              value={email}
              onChange={(v) => {
                setEmail(v);
                setFieldError((f) => ({ ...f, email: undefined }));
              }}
              onBlur={handleEmailBlur}
              disabled={isLoading || ssoChecking}
              error={fieldError.email}
              className="grid gap-2 mt-4"
            />
            {!ssoCheck?.enforceSSO && (
              <>
                <div className="grid gap-2 mt-4">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setFieldError((f) => ({ ...f, password: undefined }));
                    }}
                    required
                    minLength={8}
                    maxLength={128}
                    disabled={isLoading}
                    {...invalidProps(fieldError.password, "password-error")}
                  />
                  <FieldError
                    id="password-error"
                    message={fieldError.password}
                  />
                  <p className="text-xs text-zinc-400">8 to 128 characters.</p>
                </div>
                <div className="grid gap-2 mt-4">
                  <Label htmlFor="confirm-password">Confirm Password</Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    disabled={isLoading}
                  />
                </div>
              </>
            )}
            {!referralCode && !ssoCheck?.enforceSSO && (
              <ReferralCodeField
                value={refCode}
                onChange={setRefCode}
                disabled={isLoading}
              />
            )}
            {referralCode && !ssoCheck?.enforceSSO && (
              <div className="mt-4 p-3 rounded-md bg-green-900/30 border border-green-700">
                <p className="text-sm text-green-400">
                  Referral code{" "}
                  <span className="font-semibold">{referralCode}</span> applied!
                  You&apos;ll receive a welcome bonus after signing up.
                </p>
              </div>
            )}
            {!ssoCheck?.enforceSSO && (
              <Button
                type="submit"
                className="mt-4 w-full bg-white text-black hover:bg-white/90"
                disabled={isLoading}
              >
                {isLoading ? "Creating Account..." : "Create Account"}
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

          {ssoCheck?.enforceSSO && (
            <div className="mt-4 rounded-md border border-white/15 bg-white/5 p-4">
              <p className="mb-3 text-sm text-zinc-400">
                Your organization requires SSO sign-in. Use the button below to
                authenticate.
              </p>
              <Button
                type="button"
                className="w-full bg-white text-black hover:bg-white/90"
                onClick={handleSSOSignIn}
              >
                Sign in with {ssoCheck.organizationName} SSO &rarr;
              </Button>
            </div>
          )}

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
                callbackURL={safeCallbackUrl || "/dashboard"}
                newUserCallbackURL={onboardingUrl}
                isLoading={isLoading}
                ssoEnforced={false}
              />
            </>
          )}

          <p className="mt-6 text-xs text-zinc-400">
            Already have an account?{" "}
            <Link
              href={signInUrl}
              className="font-medium text-white underline-offset-4 hover:underline"
            >
              Sign in
            </Link>
          </p>
          <p className="mt-2 text-xs text-zinc-400">
            By clicking Create Account, you agree to our Terms of Service and
            Privacy Policy.
          </p>
        </div>
        <div />
      </div>
    </div>
  );
}
