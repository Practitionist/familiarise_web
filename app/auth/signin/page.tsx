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
  isPasskeyCancellation,
  type AuthErrorAction,
  type AuthErrorField,
} from "@/lib/labels/auth-errors";
import { signIn, useSession } from "@/lib/auth-client";
import { safeSameOriginPath } from "@/lib/navigation/safe-path";
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
import { useState, useEffect, useMemo, useCallback, Suspense } from "react";
import { useSignedInRedirect } from "../useSignedInRedirect";
import { stashPendingVerificationEmail } from "../pending-verification";
import { AuthFormSkeleton } from "../AuthFormSkeleton";

/** Customer-facing support mailbox. Mirrors `lib/labels/org-errors.ts`. */
const SUPPORT_EMAIL =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@familiarisenow.com";

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
  const { data: session, isPending, refetch: refetchSession } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [ssoCheck, setSsoCheck] = useState<{
    enforceSSO: boolean;
    organizationName: string;
    ssoBody: {
      providerId: string;
      domain: string;
      callbackURL: string;
      errorCallbackURL: string;
    };
  } | null>(null);
  const [ssoChecking, setSsoChecking] = useState(false);
  // The sentence under the input the server refused, cleared on retype.
  const [fieldError, setFieldError] = useState<
    Partial<Record<AuthErrorField, string>>
  >({});
  // The catalog's "what to do next" for the last failure.
  const [errorAction, setErrorAction] = useState<AuthErrorAction | null>(null);
  const retryAfter = useRetryAfterCapture();

  const callbackUrl = useMemo(
    () => safeSameOriginPath(searchParams.get("callbackUrl")),
    [searchParams],
  );

  // A fixed marker set by the revoked-session redirect; it carries no data.
  const wasRevokedElsewhere = searchParams.get("reason") === "session-revoked";

  // A refused OAuth/SSO callback lands here as `?error=<code>`; the catalog
  // answers unknown codes with the generic sign-in copy, never the raw code.
  const callbackError = searchParams.get("error");
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

  // Reassurance copy only, derived from the validated callbackUrl.
  const isPurchaseReturn = useMemo(
    () => callbackUrl?.startsWith("/checkout/") ?? false,
    [callbackUrl],
  );

  const onboardingUrl = callbackUrl
    ? `/form/onboarding?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : "/form/onboarding";
  const signUpUrl = callbackUrl
    ? `/auth/signup?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : "/auth/signup";
  const signInUrl = callbackUrl
    ? `/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : "/auth/signin";

  const signedInTarget = useCallback(
    (user: { onboardingCompleted?: boolean | null }) =>
      user.onboardingCompleted ? callbackUrl || "/dashboard" : onboardingUrl,
    [callbackUrl, onboardingUrl],
  );
  useSignedInRedirect(session?.user, refetchSession, signedInTarget);

  if (isPending) {
    return <AuthFormSkeleton />;
  }

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
    errorCallbackURL: string;
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

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
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
        // The server emails a fresh code alongside EMAIL_NOT_VERIFIED.
        if (copy.needsVerification) {
          settle({ title: copy.title, description: copy.description });
          stashPendingVerificationEmail(email);
          router.push(
            callbackUrl
              ? `/auth/verify-email?callbackUrl=${encodeURIComponent(callbackUrl)}`
              : "/auth/verify-email",
          );
          return;
        }
        setErrorAction(copy.action ?? null);
        if (copy.field) setFieldError({ [copy.field]: copy.description });
        settle({
          title: copy.title,
          description: copy.description,
          variant: "destructive",
        });
        return;
      }
      if (!data) return;
      // An enrolled operator has no session until the authenticator code is
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
      settle({
        title: "Sign In Successful",
        description: callbackUrl
          ? "Redirecting to your destination..."
          : "Redirecting to dashboard...",
      });
      // The session effect above redirects, honouring onboarding status.
    };

    try {
      const { data, error } = await signIn.email({
        email,
        password,
        // `onResponse` here is how the `Retry-After` header is read.
        fetchOptions: retryAfter.fetchOptions,
      });
      applyResult(data, error);
    } catch (error) {
      // A throw means the request never completed. Only transport failures are
      // marked expected; anything else keeps error level.
      const { error: reported, marked } = markExpectedUnreachable(error);
      Sentry.captureException(reported, {
        tags: {
          subsystem: "auth",
          ...(marked ? {} : { auth_unreachable: "false" }),
        },
      });
      console.error("Sign in error:", error);
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

  // A passkey sign-in updates the session store, so the signed-in redirect
  // effect above takes over exactly as after a password sign-in.
  const handlePasskeySignIn = async () => {
    setFieldError({});
    setErrorAction(null);
    retryAfter.clear();
    setPasskeyBusy(true);
    try {
      const { error } = await signIn.passkey({
        fetchOptions: retryAfter.fetchOptions,
      });
      if (!error) {
        toast({ title: "Sign In Successful" });
        return;
      }
      if (isPasskeyCancellation("code" in error ? error.code : null)) return;
      const copy = humanizeAuthError("signin", error, {
        retryAfterSeconds: retryAfter.take(),
      });
      setErrorAction(copy.action ?? null);
      toast({
        title: copy.title,
        description: copy.description,
        variant: "destructive",
      });
    } catch {
      const copy = humanizeAuthError("signin", { status: 0 });
      setErrorAction(copy.action ?? null);
      toast({
        title: copy.title,
        description: copy.description,
        variant: "destructive",
      });
    } finally {
      setPasskeyBusy(false);
    }
  };

  // Rebuilt per render: the callbacks close over this render's email/ssoCheck.
  // `sign-in` is omitted because the visitor is already here.
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
          {/* A guest bounced from checkout must see their selection survived. */}
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
                  name="password"
                  type="password"
                  autoComplete="current-password"
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
                disabled={isLoading || passkeyBusy}
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
            {/* The toast carried the copy; this is only the next step. */}
            <AuthErrorAffordance
              action={errorAction ?? undefined}
              target={errorTarget}
            />
          </form>
          {!ssoCheck?.enforceSSO && (
            <>
              <Button
                type="button"
                variant="outline"
                className="mt-3 w-full border-white/20 bg-transparent text-white hover:bg-white/10 hover:text-white"
                onClick={() => void handlePasskeySignIn()}
                disabled={isLoading || passkeyBusy}
              >
                {passkeyBusy
                  ? "Waiting for your passkey…"
                  : "Staff: sign in with a passkey"}
              </Button>
              {/* Always shown: the corporate SSO button remains even with no social providers. */}
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
                errorCallbackURL={signInUrl}
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
