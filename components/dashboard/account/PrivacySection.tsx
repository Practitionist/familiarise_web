"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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

interface CookiePrefs {
  analytics: boolean;
  marketing: boolean;
}

/** Cookie consent, from the retired `/profile` page. Essential is always on. */
export function CookiePreferencesSection() {
  const { toast } = useToast();
  const [baseline, setBaseline] = useState<CookiePrefs>({
    analytics: false,
    marketing: false,
  });
  const [prefs, setPrefs] = useState<CookiePrefs>(baseline);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/user/cookie-preferences").catch(() => null);
      if (!res?.ok || cancelled) return;
      const { data } = (await res.json()) as { data: CookiePrefs };
      const loaded = { analytics: data.analytics, marketing: data.marketing };
      setBaseline(loaded);
      setPrefs(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const res = await fetch("/api/user/cookie-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prefs),
      });
      if (!res.ok) throw new Error("save failed");
      setBaseline(prefs);
      toast({ title: "Cookie preferences saved" });
    } catch {
      toast({
        title: "Couldn't save your cookie preferences",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const rows = [
    {
      key: "essential",
      label: "Essential",
      hint: "Required for sign-in and checkout; always on.",
    },
    {
      key: "analytics",
      label: "Analytics",
      hint: "Helps us see which pages are slow or confusing.",
    },
    {
      key: "marketing",
      label: "Marketing",
      hint: "Personalised recommendations.",
    },
  ] as const;

  return (
    <Section
      title="Cookies"
      description="How this browser may use cookies."
      variant="card"
    >
      <form onSubmit={submit} className="space-y-4">
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li
              key={row.key}
              className="flex items-center justify-between gap-4 py-3 first:pt-0"
            >
              <div>
                <Label
                  htmlFor={`cookie-${row.key}`}
                  className="font-medium text-foreground"
                >
                  {row.label}
                </Label>
                <p className="text-sm text-muted-foreground">{row.hint}</p>
              </div>
              {row.key === "essential" ? (
                <Switch id="cookie-essential" checked disabled />
              ) : (
                <Switch
                  id={`cookie-${row.key}`}
                  checked={prefs[row.key]}
                  onCheckedChange={(checked) =>
                    setPrefs((prev) => ({ ...prev, [row.key]: checked }))
                  }
                />
              )}
            </li>
          ))}
        </ul>
        <SettingsSaveBar
          isSaving={isSaving}
          isDirty={
            prefs.analytics !== baseline.analytics ||
            prefs.marketing !== baseline.marketing
          }
          onReset={() => setPrefs(baseline)}
        />
      </form>
    </Section>
  );
}

// Mirrors the grievances route's schema (#701).
const SUBJECT_MIN = 3;
const SUBJECT_MAX = 200;
const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 5000;

/**
 * #1527 §14 — the DPDP grievance form. `POST /api/compliance/grievances` has
 * existed since #701 with no page calling it; this is that page.
 */
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
        title: "Grievance filed",
        description:
          "Our grievance officer will reply by email. Keep an eye on your inbox.",
      });
    } catch (error) {
      toast({
        title: "Couldn't file your grievance",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Section
      title="Data protection grievance"
      description="Under India's DPDP Act you can raise a grievance about how we handle your personal data."
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
          saveLabel="File grievance"
          resetLabel="Clear"
        />
      </form>
    </Section>
  );
}

/** Permanent deletion, confirmed by typing the account's email. */
export function DeleteAccountSection() {
  const { data: session } = useSession();
  const { toast } = useToast();
  const user = session?.user;

  return (
    <Section
      title="Delete account"
      description="Permanently delete your account, bookings history and preferences. This cannot be undone."
      variant="card"
    >
      {user?.email && (
        <ConfirmDialog
          trigger={
            <Button variant="outline" className="text-destructive">
              <Trash2 className="mr-1.5 h-4 w-4" />
              Delete my account
            </Button>
          }
          title="Delete your account?"
          description="Everything on this account is deleted and cannot be recovered."
          requireTyped={user.email}
          confirmLabel="Delete my account"
          tone="destructive"
          onConfirm={async () => {
            const res = await fetch(`/api/user/${user.id}`, {
              method: "DELETE",
            });
            if (!res.ok) {
              const data = (await res.json().catch(() => ({}))) as {
                error?: string;
              };
              throw new Error(data.error || "We couldn't delete your account.");
            }
            toast({ title: "Account deleted" });
            // The account is gone, so home beats a sign-in page with a dead session.
            await signOutEverywhere("/");
          }}
        />
      )}
    </Section>
  );
}
