/**
 * Two-factor enrolment and management for privileged operators.
 *
 * ## Why this component is the load-bearing one
 *
 * `lib/auth-helpers.ts` refuses a staff-or-admin session whose user has
 * `twoFactorEnabled !== true` with `TWO_FACTOR_REQUIRED` (428) and an
 * `enroll-2fa` action, and every privileged helper routes through it. That
 * gate is correct and it is **total**: without an enrolment surface, the first
 * time it shipped it would have locked every existing operator out of every
 * back-office door with no way back in. A security control whose target does
 * not exist is not a control, it is a self-inflicted permanent outage — and it
 * would be discovered by a security change, which is the worst possible time.
 *
 * So this component is not an addition to the settings page. It is the
 * precondition for the gate being allowed to exist, and it is why
 * `TWO_FACTOR_EXEMPT_PATHS` lists `/dashboard/{admin,staff}/settings`.
 *
 * ## Why TOTP, and backup codes as the only fallback
 *
 * TOTP is the primary factor because a staff member's phone is already a second
 * thing they carry. Backup codes are the recovery leg for the operator who has
 * enrolled and then lost their authenticator, and the only one that works with
 * no device at all.
 *
 * ## The one thing that must not regress
 *
 * `twoFactorEnabled` is set to `true` only after a successful TOTP
 * verification (the plugin's own `verifyTotp`, not `skipVerificationOnEnable`),
 * so this component must show the "enter the code from your app" step and only
 * then report success. Setting the flag without a working authenticator would
 * satisfy the gate with a factor nobody can produce.
 */

"use client";

import { useCallback, useEffect, useState } from "react";

import { authClient } from "@/lib/auth-client";
import { AUTH_ERROR_COPY, humanizeAuthError } from "@/lib/labels/auth-errors";
import { toast } from "@/components/ui/use-toast";

type Phase =
  | "loading"
  | "idle"
  | "enrolling" // password confirmed, awaiting a TOTP code
  | "verifying"; // TOTP submitted, waiting on the plugin

interface TotpSetup {
  totpURI: string;
  backupCodes: string[];
}

export function TwoFactorSettings() {
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
      const { data } = await authClient.getSession({
        query: { disableCookieCache: true },
      });
      setEnabled(data?.user?.twoFactorEnabled === true);
    } catch {
      // A session that cannot be read is the `SESSION_LOOKUP_FAILED` case,
      // which the layout guard has already refused on. Nothing to add here.
    } finally {
      setPhase("idle");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(
    work: () => Promise<{ error: { message: string; code?: string } | null }>,
  ) {
    setBusy(true);
    setError(null);
    try {
      const { error: failure } = await work();
      if (failure) {
        setError(
          `${humanizeAuthError("signin", { code: failure.code, message: failure.message }).title}. ${humanizeAuthError("signin", { code: failure.code, message: failure.message }).description}`,
        );
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
    const ok = await run(async () => {
      const result = await authClient.twoFactor.enable({
        password,
        method: "totp",
      });
      // 1.7 discriminates on `method`; only the TOTP branch carries the
      // secret URI and backup codes.
      if (result.data?.method === "totp") {
        setSetup({
          totpURI: result.data.totpURI,
          backupCodes: result.data.backupCodes,
        });
        setPhase("enrolling");
      }
      return { error: result.error as never };
    });
    if (!ok) setPassword("");
  }

  /**
   * Step 2: verify the code. This is the call that flips
   * `twoFactorEnabled` — the plugin refuses to set it until a TOTP code
   * verifies, so skipping this is not possible from the UI.
   */
  async function confirmEnrolment() {
    if (!setup) return;
    const ok = await run(async () => {
      const result = await authClient.twoFactor.verifyTotp({
        code,
        trustDevice: true,
      });
      return { error: result.error as never };
    });
    if (!ok) return;
    setCode("");
    setSetup(null);
    setBackupCodes(setup.backupCodes.length ? setup.backupCodes : null);
    setEnabled(true);
    setPhase("idle");
    toast({ title: "Two-factor authentication is on", variant: "default" });
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
      if (result.data?.backupCodes) setBackupCodes(result.data.backupCodes);
      return { error: result.error as never };
    });
    if (ok) setPassword("");
  }

  /** Turning it off re-opens the account to a password-only compromise. */
  async function disable() {
    if (!password) {
      setError(AUTH_ERROR_COPY.INVALID_PASSWORD.description);
      return;
    }
    const ok = await run(async () => {
      const result = await authClient.twoFactor.disable({ password });
      return { error: result.error as never };
    });
    if (ok) {
      setPassword("");
      setEnabled(false);
      setBackupCodes(null);
      toast({
        title: "Two-factor authentication is off",
        variant: "destructive",
      });
    }
  }

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

  /* The unenrolled state is the whole point of this page, so it leads with the
     consequence rather than the mechanism: a staff account without 2FA cannot
     reach any back-office door. */
  if (!enabled && !setup) {
    return (
      <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-6">
        <h2 className="text-lg font-semibold text-white">
          Two-factor authentication
        </h2>
        <p className="mt-2 text-sm text-neutral-300">
          Your staff account is not protected by a second factor. Until it is,
          back-office tools that move money and change people&apos;s access will
          refuse every request.
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
            className="w-full max-w-sm rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-white"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void beginEnrolment()}
            className="rounded-md bg-white px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50"
          >
            {busy ? "Working…" : "Set up two-factor"}
          </button>
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  /* Step 2: the authenticator app has the secret; the user must prove it works. */
  if (setup) {
    return (
      <section className="rounded-lg border border-neutral-800 p-6">
        <h2 className="text-lg font-semibold text-white">
          Scan this, then enter the code
        </h2>
        <p className="mt-2 text-sm text-neutral-300">
          Add this to an authenticator app (1Password, Google Authenticator,
          Authy…), then type the six-digit code it shows.
        </p>
        <p className="mt-4 break-all rounded-md bg-neutral-900 p-3 text-xs text-neutral-400">
          {setup.totpURI}
        </p>
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
            className="rounded-md bg-white px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50"
          >
            {busy ? "Verifying…" : "Verify"}
          </button>
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  /* Enrolled. */
  return (
    <section className="rounded-lg border border-neutral-800 p-6">
      <h2 className="text-lg font-semibold text-white">
        Two-factor authentication
      </h2>
      <p className="mt-1 text-sm text-emerald-400">
        On — your account requires a second factor.
      </p>

      {backupCodes ? (
        <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-sm font-medium text-amber-200">
            Save these now — they are shown once.
          </p>
          <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs text-neutral-200">
            {backupCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4 space-y-3">
        <label
          className="block text-sm text-neutral-300"
          htmlFor="tfa-password"
        >
          Confirm your password to change anything
        </label>
        <input
          id="tfa-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full max-w-sm rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-white"
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy || !password}
            onClick={() => void regenerateBackupCodes()}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            New backup codes
          </button>
          <button
            type="button"
            disabled={busy || !password}
            onClick={() => void disable()}
            className="rounded-md border border-red-500/50 px-4 py-2 text-sm text-red-300 disabled:opacity-50"
          >
            Turn off
          </button>
        </div>
        <p className="text-xs text-neutral-500">
          Turning it off means a stolen password is enough to reach every
          back-office tool, including issuing refunds.
        </p>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-400">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export default TwoFactorSettings;
