"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { AuthFormSkeleton } from "@/app/auth/AuthFormSkeleton";
import { GlobeIcon } from "@/components/auth/auth-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { humanizeAuthError } from "@/lib/labels/auth-errors";
import { safeSameOriginPath } from "@/lib/navigation/safe-path";

/**
 * The second step of an operator sign-in. `/sign-in/email` answered
 * `twoFactorRedirect` and set the short-lived two-factor cookie; this page
 * trades an authenticator code (or one backup code) for the real session.
 *
 * No "trust this device" option: operators are challenged on every sign-in,
 * and lib/auth.ts refuses `trustDevice` on these endpoints anyway.
 */
export default function TwoFactorChallengePage() {
  return (
    <Suspense fallback={<AuthFormSkeleton />}>
      <TwoFactorChallenge />
    </Suspense>
  );
}

function TwoFactorChallenge() {
  const searchParams = useSearchParams();
  const callbackUrl = safeSameOriginPath(searchParams.get("callbackUrl"));
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { error: failure } = useBackupCode
        ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
        : await authClient.twoFactor.verifyTotp({ code });
      if (failure) {
        const copy = humanizeAuthError("signin", failure);
        setError(`${copy.title}. ${copy.description}`);
        setCode("");
        return;
      }
      // A full navigation, so the server guards read the new session cookie.
      window.location.assign(callbackUrl || "/dashboard");
    } catch (thrown) {
      const copy = humanizeAuthError("signin", {
        message: thrown instanceof Error ? thrown.message : String(thrown),
        status: 0,
      });
      setError(`${copy.title}. ${copy.description}`);
    } finally {
      setBusy(false);
    }
  };

  const ready = useBackupCode ? code.trim().length > 0 : code.length === 6;

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 p-6 text-white">
      <div className="mx-auto flex w-full max-w-md flex-col">
        <div className="text-center">
          <GlobeIcon className="mx-auto h-10 w-auto text-white" />
          <h2 className="mt-6 text-fluid-3xl font-semibold tracking-tight">
            Two-factor authentication
          </h2>
          <p className="mt-2 text-sm text-zinc-400 md:text-base">
            {useBackupCode
              ? "Enter one of the backup codes you saved when you set up two-factor. Each code works once."
              : "Enter the six-digit code from your authenticator app."}
          </p>
        </div>
        <form className="mt-8 space-y-6" onSubmit={submit}>
          <div className="grid gap-2">
            <Label htmlFor="two-factor-code" className="sr-only">
              {useBackupCode ? "Backup code" : "Authenticator code"}
            </Label>
            <Input
              id="two-factor-code"
              autoFocus
              autoComplete="one-time-code"
              inputMode={useBackupCode ? "text" : "numeric"}
              maxLength={useBackupCode ? 32 : 6}
              placeholder={useBackupCode ? "Backup code" : "123456"}
              value={code}
              onChange={(e) =>
                setCode(
                  useBackupCode
                    ? e.target.value
                    : e.target.value.replace(/\D/g, ""),
                )
              }
              disabled={busy}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            className="w-full bg-white text-black hover:bg-white/90"
            disabled={busy || !ready}
          >
            {busy ? "Verifying…" : "Verify"}
          </Button>
        </form>
        <div className="mt-6 flex flex-col items-center gap-3 text-sm">
          <button
            type="button"
            className="font-medium text-zinc-300 underline-offset-4 hover:text-white hover:underline"
            onClick={() => {
              setUseBackupCode((value) => !value);
              setCode("");
              setError(null);
            }}
          >
            {useBackupCode
              ? "Use my authenticator app instead"
              : "Lost your authenticator? Use a backup code"}
          </button>
          <Link
            href="/auth/signin"
            className="text-zinc-400 underline-offset-4 hover:text-white hover:underline"
          >
            Start over
          </Link>
        </div>
      </div>
    </div>
  );
}
