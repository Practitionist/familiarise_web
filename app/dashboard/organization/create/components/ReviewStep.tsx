"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Building2, Pencil, Check, X, Loader2 } from "lucide-react";
import type { StepProps } from "../types";

interface InviteResult {
  email: string;
  ok: boolean;
  error?: string;
}

export function ReviewStep({ onBack, onGoToStep, initialData }: StepProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [inviteResults, setInviteResults] = useState<InviteResult[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const orgId = initialData.orgId;
  const emails = initialData.inviteEmails ?? [];

  const handleLaunch = async () => {
    if (!orgId) {
      setError("Organization was not created. Please go back to step 1.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      // Final PATCH to ensure all data is persisted. Fail closed on error.
      const patchRes = await fetch(`/api/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billingEmail: initialData.billingEmail,
          billingMode: initialData.billingMode,
          description: initialData.description || null,
          industry: initialData.industry || null,
          sizeBucket: initialData.sizeBucket || null,
          website: initialData.website || null,
          paymentTermsDays: initialData.paymentTermsDays ?? 30,
          seatsTotal: initialData.seatsTotal ?? null,
          primaryColor: initialData.primaryColor ?? null,
          secondaryColor: initialData.secondaryColor ?? null,
        }),
      });
      if (!patchRes.ok) {
        const body = await patchRes.json().catch(() => ({}));
        throw new Error(body.error || "Failed to save organization settings.");
      }

      // Send invitations in parallel
      if (emails.length > 0) {
        const results = await Promise.allSettled(
          emails.map(async (email) => {
            const res = await fetch(
              `/api/organizations/${orgId}/invitations`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  email,
                  role: initialData.inviteRole ?? "ORG_LEARNER",
                }),
              },
            );
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error(body.error || `Failed to invite ${email}`);
            }
            return email;
          }),
        );

        const mapped: InviteResult[] = results.map((r, i) => ({
          email: emails[i],
          ok: r.status === "fulfilled",
          error: r.status === "rejected" ? r.reason?.message : undefined,
        }));
        setInviteResults(mapped);

        // Wait briefly to show results before navigating
        await new Promise((r) => setTimeout(r, 1500));
      }

      router.push(`/dashboard/organization/${orgId}/home`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong",
      );
      setIsSubmitting(false);
    }
  };

  const Section = ({
    title,
    step,
    children,
  }: {
    title: string;
    step: number;
    children: React.ReactNode;
  }) => (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between py-3 px-4">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onGoToStep?.(step)}
          disabled={isSubmitting}
        >
          <Pencil className="h-3 w-3 mr-1" /> Edit
        </Button>
      </CardHeader>
      <CardContent className="px-4 pb-4 text-sm text-zinc-600 space-y-1">
        {children}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-4">
      <Section title="Organization Info" step={0}>
        <p>
          <strong>Name:</strong> {initialData.name || "—"}
        </p>
        <p>
          <strong>Email:</strong> {initialData.billingEmail || "—"}
        </p>
        {initialData.description && (
          <p>
            <strong>Description:</strong> {initialData.description}
          </p>
        )}
        {initialData.industry && (
          <p>
            <strong>Industry:</strong> {initialData.industry}
          </p>
        )}
        {initialData.sizeBucket && (
          <p>
            <strong>Size:</strong>{" "}
            {initialData.sizeBucket.replace(/_/g, " ").toLowerCase()}
          </p>
        )}
        {initialData.website && (
          <p>
            <strong>Website:</strong> {initialData.website}
          </p>
        )}
      </Section>

      <Section title="Billing & Seats" step={1}>
        <div className="flex items-center gap-2">
          <strong>Mode:</strong>{" "}
          <Badge variant="secondary">
            {initialData.billingMode ?? "TAG_ONLY"}
          </Badge>
        </div>
        {initialData.billingMode === "INVOICED_MONTHLY" && (
          <p>
            <strong>Payment terms:</strong> NET-
            {initialData.paymentTermsDays ?? 30}
          </p>
        )}
        <p>
          <strong>Seat budget:</strong>{" "}
          {initialData.seatsTotal ?? "Unlimited"}
        </p>
      </Section>

      <Section title="Branding" step={2}>
        <div className="flex items-center gap-3">
          {initialData.logo ? (
            <img
              src={initialData.logo}
              alt="Logo"
              className="w-10 h-10 rounded-lg object-cover"
            />
          ) : (
            <div className="w-10 h-10 rounded-lg bg-zinc-100 flex items-center justify-center">
              <Building2 className="w-5 h-5 text-zinc-400" />
            </div>
          )}
          {initialData.primaryColor && (
            <div className="flex items-center gap-1">
              <div
                className="w-5 h-5 rounded border border-zinc-200"
                style={{ backgroundColor: initialData.primaryColor }}
              />
              <span className="font-mono text-xs">
                {initialData.primaryColor}
              </span>
            </div>
          )}
          {initialData.secondaryColor && (
            <div className="flex items-center gap-1">
              <div
                className="w-5 h-5 rounded border border-zinc-200"
                style={{ backgroundColor: initialData.secondaryColor }}
              />
              <span className="font-mono text-xs">
                {initialData.secondaryColor}
              </span>
            </div>
          )}
          {!initialData.logo &&
            !initialData.primaryColor &&
            !initialData.secondaryColor && <span>Skipped</span>}
        </div>
      </Section>

      <Section title="Team Invitations" step={3}>
        {emails.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {emails.map((e) => (
              <Badge key={e} variant="outline" className="text-xs">
                {e}
              </Badge>
            ))}
            <p className="text-xs text-zinc-500 mt-1">
              Role: {(initialData.inviteRole ?? "ORG_LEARNER").replace("ORG_", "")}
            </p>
          </div>
        ) : (
          <span>No invitations — you can invite members later</span>
        )}
      </Section>

      {inviteResults && (
        <Card>
          <CardContent className="py-3 px-4 space-y-1">
            {inviteResults.map((r) => (
              <div
                key={r.email}
                className="flex items-center gap-2 text-sm"
              >
                {r.ok ? (
                  <Check className="h-4 w-4 text-emerald-500" />
                ) : (
                  <X className="h-4 w-4 text-red-500" />
                )}
                <span>{r.email}</span>
                {r.error && (
                  <span className="text-xs text-red-500">{r.error}</span>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex justify-between pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onBack}
          disabled={isSubmitting}
        >
          Back
        </Button>
        <Button
          type="button"
          onClick={handleLaunch}
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Launching…
            </>
          ) : (
            "Launch Organization"
          )}
        </Button>
      </div>
    </div>
  );
}
