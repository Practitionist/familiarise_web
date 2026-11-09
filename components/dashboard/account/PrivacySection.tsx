"use client";

import { useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Section } from "@/components/dashboard/Section";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import {
  FieldError,
  SettingsSaveBar,
  invalidProps,
} from "@/components/dashboard/SettingsLayout";
import { useToast } from "@/hooks/use-toast";
import { useSession } from "@/lib/auth-client";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import { fetchWithReauth } from "@/lib/auth/reauth-client";

// Mirrors the grievances route's schema (#701).
const SUBJECT_MIN = 3;
const SUBJECT_MAX = 200;
const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 5000;

/** The privacy complaint form, posted to `POST /api/compliance/grievances`. */
export function GrievanceSection() {
  const { toast } = useToast();
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<{
    subject?: string;
    description?: string;
  }>({});
  const [isSaving, setIsSaving] = useState(false);

  const reset = () => {
    setSubject("");
    setDescription("");
    setErrors({});
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found: typeof errors = {};
    if (subject.trim().length < SUBJECT_MIN)
      found.subject = `Use at least ${SUBJECT_MIN} characters.`;
    if (description.trim().length < DESCRIPTION_MIN)
      found.description = `Tell us a little more (at least ${DESCRIPTION_MIN} characters).`;
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setIsSaving(true);
    try {
      const res = await fetch("/api/compliance/grievances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: subject.trim(),
          description: description.trim(),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error || "Please try again.");
      }
      reset();
      toast({
        title: "Complaint sent",
        description:
          "Our grievance officer will reply by email. Keep an eye on your inbox.",
      });
    } catch (error) {
      toast({
        title: "Couldn't send your complaint",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Section
      title="Privacy complaint"
      description="Tell us if you think we have mishandled your personal data. Our grievance officer will reply by email. If we don't resolve it, you can complain to the Data Protection Board of India."
      variant="card"
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="grievance-subject">Subject</Label>
          <Input
            id="grievance-subject"
            value={subject}
            maxLength={SUBJECT_MAX}
            onChange={(e) => setSubject(e.target.value)}
            {...invalidProps(errors.subject, "grievance-subject-error")}
          />
          <FieldError id="grievance-subject-error" message={errors.subject} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="grievance-description">What happened?</Label>
          <Textarea
            id="grievance-description"
            rows={5}
            value={description}
            maxLength={DESCRIPTION_MAX}
            onChange={(e) => setDescription(e.target.value)}
            {...invalidProps(errors.description, "grievance-description-error")}
          />
          <FieldError
            id="grievance-description-error"
            message={errors.description}
          />
        </div>
        <SettingsSaveBar
          isSaving={isSaving}
          isDirty={!!(subject || description)}
          onReset={reset}
          saveLabel="Send complaint"
          resetLabel="Clear"
        />
      </form>
    </Section>
  );
}

/** Permanent deletion and withdrawal of core consent, confirmed by typing the account's email. */
export function DeleteAccountSection() {
  const { data: session } = useSession();
  const { toast } = useToast();
  const user = session?.user;

  return (
    <Section
      id="delete-account"
      title="Withdraw consent & delete account"
      description="Withdrawing the consent we need to run your account permanently closes it, signs you out everywhere and erases your personal details."
      variant="card"
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground space-y-1.5">
          <p className="font-medium text-foreground">
            What happens when you withdraw consent &amp; delete your account:
          </p>
          <ul className="list-disc pl-4 space-y-1">
            <li>
              <strong>Before you delete:</strong> Any active upcoming bookings,
              pending consultant payouts, unsettled earnings, or open payment
              disputes must be completed or settled first.
            </li>
            <li>
              <strong>Your details are erased straight away:</strong> Your name,
              email, phone, bio and payout bank details are erased, you are
              signed out everywhere, and your saved cards and notification
              profile are removed.
            </li>
            <li>
              <strong>Tax and accounting records are kept:</strong> If you have
              past payments, the law requires us to keep anonymised invoice,
              ledger and tax-deduction records for several years, up to 8.
            </li>
          </ul>
        </div>
        {user?.email && (
          <ConfirmDialog
            trigger={
              <Button variant="outline" className="text-destructive">
                <Trash2 className="mr-1.5 h-4 w-4" />
                Withdraw consent &amp; delete account
              </Button>
            }
            title="Withdraw consent and delete your account?"
            description="Your personal data will be erased, all active consents withdrawn, and your account permanently closed. This cannot be undone."
            requireTyped={user.email}
            confirmLabel="Delete my account"
            tone="destructive"
            onConfirm={async () => {
              const res = await fetchWithReauth(`/api/user/${user.id}`, {
                method: "DELETE",
              });
              if (!res.ok) {
                const data = (await res.json().catch(() => ({}))) as {
                  error?: string;
                };
                throw new Error(
                  data.error || "We couldn't delete your account.",
                );
              }
              toast({ title: "Account deleted" });
              // The account is gone, so home beats a sign-in page with a dead session.
              await signOutEverywhere("/");
            }}
          />
        )}
      </div>
    </Section>
  );
}
