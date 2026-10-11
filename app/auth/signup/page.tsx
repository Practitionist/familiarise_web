"use client";

import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { pendingToast, useToast } from "@/hooks/use-toast";
import { signIn, signUp, useSession } from "@/lib/auth-client";
import { safeSameOriginPath } from "@/lib/navigation/safe-path";
import { setPendingReferral } from "@/lib/pending-referral";
import { DisplayNameSchema } from "@/schemas/auth";
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULE_HINT,
  passwordTooLong,
} from "@/lib/auth/password-rules";
import { ReferralCodeField } from "./ReferralCodeField";
import {
  referralCheckText,
  useReferralCodeCheck,
} from "./useReferralCodeCheck";
import { FieldError, invalidProps } from "@/components/ui/field-error";
import { AuthEmailField } from "../AuthEmailField";
import {
  humanizeAuthError,
  type AuthErrorAction,
  type AuthErrorField,
} from "@/lib/labels/auth-errors";
import { GlobeIcon } from "@/components/auth/auth-icons";
import { SocialLoginButtons } from "@/components/auth/social-login-buttons";
import { useConfiguredSocialProviders } from "@/components/auth/social-providers-context";
import {
  AuthErrorAffordance,
  type AuthActionTarget,
} from "@/components/auth/AuthErrorAffordance";
import { useRetryAfterCapture } from "@/components/auth/useRetryAfterCapture";
import { markExpectedUnreachable } from "@/lib/auth/expected-auth-failures";
import { cn } from "@/utils/tailwind";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSignedInRedirect } from "../useSignedInRedirect";
import { stashPendingVerificationEmail } from "../pending-verification";
import { AuthFormSkeleton } from "../AuthFormSkeleton";

/** Customer-facing support mailbox. Mirrors `lib/labels/org-errors.ts`. */
const SUPPORT_EMAIL =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@familiarisenow.com";

/**
 * A thrown Better Auth `APIError` keeps `{ code, message }` in `body`; the
 * message is read only so the catalog can pick a field, never shown.
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
  const { data: session, isPending, refetch: refetchSession } = useSession();
  const socialProviders = useConfiguredSocialProviders();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [refCode, setRefCode] = useState(referralCode || "");
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
  // The sentence under the input that was refused, cleared on retype.
  const [fieldError, setFieldError] = useState<
    Partial<Record<AuthErrorField, string>>
  >({});
  // The catalog's "what to do next" for the last failure.
  const [errorAction, setErrorAction] = useState<AuthErrorAction | null>(null);
  const retryAfter = useRetryAfterCapture();
  const refParamCheck = useReferralCodeCheck(
    referralCode ?? "",
    !!referralCode,
  );

  const safeCallbackUrl = safeSameOriginPath(callbackUrl);
  const callbackQuery = safeCallbackUrl
    ? `callbackUrl=${encodeURIComponent(safeCallbackUrl)}`
    : "";
  const onboardingUrl = callbackQuery
    ? `/form/onboarding?${callbackQuery}`
    : "/form/onboarding";
  const signInUrl = callbackQuery
    ? `/auth/signin?${callbackQuery}`
    : "/auth/signin";
  const signUpUrl = callbackQuery
    ? `/auth/signup?${callbackQuery}`
    : "/auth/signup";

  // Replace, never push: /auth/* in history makes Back bounce forward again.
  const signedInTarget = useCallback(
    (user: { onboardingCompleted?: boolean | null }) =>
      user.onboardingCompleted
        ? safeCallbackUrl || "/dashboard"
        : onboardingUrl,
    [safeCallbackUrl, onboardingUrl],
  );
  useSignedInRedirect(session?.user, refetchSession, signedInTarget);

  // Stashed at first touch so it survives OAuth and verification; applied on
  // the onboarding landing. No code here never wipes an earlier stash.
  useEffect(() => {
    if (refCode) setPendingReferral(refCode);
  }, [refCode]);

  // A refused OAuth callback lands here as `?error=<code>`; unknown codes get
  // the generic sign-up copy, never the raw code.
  const callbackError = searchParams.get("error");
  useEffect(() => {
    if (!callbackError) return;
    const copy = humanizeAuthError("signup", { code: callbackError });
    setErrorAction(copy.action ?? null);
    toast({
      title: copy.title,
      description: copy.description,
      variant: "destructive",
    });
  }, [callbackError, toast]);

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

  const handleSSOSignIn = async () => {
    if (!ssoCheck) return;
    try {
      const res = await signIn.sso(ssoCheck.ssoBody);
      if (res?.error) {
        const copy = humanizeAuthError("signup", res.error);
        setErrorAction(copy.action ?? null);
        toast({
          title: copy.title,
          description: copy.description,
          variant: "destructive",
        });
      }
    } catch {
      const copy = humanizeAuthError("signup", { status: 0 });
      setErrorAction(copy.action ?? null);
      toast({
        title: copy.title,
        description: copy.description,
        variant: "destructive",
      });
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldError({});
    setErrorAction(null);
    retryAfter.clear();
    const parsedName = DisplayNameSchema.safeParse(name);
    if (!parsedName.success) {
      setFieldError({
        name: parsedName.error.issues[0]?.message ?? "Enter your name.",
      });
      return;
    }
    if (passwordTooLong(password)) {
      setFieldError({
        password: humanizeAuthError("signup", { code: "PASSWORD_TOO_LONG" })
          .description,
      });
      return;
    }
    if (password !== confirmPassword) {
      setFieldError({ password: "The two passwords don't match." });
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    setIsLoading(true);
    const settle = pendingToast({ title: "Creating account..." });

    /** Everything that depends on the *result* of `signUp.email`. */
    const applyResult = (error: unknown) => {
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
        return;
      }
      // New and existing emails answer identically; the code entry page is
      // the next step either way.
      settle({ title: "Check your email for a 6-digit code" });
      stashPendingVerificationEmail(email);
      router.push(
        callbackQuery
          ? `/auth/verify-email?${callbackQuery}`
          : "/auth/verify-email",
      );
    };

    try {
      const { error } = await signUp.email({
        name: parsedName.data,
        email,
        password,
        // `onResponse` here is how the `Retry-After` header is read.
        fetchOptions: retryAfter.fetchOptions,
      });
      applyResult(error);
    } catch (error: unknown) {
      // Only transport failures are marked expected; anything else keeps
      // error level.
      const { error: reported, marked } = markExpectedUnreachable(error);
      Sentry.captureException(reported, {
        tags: {
          subsystem: "auth",
          ...(marked ? {} : { auth_unreachable: "false" }),
        },
      });
      console.error("Sign up error:", error);
      const thrown = thrownAuthError(error);
      const copy = humanizeAuthError(
        "signup",
        // No status means the request never completed: "couldn't reach".
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

  // Rebuilt per render: the SSO callback closes over this render's ssoCheck.
  const actionTargets: Partial<Record<AuthErrorAction, AuthActionTarget>> = {
    "sign-in": { kind: "link", href: signInUrl },
    "switch-to-sso": {
      kind: "callback",
      onClick: () => void handleSSOSignIn(),
    },
    "contact-support": { kind: "link", href: `mailto:${SUPPORT_EMAIL}` },
  };

  const errorTarget = errorAction ? actionTargets[errorAction] : undefined;
  // An unrecognised `?ref=` falls back to the editable field.
  const showReferralField = !referralCode || refParamCheck.state === "invalid";

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
                name="name"
                autoComplete="name"
                placeholder="Your Name"
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setFieldError((f) => ({ ...f, name: undefined }));
                }}
                required
                disabled={isLoading}
                {...invalidProps(fieldError.name, "name-error")}
              />
              <FieldError id="name-error" message={fieldError.name} />
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
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setFieldError((f) => ({ ...f, password: undefined }));
                    }}
                    required
                    minLength={PASSWORD_MIN_LENGTH}
                    disabled={isLoading}
                    {...invalidProps(fieldError.password, "password-error")}
                  />
                  <FieldError
                    id="password-error"
                    message={fieldError.password}
                  />
                  <p className="text-xs text-zinc-400">{PASSWORD_RULE_HINT}</p>
                </div>
                <div className="grid gap-2 mt-4">
                  <Label htmlFor="confirm-password">Confirm Password</Label>
                  <Input
                    id="confirm-password"
                    name="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    disabled={isLoading}
                  />
                </div>
              </>
            )}
            {showReferralField && !ssoCheck?.enforceSSO && (
              <ReferralCodeField
                value={refCode}
                onChange={setRefCode}
                disabled={isLoading}
              />
            )}
            {!showReferralField && !ssoCheck?.enforceSSO && (
              <output
                className={cn(
                  "mt-4 block rounded-md border p-3 text-sm",
                  refParamCheck.state === "valid"
                    ? "border-green-700 bg-green-900/30 text-green-400"
                    : "border-white/15 bg-white/5 text-zinc-400",
                )}
              >
                Referral code{" "}
                <span className="font-semibold">{referralCode}</span>
                {refParamCheck.state === "idle"
                  ? " will be checked when your account is set up."
                  : `: ${referralCheckText(refParamCheck)}`}
              </output>
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
            {/* The toast carried the copy; this is only the next step. */}
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

          {!ssoCheck?.enforceSSO && socialProviders.length > 0 && (
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
                errorCallbackURL={signUpUrl}
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
            By clicking Create Account, you agree to our{" "}
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
