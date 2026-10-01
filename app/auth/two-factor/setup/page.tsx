import { GlobeIcon } from "@/components/auth/auth-icons";
import { TwoFactorSettings } from "@/components/auth/TwoFactorSettings";
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
        </div>
        <TwoFactorSettings continueHref="/dashboard" />
      </div>
    </div>
  );
}
