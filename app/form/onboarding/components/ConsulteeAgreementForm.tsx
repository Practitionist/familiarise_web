import React from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ConsulteeProfile,
  ConsulteePreferences,
  PersonalInfoAndRole,
} from "@/schemas/user";

type ConsulteeFormData = Partial<PersonalInfoAndRole> &
  Partial<ConsulteeProfile> &
  Partial<ConsulteePreferences> & {
    termsAccepted?: boolean;
    privacyAccepted?: boolean;
    marketingConsent?: boolean;
    interests?: string[];
    goals?: string;
  };

interface Props {
  onNext: (data: ConsulteeFormData) => void;
  onBack: () => void;
  formData: ConsulteeFormData;
  /** A final submit is in flight (consultee path). */
  isSubmitting?: boolean;
}

const ConsulteeAgreementForm: React.FC<Props> = ({
  onNext,
  onBack,
  formData,
  isSubmitting = false,
}) => {
  const [termsAccepted, setTermsAccepted] = React.useState(
    formData.termsAccepted || false,
  );
  const [privacyAccepted, setPrivacyAccepted] = React.useState(
    formData.privacyAccepted || false,
  );
  // Recorded server-side with the completion, never before it.
  const [marketingAccepted, setMarketingAccepted] = React.useState(
    formData.marketingConsent || false,
  );

  const handleSubmit = () => {
    if (isSubmitting) return;
    onNext({
      ...formData,
      termsAccepted,
      privacyAccepted,
      marketingConsent: marketingAccepted,
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Terms, Privacy &amp; Data Protection Notice
        </h3>
        <p className="text-sm text-muted-foreground">
          Please review our itemised data protection notice and accept our terms
          to complete your registration
        </p>
      </div>

      {/* DPDP Act 2023 & Rule 3 Itemised Data Protection Notice */}
      <div className="rounded-lg border border-border bg-muted/40 p-4 text-xs text-muted-foreground space-y-2">
        <p className="font-semibold text-foreground text-sm">
          Data Protection Notice (DPDP Act, 2023 &amp; Rule 3)
        </p>
        <p>
          To operate your Familiarise account, we process your{" "}
          <strong>identity &amp; profile details</strong> (name, email, phone,
          learning preferences, and 18+ age verification) for{" "}
          <strong>core account delivery</strong> (
          <code>PRIMARY_PROCESSING</code>
          ), <strong>session scheduling</strong> (<code>SESSION_BOOKING</code>),
          and <strong>live video &amp; chat</strong> via GetStream.io (
          <code>STREAM_DATA_PROCESSING</code>), as well as payment processing
          via Razorpay/Stripe. For platform security and support diagnostics
          (DPDP &sect;8(5) &amp; Rule 6), error traces use a one-way
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

      {/* Checkboxes */}
      <div className="space-y-4">
        <div className="flex items-center space-x-3 p-4 rounded-lg bg-muted/50 border hover:bg-muted transition-colors">
          <Checkbox
            id="terms"
            checked={termsAccepted}
            // Radix CheckedState = boolean | "indeterminate"; no indeterminate here
            onCheckedChange={(checked) => setTermsAccepted(checked as boolean)}
            className="h-5 w-5"
          />
          <label htmlFor="terms" className="text-sm cursor-pointer font-medium">
            I accept the{" "}
            <a
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline transition-colors"
            >
              terms and conditions
            </a>
          </label>
        </div>
        <div className="flex items-center space-x-3 p-4 rounded-lg bg-muted/50 border hover:bg-muted transition-colors">
          <Checkbox
            id="privacy"
            checked={privacyAccepted}
            // Radix CheckedState narrowing — no indeterminate
            onCheckedChange={(checked) =>
              setPrivacyAccepted(checked as boolean)
            }
            className="h-5 w-5"
          />
          <label
            htmlFor="privacy"
            className="text-sm cursor-pointer font-medium"
          >
            I accept the{" "}
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline transition-colors"
            >
              privacy policy
            </a>{" "}
            and give consent for the core platform purposes above
          </label>
        </div>
        <div className="flex items-start space-x-3 p-4 rounded-lg bg-muted/30 border border-dashed border-border hover:bg-muted/50 transition-colors">
          <Checkbox
            id="marketing-consent"
            checked={marketingAccepted}
            onCheckedChange={(checked) =>
              setMarketingAccepted(checked === true)
            }
            className="h-5 w-5 mt-0.5"
          />
          <label
            htmlFor="marketing-consent"
            className="text-sm cursor-pointer leading-snug"
          >
            <span className="font-medium">Optional:</span> Send me product
            updates, mentorship tips, and promotional offers (
            <code>MARKETING_COMMS</code>). You can withdraw this anytime in
            Settings.
          </label>
        </div>
        {(!termsAccepted || !privacyAccepted) && (
          <p className="text-sm text-muted-foreground">
            Accept both required agreements to complete your registration.
          </p>
        )}
      </div>

      {/* Navigation */}
      <div className="flex gap-4 pt-4">
        <Button
          type="button"
          onClick={onBack}
          variant="outline"
          className="flex-1"
        >
          Back
        </Button>
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting || !termsAccepted || !privacyAccepted}
          className="flex-1"
        >
          {isSubmitting ? "Completing…" : "Complete Registration"}
        </Button>
      </div>
    </div>
  );
};

export default ConsulteeAgreementForm;
