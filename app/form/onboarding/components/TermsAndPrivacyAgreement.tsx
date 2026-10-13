import React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

interface AgreementProps {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  link: string;
}

const Agreement: React.FC<AgreementProps> = ({
  id,
  checked,
  onCheckedChange,
  label,
  link,
}) => {
  return (
    <div className="flex items-center space-x-3 p-4 rounded-lg bg-muted/50 border hover:bg-muted transition-colors">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="h-5 w-5"
      />
      <Label htmlFor={id} className="text-sm cursor-pointer">
        I agree to the{" "}
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline transition-colors"
        >
          {label}
        </a>
      </Label>
    </div>
  );
};

interface TermsAndPrivacyAgreementProps {
  onTermsChange: (checked: boolean) => void;
  onPrivacyChange: (checked: boolean) => void;
  onMarketingChange: (checked: boolean) => void;
  termsChecked: boolean;
  privacyChecked: boolean;
  /** Optional MARKETING_COMMS consent, recorded with the onboarding submit. */
  marketingChecked: boolean;
}

const TermsAndPrivacyAgreement: React.FC<TermsAndPrivacyAgreementProps> = ({
  onTermsChange,
  onPrivacyChange,
  onMarketingChange,
  termsChecked,
  privacyChecked,
  marketingChecked,
}) => {
  return (
    <div className="space-y-4">
      {/* DPDP Act 2023 & Rule 3 Itemised Data Protection Notice */}
      <div className="rounded-lg border border-border bg-muted/40 p-4 text-xs text-muted-foreground space-y-2">
        <p className="font-semibold text-foreground text-sm">
          Data Protection Notice (DPDP Act, 2023 &amp; Rule 3)
        </p>
        <p>
          To operate your Familiarise account, we process your{" "}
          <strong>identity &amp; profile details</strong> (name, email, phone,
          professional bio, and 18+ age verification) for{" "}
          <strong>core account delivery</strong> (
          <code>PRIMARY_PROCESSING</code>
          ), <strong>session scheduling</strong> (<code>SESSION_BOOKING</code>),
          and <strong>live video &amp; chat</strong> via GetStream.io (
          <code>STREAM_DATA_PROCESSING</code>), as well as payment/payout
          settlement via Razorpay/Stripe. For platform security and support
          diagnostics (DPDP &sect;8(5) &amp; Rule 6), error traces use a one-way
          pseudonymous token (<code>ust_&lt;hash&gt;</code>) with no raw PII
          sent to Sentry.
        </p>
        <p>
          You can <strong>download your data &amp; processor summary</strong>,{" "}
          <strong>withdraw optional consents</strong> in 1 click,{" "}
          <strong>withdraw core consent &amp; delete your account</strong>{" "}
          (subject to Indian 7–8 yr tax invoice retention), or{" "}
          <strong>file a data protection grievance</strong> (with escalation to
          the Data Protection Board of India) anytime in{" "}
          <strong>Settings &rarr; Account</strong>.
        </p>
      </div>

      <Agreement
        id="terms"
        checked={termsChecked}
        onCheckedChange={onTermsChange}
        label="Terms of Service"
        link="/terms"
      />
      <Agreement
        id="privacy"
        checked={privacyChecked}
        onCheckedChange={onPrivacyChange}
        label="Privacy Policy & Core Data Processing Notice"
        link="/privacy"
      />

      {/* Optional Marketing Consent (Granular / Unbundled per DPDP §6) */}
      <div className="flex items-start space-x-3 p-4 rounded-lg bg-muted/30 border border-dashed border-border hover:bg-muted/50 transition-colors">
        <Checkbox
          id="marketing-consent"
          checked={marketingChecked}
          onCheckedChange={(checked) => onMarketingChange(checked === true)}
          className="h-5 w-5 mt-0.5"
        />
        <Label
          htmlFor="marketing-consent"
          className="text-sm cursor-pointer leading-snug"
        >
          <span className="font-medium">Optional:</span> Send me product
          updates, mentorship tips, and promotional offers (
          <code>MARKETING_COMMS</code>). You can withdraw this anytime in
          Settings.
        </Label>
      </div>
    </div>
  );
};

export default TermsAndPrivacyAgreement;
