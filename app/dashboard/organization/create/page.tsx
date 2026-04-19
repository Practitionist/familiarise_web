"use client";

import { CreateOrganizationWizard } from "@/components/organization/create-wizard/Wizard";

/**
 * Nth-time org creation for an already-authenticated ORG_ADMIN. The
 * first-time flow runs inline at /form/onboarding when the user picks the
 * Organization Owner role tile; that caller passes `afterLaunch` to flip
 * `user.onboardingCompleted = true`. This page just wraps the shared
 * wizard with the dashboard's cancel path.
 */
export default function CreateOrganizationPage() {
  return <CreateOrganizationWizard cancelHref="/dashboard/organization" />;
}
