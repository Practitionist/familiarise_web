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
import { getSteps } from "./types";
import type { StepProps } from "./types";
import {
  deriveCapabilityKind,
  CAPABILITY_LABEL,
  CAPABILITY_BADGE_CLASS,
  FUNDING_SOURCE_LABEL,
  FUNDING_SOURCE_BADGE_CLASS,
  MEMBER_ROLE_LABEL,
  narrowFundingSource,
  narrowSelfServiceRole,
} from "@/lib/labels/org-labels";
import {
  CreateOrganizationPayloadSchema,
  CreateOrganizationResponseSchema,
  PatchOrganizationPayloadSchema,
  CreateInvitationPayloadSchema,
  CreateInvitationResponseSchema,
} from "@/schemas/organizations";
import {
  parseJsonResponse,
  validateOutboundPayload,
} from "@/lib/fetch-helpers";

interface InviteResult {
  email: string;
  ok: boolean;
  error?: string;
}

export function ReviewStep({
  onBack,
  onGoToStep,
  initialData,
  afterLaunch,
  finalRedirectPath,
}: StepProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [inviteResults, setInviteResults] = useState<InviteResult[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  // `initialData.orgId` only exists if the user previously hit Launch and
  // failed before afterLaunch completed — we reuse it for retry idempotency
  // (POST would 409 on slug otherwise).
  const existingOrgId = initialData.orgId;
  const emails = initialData.inviteEmails ?? [];
  const canSponsor = initialData.canSponsor ?? true;
  const canHost = initialData.canHost ?? false;
  const capability = deriveCapabilityKind(canSponsor, canHost);

  // Derive step indices from the same getSteps logic used in page.tsx
  const steps = getSteps({ canSponsor, canHost });
  const idx = (key: string) => steps.findIndex((s) => s.key === key);

  const handleLaunch = async () => {
    if (!initialData.name || !initialData.billingEmail) {
      setError("Missing organization name or billing email. Please go back to step 1.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      // Step 1 — create the organization. Deferred from step 0 of the
      // wizard so a user who drops out mid-flow doesn't leave an orphan
      // Organization row; the commitment happens here at launch.
      let orgId = existingOrgId ?? null;
      if (!orgId) {
        // Validate the outbound body before opening the network connection —
        // catches malformed wizard state (missing email, name too long, etc)
        // before the server returns a generic 400.
        const createPayload = validateOutboundPayload(
          CreateOrganizationPayloadSchema,
          {
            name: initialData.name,
            billingEmail: initialData.billingEmail,
            canSponsor,
            canHost,
            description: initialData.description || undefined,
            industry: initialData.industry || undefined,
            sizeBucket: initialData.sizeBucket || undefined,
            website: initialData.website || undefined,
            ...(canSponsor
              ? {
                  fundingSource: initialData.fundingSource ?? "PERSONAL",
                  paymentTermsDays: initialData.paymentTermsDays ?? 60,
                }
              : {}),
          },
        );
        const createRes = await fetch("/api/organizations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createPayload),
        });
        const created = await parseJsonResponse(
          createRes,
          CreateOrganizationResponseSchema,
          "Failed to create organization",
        );
        orgId = created.organization.id;
      }

      // Step 2 — PATCH settings that the create endpoint doesn't accept
      // (branding colors + bps rate card). Split cleanly by capability:
      // sponsor-only fields don't flow to host-only orgs and vice versa.
      const hasBranding =
        initialData.primaryColor != null ||
        initialData.secondaryColor != null;
      const hasRateCard =
        canHost &&
        (initialData.platformBps != null ||
          initialData.orgBps != null ||
          initialData.consultantBps != null);
      if (hasBranding || hasRateCard) {
        const patchPayload = validateOutboundPayload(
          PatchOrganizationPayloadSchema,
          {
            ...(hasBranding
              ? {
                  primaryColor: initialData.primaryColor ?? null,
                  secondaryColor: initialData.secondaryColor ?? null,
                }
              : {}),
            ...(hasRateCard
              ? {
                  platformBps: initialData.platformBps ?? 1000,
                  orgBps: initialData.orgBps ?? 1000,
                  consultantBps: initialData.consultantBps ?? 8000,
                }
              : {}),
          },
        );
        const patchRes = await fetch(`/api/organizations/${orgId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patchPayload),
        });
        // Server returns the updated org (or `{ ok: true }` for some
        // shapes); we don't rely on the body here, only on `res.ok`.
        if (!patchRes.ok) {
          const body = await patchRes.json().catch(() => ({}));
          throw new Error(
            (body && typeof body === "object" && "error" in body
              ? String((body as { error?: unknown }).error ?? "")
              : "") || "Failed to save organization settings.",
          );
        }
      }

      // Step 3 — send invitations in parallel. Individual failures surface
      // via the per-row InviteResult without blocking launch.
      if (emails.length > 0) {
        const inviteRoleNarrowed = narrowSelfServiceRole(
          initialData.inviteRole,
        );
        const results = await Promise.allSettled(
          emails.map(async (email) => {
            const invitePayload = validateOutboundPayload(
              CreateInvitationPayloadSchema,
              { email, role: inviteRoleNarrowed },
            );
            const res = await fetch(
              `/api/organizations/${orgId}/invitations`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(invitePayload),
              },
            );
            await parseJsonResponse(
              res,
              CreateInvitationResponseSchema,
              `Failed to invite ${email}`,
            );
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

      // Onboarding caller uses this to flip `user.onboardingCompleted`
      // atomically with the launch. Throwing here aborts the redirect so
      // the user can retry — org + invitations are already persisted and
      // the retry is idempotent.
      if (afterLaunch) {
        await afterLaunch(orgId);
      }

      const target = finalRedirectPath
        ? finalRedirectPath(orgId)
        : `/dashboard/organization/${orgId}/home`;
      router.push(target);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong",
      );
      setIsSubmitting(false);
    }
  };

  const Section = ({
    title,
    stepKey,
    children,
  }: {
    title: string;
    stepKey: string;
    children: React.ReactNode;
  }) => (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between py-3 px-4">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onGoToStep?.(idx(stepKey))}
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

  // Narrow through the Zod enums — same path the edit steps use — so
  // the review screen matches what the server will accept verbatim.
  const fundingSource = narrowFundingSource(initialData.fundingSource);
  const inviteRole = narrowSelfServiceRole(initialData.inviteRole);

  return (
    <div className="space-y-4">
      <Section title="Organization Info" stepKey="org-info">
        <p>
          <strong>Name:</strong> {initialData.name || "—"}
        </p>
        <p>
          <strong>Email:</strong> {initialData.billingEmail || "—"}
        </p>
        <div className="flex items-center gap-1">
          <strong>Capability:</strong>{" "}
          <Badge variant="secondary" className={CAPABILITY_BADGE_CLASS[capability]}>
            {CAPABILITY_LABEL[capability]}
          </Badge>
        </div>
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

      {canSponsor && (
        <Section title="Billing" stepKey="billing">
          <div className="flex items-center gap-2">
            <strong>Funding:</strong>{" "}
            <Badge
              variant="secondary"
              className={FUNDING_SOURCE_BADGE_CLASS[fundingSource]}
            >
              {FUNDING_SOURCE_LABEL[fundingSource]}
            </Badge>
          </div>
          {fundingSource === "INVOICE" && (
            <p>
              <strong>Payment terms:</strong> NET-
              {initialData.paymentTermsDays ?? 60}
            </p>
          )}
        </Section>
      )}

      {canHost && (
        <Section title="Revenue Rates" stepKey="revenue-rates">
          <p>
            <strong>Platform:</strong>{" "}
            {((initialData.platformBps ?? 1000) / 100).toFixed(2)}%
          </p>
          <p>
            <strong>Organization:</strong>{" "}
            {((initialData.orgBps ?? 1000) / 100).toFixed(2)}%
          </p>
          <p>
            <strong>Consultant:</strong>{" "}
            {((initialData.consultantBps ?? 8000) / 100).toFixed(2)}%
          </p>
          <p className="text-xs text-zinc-500 mt-2">
            Stored as basis points (integer math). Rate changes create a new
            effective rate card so historical earnings keep their original split.
          </p>
        </Section>
      )}

      <Section title="Branding" stepKey="branding">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-zinc-100 flex items-center justify-center">
            <Building2 className="w-5 h-5 text-zinc-400" />
          </div>
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
          {!initialData.primaryColor &&
            !initialData.secondaryColor && <span>Skipped</span>}
        </div>
      </Section>

      <Section title="Team Invitations" stepKey="invite-team">
        {emails.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {emails.map((e) => (
              <Badge key={e} variant="outline" className="text-xs">
                {e}
              </Badge>
            ))}
            <p className="text-xs text-zinc-500 mt-1">
              Role: {MEMBER_ROLE_LABEL[inviteRole]}
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
