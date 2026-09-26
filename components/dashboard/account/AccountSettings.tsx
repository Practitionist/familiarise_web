"use client";

import { AccountDetailsSection } from "./AccountDetailsSection";
import {
  ConnectedAccountsSection,
  PasswordSection,
  SessionsSection,
} from "./SignInSecuritySection";
import {
  CookiePreferencesSection,
  DeleteAccountSection,
  GrievanceSection,
} from "./PrivacySection";

export interface AccountSettingsProps {
  /**
   * The Account section's own URL. Social account linking returns here
   * (#1527 §17b — it used to return to the retired `/profile`).
   */
  returnHref: string;
}

/**
 * Settings › Account, the same component in both personal trees (#1527 §14):
 * everything `/profile`, `/settings/change-password` and the consultant's
 * Security section held, plus timezone and the DPDP grievance form. Each
 * block saves on its own, so the save bar only ever speaks for one form.
 */
export function AccountSettings({
  returnHref,
}: Readonly<AccountSettingsProps>) {
  return (
    <div className="space-y-6">
      <AccountDetailsSection />
      <PasswordSection />
      <SessionsSection />
      <ConnectedAccountsSection returnHref={returnHref} />
      <CookiePreferencesSection />
      <GrievanceSection />
      <DeleteAccountSection />
    </div>
  );
}
