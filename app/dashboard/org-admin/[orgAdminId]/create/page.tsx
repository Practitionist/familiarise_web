"use client";

/**
 * Create-org wizard for an existing OrgAdmin operator. Renders the
 * same `<CreateOrganizationWizard />` as /dashboard/organization/create
 * but inside the operator dashboard sidebar chrome — so an OrgAdmin
 * starting their 2nd, 3rd, … org never gets bumped out of the chrome
 * they're already in.
 *
 * Cancel target is the operator overview (where they came from).
 * Success redirect is the same in both entry points (the wizard always
 * routes to /dashboard/organization/<newOrgId>/home).
 */

import { use } from "react";
import { CreateOrganizationWizard } from "@/components/organization/create-wizard/Wizard";

export default function OrgAdminCreatePage({
  params,
}: {
  params: Promise<{ orgAdminId: string }>;
}) {
  const { orgAdminId } = use(params);
  return (
    <CreateOrganizationWizard
      cancelHref={`/dashboard/org-admin/${orgAdminId}/home`}
    />
  );
}
