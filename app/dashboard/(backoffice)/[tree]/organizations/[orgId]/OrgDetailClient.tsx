"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { OrgLifecycleActions } from "@/components/dashboard/backoffice/organizations/OrgLifecycleActions";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import {
  DashboardContent,
  PageHeader,
} from "@/components/dashboard/PageScaffold";
import { KeyValueList, Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { InvoiceComposer } from "@/components/organization/billing/InvoiceComposer";
import { Button } from "@/components/ui/button";
import type { OrgDetail } from "@/lib/backoffice/org-detail";
import { orgStatus } from "@/lib/labels/backoffice-labels";
import { humanizeEnum } from "@/lib/ui/tone";

const day = (d: Date | string | null) =>
  d ? new Date(d).toLocaleDateString() : "Never";

/**
 * #1527 — the org detail page: lifecycle (Verify / Reject / Suspend /
 * Reactivate / Deactivate), the KYB and GST facts ops check before verifying,
 * billing with the wallet unfreeze door, and (Q8) the manual invoice composer
 * moved here from the org's own Billing page.
 */
export function OrgDetailClient({ org }: Readonly<{ org: OrgDetail }>) {
  const { basePath } = useBackofficeCapability();
  const router = useRouter();
  const [composerOpen, setComposerOpen] = useState(false);
  const tax = org.taxInfo;

  return (
    <>
      <PageHeader
        title={org.name}
        description={`/${org.slug}`}
        back={{ href: `${basePath}/organizations`, label: "Organizations" }}
        meta={<StatusBadge {...orgStatus(org.status)} />}
        actions={<OrgLifecycleActions org={org} size="default" />}
      />
      <DashboardContent>
        <Section title="Verification" variant="card">
          <KeyValueList
            items={[
              { label: "Submitted", value: day(org.verificationSubmittedAt) },
              {
                label: "Last rejected",
                value: org.verificationRejectedAt
                  ? `${day(org.verificationRejectedAt)}: ${org.verificationReason ?? "no reason recorded"}`
                  : "Never",
              },
              {
                label: "KYB",
                value: org.kybVerification?.kybVerifiedAt
                  ? `Verified ${day(org.kybVerification.kybVerifiedAt)}`
                  : "Not verified",
              },
              { label: "Legal name", value: tax?.legalName ?? "Not given" },
              {
                label: "GSTIN",
                value: tax?.gstin
                  ? `${tax.gstin} (${humanizeEnum(tax.gstRegStatus)}, state ${tax.gstStateCode ?? "unknown"})`
                  : "Not given",
              },
              {
                label: "PAN",
                value: tax?.panLast4 ? `Ending ${tax.panLast4}` : "Not given",
              },
            ]}
          />
        </Section>

        <Section title="Organization" variant="card">
          <KeyValueList
            items={[
              {
                label: "Can",
                value:
                  [org.canSponsor && "Sponsor", org.canHost && "Host"]
                    .filter(Boolean)
                    .join(" and ") || "Neither yet",
              },
              { label: "Members", value: `${org._count.memberships}` },
              { label: "Contracts", value: `${org._count.contracts}` },
              { label: "Created", value: day(org.createdAt) },
            ]}
          />
        </Section>

        <Section
          title="Billing"
          variant="card"
          actions={
            org.billingAccount ? (
              <Button variant="outline" onClick={() => setComposerOpen(true)}>
                Create invoice
              </Button>
            ) : undefined
          }
        >
          <KeyValueList
            items={[
              {
                label: "Funding",
                value: org.billingAccount
                  ? humanizeEnum(org.billingAccount.fundingSource)
                  : "No billing account yet",
              },
              { label: "Billing email", value: org.billingEmail ?? "Not set" },
              {
                label: "Terms",
                value: `Net ${org.paymentTermsDays}${org.requiresPO ? ", purchase order required" : ""}`,
              },
              {
                label: "Wallet spend",
                value: org.walletFrozen ? (
                  <StatusBadge label="Frozen" tone="critical" />
                ) : (
                  "Open"
                ),
              },
            ]}
          />
          {org.billingAccount && org.walletFrozen && (
            <div className="mt-4">
              <ConfirmDialog
                trigger={<Button variant="outline">Unfreeze wallet</Button>}
                title="Lift the wallet-spend freeze?"
                description="Do this only once the ledger drift that froze it is reconciled."
                confirmLabel="Unfreeze"
                requireReason={{ label: "What was reconciled" }}
                onConfirm={async ({ reason }) => {
                  const res = await fetch(
                    `/api/admin/billing-accounts/${org.billingAccount?.id}/unfreeze`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ reason }),
                    },
                  );
                  const json = (await res.json().catch(() => ({}))) as {
                    error?: string;
                  };
                  if (!res.ok) {
                    throw new Error(
                      json.error ?? "The wallet was not unfrozen.",
                    );
                  }
                  router.refresh();
                }}
              />
            </div>
          )}
        </Section>
      </DashboardContent>
      {org.billingAccount && (
        <InvoiceComposer
          orgId={org.id}
          open={composerOpen}
          onOpenChange={setComposerOpen}
        />
      )}
    </>
  );
}
