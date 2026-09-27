"use client";

import { VerificationQueue } from "@/components/admin/VerificationQueue";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { OrgVerificationQueue } from "@/components/dashboard/backoffice/organizations/OrgVerificationQueue";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { DocumentsPage } from "@/components/dashboard/shared/DocumentsPage";
import { UrlTabs } from "@/components/dashboard/UrlTabs";

/**
 * #1527 — Verification: experts, organizations (admin: org lifecycle is
 * `organizations.manage`) and the document review log, one URL tab each.
 */
export function VerificationPageClient() {
  const { can } = useBackofficeCapability();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Verification"
        description="Expert and organization submissions waiting for a decision, and every document reviewed."
      />
      <UrlTabs
        tabs={[
          {
            value: "consultants",
            label: "Experts",
            content: <VerificationQueue />,
          },
          {
            value: "organizations",
            label: "Organizations",
            show: can("organizations.manage"),
            content: <OrgVerificationQueue />,
          },
          {
            value: "documents",
            label: "Documents",
            content: <DocumentsPage />,
          },
        ]}
      />
    </div>
  );
}
