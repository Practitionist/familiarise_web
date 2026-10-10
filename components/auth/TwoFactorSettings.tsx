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

import { authClient } from "@/lib/auth-client";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import { AUTH_ERROR_COPY, humanizeAuthError } from "@/lib/labels/auth-errors";
import { toast } from "@/components/ui/use-toast";

type Phase = "loading" | "idle" | "enrolling";

interface TotpSetup {
  totpURI: string;
  secret: string;
  backupCodes: string[];
}

const inputClass =
  "w-full max-w-sm rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-white";
const primaryButton =
  "rounded-md bg-white px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50";
const secondaryButton =
  "rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50";

/** The base32 secret inside the otpauth:// URI, for manual entry. */
function secretOf(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

export function SetupSignOutButton() {
  const [signingOut, setSigningOut] = useState(false);

  return (
    <button
      type="button"
      disabled={signingOut}
      onClick={() => {
        setSigningOut(true);
        void signOutEverywhere();
      }}
      className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
    >
      {signingOut ? "Signing out…" : "Sign out"}
    </button>
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
  const [savedCodesAcknowledged, setSavedCodesAcknowledged] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await authClient.getSession({
        query: { disableCookieCache: true },
      });
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
  async function beginEnrolment() {
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
  async function confirmEnrolment() {
    if (!setup) return;
    const ok = await run(async () => {
      const result = await authClient.twoFactor.verifyTotp({ code });
      return { error: result.error };
    });
    if (!ok) return;
    setCode("");
    setSetup(null);
    setBackupCodes(setup.backupCodes);
    setSavedCodesAcknowledged(false);
    setEnabled(true);
    setPhase("idle");
    toast({ title: "Two-factor authentication is on" });
  }

  async function regenerateBackupCodes() {
    if (!password) {
      setError(AUTH_ERROR_COPY.INVALID_PASSWORD.description);
      return;
    }
    const ok = await run(async () => {
      const result = await authClient.twoFactor.generateBackupCodes({
        password,
      });
      if (result.data?.backupCodes) {
        setBackupCodes(result.data.backupCodes);
        setSavedCodesAcknowledged(false);
      }
      return { error: result.error };
    });
    if (ok) setPassword("");
  }

  function handleCopyCodes(codes: string[]) {
    void navigator.clipboard.writeText(codes.join("\n"));
    toast({ title: "Backup codes copied to clipboard" });
  }

  function handleDownloadCodes(codes: string[]) {
    const blob = new Blob([`${codes.join("\n")}\n`], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "familiarise-backup-codes.txt";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  const errorLine = error ? (
    <p role="alert" className="mt-3 text-sm text-red-400">
      {error}
    </p>
  ) : null;

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
          <QRCodeSVG value={setup.totpURI} size={176} />
        </div>
        {setup.secret ? (
          <p className="mt-3 text-sm text-neutral-400">
            Can&apos;t scan? Enter this key manually:{" "}
            <code className="break-all font-mono text-neutral-200">
              {setup.secret}
            </code>
          </p>
        ) : null}
        <div className="mt-4 flex gap-2">
          <input
            aria-label="Six digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="w-32 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-white"
          />
          <button
            type="button"
            disabled={busy || code.length !== 6}
            onClick={() => void confirmEnrolment()}
            className={primaryButton}
          >
            {busy ? "Verifying…" : "Verify"}
          </button>
        </div>
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
        <div className="mt-4 space-y-3">
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
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void beginEnrolment()}
            className={primaryButton}
          >
            {busy ? "Working…" : "Set up two-factor"}
          </button>
        </div>
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
      <p className="mt-2 text-sm text-neutral-300">
        Lost your authenticator? Use a backup code, or ask an admin to reset
        your two-factor authentication from the Team page.
      </p>

      {backupCodes ? (
        <div className="mt-4 space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-sm font-medium text-amber-200">
            Save these backup codes now — they are shown once. Each one signs
            you in once if you lose your authenticator.
          </p>
          <p className="text-xs text-neutral-300">
            Leaving or reloading this page loses these codes. You can generate
            new ones later from Settings using your password.
          </p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-xs text-neutral-200">
            {backupCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => handleCopyCodes(backupCodes)}
              className={secondaryButton}
            >
              Copy codes
            </button>
            <button
              type="button"
              onClick={() => handleDownloadCodes(backupCodes)}
              className={secondaryButton}
            >
              Download .txt
            </button>
          </div>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={savedCodesAcknowledged}
              onChange={(e) => setSavedCodesAcknowledged(e.target.checked)}
              className="h-4 w-4 rounded border-neutral-600 bg-neutral-900"
            />
            <span>I have saved my backup codes</span>
          </label>
          {continueHref ? (
            <button
              type="button"
              disabled={!savedCodesAcknowledged}
              onClick={() => window.location.assign(continueHref)}
              className={primaryButton}
            >
              I&apos;ve saved these codes — continue
            </button>
          ) : null}
        </div>
      ) : null}

      {continueHref ? null : (
        <div className="mt-4 space-y-3">
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
          />
          <button
            type="button"
            disabled={busy || !password}
            onClick={() => void regenerateBackupCodes()}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            New backup codes
          </button>
        </div>
      )}
      {errorLine}
    </section>
  );
}

export default TwoFactorSettings;
