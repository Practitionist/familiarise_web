"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import { OnboardingNotice } from "@/components/onboarding/OnboardingNotice";
import { completeOnboardingGateAction } from "@/actions/onboarding-gate.action";
import {
  PURPOSE_CODE_META,
  SIGNUP_PURPOSES,
} from "@/lib/compliance/purpose-codes";

interface OnboardingGateFormProps {
  /** Same-origin path to continue to once the gate is complete. */
  callbackUrl: string;
  /** YYYY-MM-DD already on the account, if any. */
  defaultDateOfBirth?: string;
}

/** Date of birth (18+) and consent for invitees and org members. */
export function OnboardingGateForm({
  callbackUrl,
  defaultDateOfBirth,
}: Readonly<OnboardingGateFormProps>) {
  const [dateOfBirth, setDateOfBirth] = useState(defaultDateOfBirth ?? "");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dobError, setDobError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    setError(null);
    setDobError(null);
    try {
      const result = await completeOnboardingGateAction({
        dateOfBirth,
        termsAccepted,
        privacyAccepted,
        marketingConsent,
      });
      if (result.success) {
        // A full navigation so every guard reads the freshly onboarded row.
        window.location.replace(callbackUrl);
        return;
      }
      if (result.field === "dateOfBirth") setDobError(result.error);
      else setError(result.error);
    } catch {
      setError("We couldn't save that. Check your connection and try again.");
    }
    submittingRef.current = false;
    setIsSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6" noValidate>
      <div className="space-y-2">
        <Label htmlFor="gate-dob">Date of birth</Label>
        <Input
          id="gate-dob"
          type="date"
          autoComplete="bday"
          max={new Date().toISOString().slice(0, 10)}
          value={dateOfBirth}
          onChange={(e) => setDateOfBirth(e.target.value)}
          aria-invalid={dobError ? true : undefined}
          aria-describedby={dobError ? "gate-dob-error" : undefined}
          required
        />
        <p className="text-xs text-muted-foreground">
          You must be 18 or older to use Familiarise.
        </p>
        <FieldError id="gate-dob-error" message={dobError} />
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-4 text-sm">
        <p className="font-medium text-foreground">
          We process your data for these purposes
        </p>
        <ul className="space-y-2">
          {SIGNUP_PURPOSES.map((code) => (
            <li key={code}>
              <p className="font-medium text-foreground">
                {PURPOSE_CODE_META[code].label}
              </p>
              <p className="text-muted-foreground">
                {PURPOSE_CODE_META[code].description}
              </p>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          You can withdraw consent at any time in Settings › Account.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Checkbox
            id="gate-terms"
            checked={termsAccepted}
            onCheckedChange={(checked) => setTermsAccepted(checked === true)}
          />
          <Label htmlFor="gate-terms" className="cursor-pointer text-sm">
            I accept the{" "}
            <a
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Terms of Service
            </a>
          </Label>
        </div>
        <div className="flex items-center gap-3">
          <Checkbox
            id="gate-privacy"
            checked={privacyAccepted}
            onCheckedChange={(checked) => setPrivacyAccepted(checked === true)}
          />
          <Label htmlFor="gate-privacy" className="cursor-pointer text-sm">
            I accept the{" "}
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Privacy Policy
            </a>{" "}
            and consent to the purposes above
          </Label>
        </div>
        <div className="flex items-start gap-3">
          <Checkbox
            id="gate-marketing"
            checked={marketingConsent}
            onCheckedChange={(checked) => setMarketingConsent(checked === true)}
            className="mt-0.5"
          />
          <Label
            htmlFor="gate-marketing"
            className="cursor-pointer text-sm leading-snug"
          >
            <span className="font-medium">Optional:</span> send me product
            updates and offers. You can withdraw this anytime in Settings.
          </Label>
        </div>
      </div>

      {error && <OnboardingNotice tone="warning">{error}</OnboardingNotice>}

      <Button
        type="submit"
        className="w-full"
        disabled={
          isSubmitting || !dateOfBirth || !termsAccepted || !privacyAccepted
        }
      >
        {isSubmitting ? "Saving…" : "Continue"}
      </Button>
    </form>
  );
}
