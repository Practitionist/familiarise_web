/**
 * Which preference switches can change anything for a viewer: a switch is
 * shown only when some producer sends that category to the viewer's role.
 * Derived from the template audiences in `lib/novu/templates/*` and the email
 * senders; see "Who receives which category" in
 * `docs/notifications/02-workflows-and-api.md`.
 */

import { z } from "zod";
import type { EmailCategoryColumn } from "@/lib/email/preferences";

const PERSONAL = [
  "appointmentReminders",
  "paymentNotifications",
  "subscriptionAlerts",
  "trialNotifications",
  "supportUpdates",
  "feedbackAlerts",
] as const satisfies readonly EmailCategoryColumn[];

const ORGANISATION = [
  "orgBillingAlerts",
  "orgMembershipAlerts",
  "orgProgramAlerts",
] as const satisfies readonly EmailCategoryColumn[];

const ViewerRoleSchema = z
  .enum(["CONSULTEE", "CONSULTANT", "ORG_WORKSPACE", "STAFF", "ADMIN"])
  .catch("CONSULTEE");

const ROLE_SWITCHES: Record<
  z.infer<typeof ViewerRoleSchema>,
  readonly EmailCategoryColumn[]
> = {
  CONSULTEE: PERSONAL,
  CONSULTANT: PERSONAL,
  // Operators file support cases and product feedback; they book nothing.
  ORG_WORKSPACE: ["supportUpdates", "feedbackAlerts", ...ORGANISATION],
  STAFF: [...PERSONAL, ...ORGANISATION],
  ADMIN: [...PERSONAL, ...ORGANISATION],
};

export interface PreferenceViewer {
  role?: string | null;
  consultantProfileId?: string | null;
  /** True when the viewer holds at least one active organisation membership. */
  hasOrgMembership: boolean;
}

/** The category switches this viewer can receive something under. */
export function receivableSwitches(
  viewer: PreferenceViewer,
): ReadonlySet<EmailCategoryColumn> {
  const switches = new Set(ROLE_SWITCHES[ViewerRoleSchema.parse(viewer.role)]);
  if (viewer.hasOrgMembership) {
    for (const key of ORGANISATION) switches.add(key);
  }
  return switches;
}

/** Quiet hours are read only by the consultant planning reminder (`lib/booking/week-nudge.ts`). */
export function showsQuietHours(viewer: PreferenceViewer): boolean {
  return viewer.role === "CONSULTANT" || !!viewer.consultantProfileId;
}
