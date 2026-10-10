/**
 * Two-factor enrolment and backup-code management for operators.
 *
 * Mounted on /auth/two-factor/setup (the only page an unenrolled operator can
 * open, see `requireOperatorAwaitingTwoFactor` in lib/auth-guard.ts) and on
 * the back-office settings page once enrolled.
 *
 * ## The one thing that must not regress
 *
 * `twoFactorEnabled` is set to `true` only after a successful TOTP
 * verification (the plugin's own `verifyTotp`, not `skipVerificationOnEnable`),
 * so this component must show the "enter the code from your app" step and only
 * then report success. Setting the flag without a working authenticator would
 * satisfy the gate with a factor nobody can produce.
 *
 * There is no "turn off": 2FA is mandatory for operators and lib/auth.ts
 * refuses `/two-factor/disable` for them. A lost authenticator is recovered
 * with a backup code or an admin reset from the Team page.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { PasskeyList } from "@/components/auth/PasskeyList";
import { invalidProps } from "@/components/ui/field-error";
import { toast } from "@/components/ui/use-toast";
import { authClient } from "@/lib/auth-client";
import { withReauth } from "@/lib/auth/reauth-client";
import { AUTH_ERROR_COPY, humanizeAuthError } from "@/lib/labels/auth-errors";

type Phase = "loading" | "idle" | "enrolling";

interface TotpSetup {
  totpURI: string;
  secret: string;
  backupCodes: string[];
}

const ERROR_ID = "tfa-error";
const QR_LABEL = "QR code to scan with your authenticator app";

const inputClass =
  "w-full max-w-sm rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-white";
const primaryButton =
  "rounded-md bg-white px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50";
const secondaryButton =
  "rounded-md border border-neutral-700 px-4 py-2 text-sm text-white disabled:opacity-50";

/** The base32 secret inside the otpauth:// URI, for manual entry. */
function secretOf(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

/** Groups of four, which authenticator apps accept with the spaces. */
function chunkSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

function backupCodesText(codes: readonly string[]): string {
  return [
    "Familiarise backup codes",
    "Each code signs you in once if you lose your authenticator app.",
    "",
    ...codes,
    "",
  ].join("\n");
}

function BackupCodes({
  codes,
  continueHref,
}: Readonly<{ codes: readonly string[]; continueHref?: string }>) {
  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(backupCodesText(codes));
      toast({ title: "Backup codes copied" });
    } catch {
      toast({
        title: "Couldn't copy the codes",
        description: "Select them and copy them by hand, or download them.",
        variant: "destructive",
      });
    }
  }

  function downloadCodes() {
    const url = URL.createObjectURL(
      new Blob([backupCodesText(codes)], { type: "text/plain" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "familiarise-backup-codes.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
      <p className="text-sm font-medium text-amber-200">
        Save these backup codes now — they are shown once. Each one signs you in
        once if you lose your authenticator.
      </p>
      <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs text-neutral-200">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void copyCodes()}
          className={secondaryButton}
        >
          Copy codes
        </button>
        <button
          type="button"
          onClick={downloadCodes}
          className={secondaryButton}
        >
          Download .txt
        </button>
      </div>
      {continueHref ? (
        <button
          type="button"
          onClick={() => window.location.assign(continueHref)}
          className={`mt-4 ${primaryButton}`}
        >
          I&apos;ve saved these codes — continue
        </button>
      ) : null}
    </div>
  );
}

export function TwoFactorSettings({
  continueHref,
}: Readonly<{
  /** Where "I've saved these codes" goes after enrolment (the setup page). */
  continueHref?: string;
}>) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [enabled, setEnabled] = useState(false);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await authClient.getSession();
      setEnabled(data?.user?.twoFactorEnabled === true);
    } catch {
      // A session that cannot be read is the `SESSION_LOOKUP_FAILED` case,
      // which the page guard has already refused on. Nothing to add here.
    } finally {
      setPhase("idle");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(
    work: () => Promise<{ error: { message?: string; code?: string } | null }>,
  ) {
    setBusy(true);
    setError(null);
    try {
      const { error: failure } = await work();
      if (failure) {
        const copy = humanizeAuthError("signin", failure);
        setError(`${copy.title}. ${copy.description}`);
        return false;
      }
      return true;
    } catch (thrown) {
      const copy = humanizeAuthError("signin", {
        message: thrown instanceof Error ? thrown.message : String(thrown),
        status: 0,
      });
      setError(`${copy.title}. ${copy.description}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Step 1: prove the password before issuing a TOTP secret. */
  async function beginEnrolment(event: React.FormEvent) {
    event.preventDefault();
    if (!password) {
      setError(AUTH_ERROR_COPY.INVALID_PASSWORD.description);
      return;
    }
    await run(async () => {
      const result = await authClient.twoFactor.enable({
        password,
        method: "totp",
      });
      // 1.7 discriminates on `method`; only the TOTP branch carries the
      // secret URI and backup codes.
      if (result.data?.method === "totp") {
        setSetup({
          totpURI: result.data.totpURI,
          secret: secretOf(result.data.totpURI),
          backupCodes: result.data.backupCodes,
        });
        setPhase("enrolling");
      }
      return { error: result.error };
    });
    setPassword("");
  }

  /**
   * Step 2: verify the first code. This is the call that flips
   * `twoFactorEnabled`, and it re-issues the session cookie.
   */
  async function confirmEnrolment(event: React.FormEvent) {
    event.preventDefault();
    if (!setup || code.length !== 6) return;
    const ok = await run(async () => {
      const result = await authClient.twoFactor.verifyTotp({ code });
      return { error: result.error };
    });
    if (!ok) return;
    setCode("");
    setSetup(null);
    setBackupCodes(setup.backupCodes);
    setEnabled(true);
    setPhase("idle");
    toast({ title: "Two-factor authentication is on" });
  }

  async function regenerateBackupCodes(event: React.FormEvent) {
    event.preventDefault();
    if (!password) {
      setError(AUTH_ERROR_COPY.INVALID_PASSWORD.description);
      return;
    }
    const ok = await run(async () => {
      const result = await withReauth(() =>
        authClient.twoFactor.generateBackupCodes({ password }),
      );
      if (result.data?.backupCodes) setBackupCodes(result.data.backupCodes);
      return { error: result.error };
    });
    if (ok) setPassword("");
  }

  const errorLine = error ? (
    <p id={ERROR_ID} role="alert" className="mt-3 text-sm text-red-400">
      {error}
    </p>
  ) : null;
  const describedByError = invalidProps(error, ERROR_ID);

  if (phase === "loading") {
    return (
      <section
        aria-busy="true"
        className="rounded-lg border border-neutral-800 p-6"
      >
        <p className="text-sm text-neutral-400">Loading security settings…</p>
      </section>
    );
  }

  if (setup) {
    return (
      <section className="rounded-lg border border-neutral-800 p-6">
        <h2 className="text-lg font-semibold text-white">
          Scan this, then enter the code
        </h2>
        <p className="mt-2 text-sm text-neutral-300">
          Scan the code with an authenticator app (1Password, Google
          Authenticator, Authy…), then type the six-digit code it shows.
        </p>
        <div className="mt-4 inline-block rounded-md bg-white p-3">
          <QRCodeSVG
            value={setup.totpURI}
            size={176}
            title={QR_LABEL}
            role="img"
            aria-label={QR_LABEL}
          />
        </div>
        {setup.secret ? (
          <p className="mt-3 text-sm text-neutral-400">
            Can&apos;t scan? Enter this key manually:{" "}
            <code className="break-all font-mono text-neutral-200">
              {chunkSecret(setup.secret)}
            </code>
          </p>
        ) : null}
        <form
          className="mt-4 flex gap-2"
          onSubmit={(event) => void confirmEnrolment(event)}
        >
          <input
            aria-label="Six digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="w-32 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-white"
            {...describedByError}
          />
          <button
            type="submit"
            disabled={busy || code.length !== 6}
            className={primaryButton}
          >
            {busy ? "Verifying…" : "Verify"}
          </button>
        </form>
        {errorLine}
      </section>
    );
  }

  if (!enabled) {
    return (
      <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-6">
        <h2 className="text-lg font-semibold text-white">
          Set up two-factor authentication
        </h2>
        <p className="mt-2 text-sm text-neutral-300">
          Staff accounts need an authenticator app. Until it is set up, the back
          office stays closed to you.
        </p>
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => void beginEnrolment(event)}
        >
          <label
            className="block text-sm text-neutral-300"
            htmlFor="tfa-enable-password"
          >
            Confirm your password to continue
          </label>
          <input
            id="tfa-enable-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
            {...describedByError}
          />
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? "Working…" : "Set up two-factor"}
          </button>
        </form>
        {errorLine}
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-neutral-800 p-6">
      <h2 className="text-lg font-semibold text-white">
        Two-factor authentication
      </h2>
      <p className="mt-1 text-sm text-emerald-400">
        On — every sign-in asks for a code from your authenticator app.
      </p>

      {backupCodes ? (
        <BackupCodes codes={backupCodes} continueHref={continueHref} />
      ) : null}

      {continueHref ? null : (
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => void regenerateBackupCodes(event)}
        >
          <label
            className="block text-sm text-neutral-300"
            htmlFor="tfa-password"
          >
            Confirm your password to replace your backup codes
          </label>
          <input
            id="tfa-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
            {...describedByError}
          />
          <button
            type="submit"
            disabled={busy || !password}
            className={secondaryButton}
          >
            New backup codes
          </button>
        </form>
      )}
      {errorLine}
      {continueHref ? null : <PasskeyList />}
    </section>
  );
}
