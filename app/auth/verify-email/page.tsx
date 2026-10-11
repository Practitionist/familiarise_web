"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError, invalidProps } from "@/components/ui/field-error";
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
import { useRetryAfterCapture } from "@/components/auth/useRetryAfterCapture";
import { emailOtp, useSession } from "@/lib/auth-client";
import {
  clearPendingVerificationEmail,
  readPendingVerificationEmail,
} from "../pending-verification";
import { safeSameOriginPath } from "@/lib/navigation/safe-path";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { z } from "zod";
import { AuthCardSkeleton } from "../AuthCardSkeleton";

/** Customer-facing support mailbox. Mirrors `lib/labels/org-errors.ts`. */
const SUPPORT_EMAIL =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@familiarisenow.com";

const CODE_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 60;
const EmailSchema = z.string().trim().email();
// The verify response's user carries the additional fields untyped.
const OnboardedSchema = z.object({ onboardingCompleted: z.literal(true) });

export default function VerifyEmail() {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <VerifyEmailContent />
    </Suspense>
  );
}

function VerifyEmailContent() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, isPending } = useSession();
  const callbackUrl = safeSameOriginPath(searchParams.get("callbackUrl"));
  const onboardingUrl = callbackUrl
    ? `/form/onboarding?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : "/form/onboarding";
  const signInUrl = callbackUrl
    ? `/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : "/auth/signin";
  // Sign-up and sign-in send a code, then stash the address for this tab.
  const [presetEmail, setPresetEmail] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [errorCopy, setErrorCopy] = useState<AuthErrorCopy | null>(null);
  const verifyRetryAfter = useRetryAfterCapture();
  const resendRetryAfter = useRetryAfterCapture();

  useEffect(() => {
    const stashed = EmailSchema.safeParse(readPendingVerificationEmail() ?? "");
    if (!stashed.success) return;
    setPresetEmail(stashed.data);
    setEmail(stashed.data);
    setCooldown(RESEND_COOLDOWN_SECONDS);
  }, []);

  const sessionUser = session?.user;
  useEffect(() => {
    if (verified || !sessionUser?.emailVerified) return;
    router.replace(
      sessionUser.onboardingCompleted
        ? callbackUrl || "/dashboard"
        : onboardingUrl,
    );
  }, [verified, sessionUser, router, callbackUrl, onboardingUrl]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const parsedEmail = (): string | null => {
    const parsed = EmailSchema.safeParse(email);
    if (parsed.success) return parsed.data;
    setErrorCopy(humanizeAuthError("verify", { code: "INVALID_EMAIL" }));
    return null;
  };

  const handleResend = async () => {
    if (cooldown > 0 || resending) return;
    const target = parsedEmail();
    if (!target) return;
    setResending(true);
    setErrorCopy(null);
    resendRetryAfter.clear();
    try {
      const { error } = await emailOtp.sendVerificationOtp({
        email: target,
        type: "email-verification",
        fetchOptions: resendRetryAfter.fetchOptions,
      });
      if (error) {
        const wait = resendRetryAfter.take();
        if (wait) setCooldown(wait);
        setErrorCopy(
          humanizeAuthError("verify", error, { retryAfterSeconds: wait }),
        );
        return;
      }
      setCode("");
      setCooldown(RESEND_COOLDOWN_SECONDS);
      toast({
        title: "Code sent",
        description: `If ${target} is waiting to be verified, a new code is on its way. It expires in 10 minutes.`,
      });
    } catch {
      setErrorCopy(humanizeAuthError("verify", { status: 0 }));
    } finally {
      setResending(false);
    }
  };

  const handleVerify = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (code.length !== CODE_LENGTH || verifying) return;
    const target = parsedEmail();
    if (!target) return;
    setVerifying(true);
    setErrorCopy(null);
    verifyRetryAfter.clear();
    try {
      const { data, error } = await emailOtp.verifyEmail({
        email: target,
        otp: code,
        fetchOptions: verifyRetryAfter.fetchOptions,
      });
      if (error) {
        const copy = humanizeAuthError("verify", error, {
          retryAfterSeconds: verifyRetryAfter.take(),
        });
        setErrorCopy(copy);
        if (copy.field === "code") setCode("");
        return;
      }
      setVerified(true);
      clearPendingVerificationEmail();
      const onboarded = OnboardedSchema.safeParse(data.user);
      router.replace(
        onboarded.success ? callbackUrl || "/dashboard" : onboardingUrl,
      );
    } catch {
      setErrorCopy(humanizeAuthError("verify", { status: 0 }));
    } finally {
      setVerifying(false);
    }
  };

  // The permanent resend button services `resend-verification`.
  const actionTargets: Partial<Record<AuthErrorAction, AuthActionTarget>> = {
    "sign-in": { kind: "link", href: signInUrl },
    "contact-support": { kind: "link", href: `mailto:${SUPPORT_EMAIL}` },
  };
  const errorTarget = errorCopy?.action
    ? actionTargets[errorCopy.action]
    : undefined;
  const codeError =
    errorCopy?.field === "code" ? errorCopy.description : undefined;
  const emailError =
    !presetEmail && errorCopy?.field === "email"
      ? errorCopy.description
      : undefined;
  const formError = errorCopy && !codeError && !emailError ? errorCopy : null;

  if (isPending || verified || sessionUser?.emailVerified) {
    return <AuthCardSkeleton />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 p-6">
      <div className="w-full max-w-md text-white">
        <h1 className="mb-3 text-fluid-3xl font-semibold tracking-tight">
          Verify your email
        </h1>
        <p className="text-sm md:text-base text-zinc-400 mb-6">
          {presetEmail ? (
            <>
              We emailed a 6-digit code to{" "}
              <span className="font-medium text-white">{presetEmail}</span>. It
              expires in 10 minutes.
            </>
          ) : (
            "Enter your email and the 6-digit code we sent you. Codes expire in 10 minutes."
          )}
        </p>

        <form onSubmit={handleVerify} className="grid gap-4">
          {!presetEmail && (
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                name="email"
                placeholder="name@example.com"
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect="off"
                autoFocus
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setErrorCopy(null);
                }}
                disabled={verifying}
                {...invalidProps(emailError, "email-error")}
              />
              <FieldError id="email-error" message={emailError} />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="code">Verification code</Label>
            <Input
              id="code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={CODE_LENGTH}
              autoFocus={!!presetEmail}
              required
              placeholder="123456"
              className="tracking-[0.5em] text-lg"
              value={code}
              onChange={(e) => {
                setCode(
                  e.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH),
                );
                setErrorCopy(null);
              }}
              disabled={verifying}
              {...invalidProps(codeError, "code-error")}
            />
            <FieldError id="code-error" message={codeError} />
          </div>
          {formError && (
            <div role="alert" className="text-sm text-red-400">
              <p className="font-medium">{formError.title}</p>
              <p>{formError.description}</p>
            </div>
          )}
          <Button
            type="submit"
            className="w-full bg-white text-black hover:bg-white/90"
            disabled={verifying || code.length !== CODE_LENGTH}
          >
            {verifying ? "Verifying…" : "Verify email"}
          </Button>
        </form>

        <Button
          type="button"
          className="w-full mt-4 bg-zinc-800 hover:bg-zinc-700"
          onClick={() => void handleResend()}
          disabled={resending || cooldown > 0}
        >
          {resending
            ? "Sending…"
            : cooldown > 0
              ? `Resend code in ${cooldown}s`
              : "Resend code"}
        </Button>

        <AuthErrorAffordance action={errorCopy?.action} target={errorTarget} />

        <p className="mt-6 text-xs text-zinc-400">
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
