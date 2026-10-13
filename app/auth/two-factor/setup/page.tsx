import Link from "next/link";

import { GlobeIcon } from "@/components/auth/auth-icons";
import {
  SetupSignOutButton,
  TwoFactorSettings,
} from "@/components/auth/TwoFactorSettings";
import { requireOperatorAwaitingTwoFactor } from "@/lib/auth-guard";

/**
 * First sign-in for a new operator: enrol an authenticator before anything
 * else. The back-office pages redirect here (`requireOperator`), and the API
 * answers 428 `TWO_FACTOR_REQUIRED` until enrolment completes.
 */
export default async function TwoFactorSetupPage() {
  await requireOperatorAwaitingTwoFactor();
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 p-6 text-white">
      <div className="mx-auto w-full max-w-lg space-y-6">
        <div className="text-center">
          <GlobeIcon className="mx-auto h-10 w-auto text-white" />
          <h1 className="mt-6 text-fluid-3xl font-semibold tracking-tight">
            Secure your staff account
          </h1>
          <p className="mt-3 text-sm text-neutral-300">
            Staff accounts can view customer records and issue refunds, so
            two-factor authentication is required on every sign-in.
          </p>
        </div>

        <ol className="list-decimal space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 pl-8 text-sm text-neutral-300">
          <li>
            Install an authenticator app (Google Authenticator, Microsoft
            Authenticator, 1Password, or Authy)
          </li>
          <li>Confirm your password and scan the QR code</li>
          <li>Enter the 6-digit code shown in the app</li>
          <li>Copy or download your backup codes (shown only once)</li>
        </ol>

        <TwoFactorSettings continueHref="/dashboard" />

        <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 text-sm text-neutral-300 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-neutral-400">
            Signed in on the wrong account, or don&apos;t have your phone handy?
            Sign out and return when ready.
          </p>
          <div className="flex shrink-0 items-center gap-3">
            <SetupSignOutButton />
            <Link
              href="/"
              className="text-sm text-neutral-300 underline hover:text-white"
            >
              Back to Familiarise home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
