import { PURPOSE_CODE_META } from "@/lib/compliance/purpose-codes";
import { ConsentCheckboxRow } from "./ConsentCheckboxRow";
import { LegalLink } from "./LegalLink";

/** The three sign-up agreements: terms and privacy are required, marketing is its own optional consent. */
export function SignupConsentCheckboxes({
  termsChecked,
  privacyChecked,
  marketingChecked,
  onTermsChange,
  onPrivacyChange,
  onMarketingChange,
}: Readonly<{
  termsChecked: boolean;
  privacyChecked: boolean;
  marketingChecked: boolean;
  onTermsChange: (checked: boolean) => void;
  onPrivacyChange: (checked: boolean) => void;
  onMarketingChange: (checked: boolean) => void;
}>) {
  return (
    <div className="space-y-4">
      <ConsentCheckboxRow
        id="terms"
        checked={termsChecked}
        onCheckedChange={onTermsChange}
      >
        I agree to the <LegalLink href="/terms">Terms and Conditions</LegalLink>
      </ConsentCheckboxRow>
      <ConsentCheckboxRow
        id="privacy"
        checked={privacyChecked}
        onCheckedChange={onPrivacyChange}
      >
        I&apos;ve read the <LegalLink href="/privacy">Privacy Policy</LegalLink>{" "}
        and agree to Familiarise using my information as above
      </ConsentCheckboxRow>
      <ConsentCheckboxRow
        id="marketing-consent"
        checked={marketingChecked}
        onCheckedChange={onMarketingChange}
        optional
      >
        Optional: {PURPOSE_CODE_META.MARKETING_COMMS.description} You can turn
        this off anytime in Settings.
      </ConsentCheckboxRow>
    </div>
  );
}
