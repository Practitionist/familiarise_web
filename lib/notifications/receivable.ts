/**
 * Which preference switches can change anything for a viewer: a switch is
 * shown only when some producer sends that category to the viewer's role.
 * Derived from the template audiences in `lib/novu/templates/*` and the email
 * senders; see "Who receives which category" in
 * `docs/notifications/02-workflows-and-api.md`. Also which required notices
 * reach the viewer whatever the switches say.
 */

import { z } from "zod";
import type { EmailCategoryColumn } from "@/lib/email/preferences";
import {
  REQUIRED_NOTICE_AUDIENCE,
  REQUIRED_NOTICE_KINDS,
  REQUIRED_NOTICE_LABEL,
  REQUIRED_WORKFLOW_NOTICES,
  type NoticeAudience,
} from "@/lib/notifications/required-notices";

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

function isExpert(viewer: PreferenceViewer): boolean {
  return viewer.role === "CONSULTANT" || !!viewer.consultantProfileId;
}

/** Quiet hours are read only by the consultant planning reminder (`lib/booking/week-nudge.ts`). */
export function showsQuietHours(viewer: PreferenceViewer): boolean {
  return isExpert(viewer);
}

function reaches(audience: NoticeAudience, viewer: PreferenceViewer): boolean {
  const role = ViewerRoleSchema.parse(viewer.role);
  switch (audience) {
    case "everyone":
      return true;
    case "booker":
      return role !== "ORG_WORKSPACE";
    case "expert":
      return isExpert(viewer);
    case "reviewer":
      return role === "STAFF" || role === "ADMIN";
    case "admin":
      return role === "ADMIN";
  }
}

function joinWithAnd(items: readonly string[]): string {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The Settings list of what reaches this viewer whatever their switches say. */
export function alwaysSentNotices(viewer: PreferenceViewer): string[] {
  const system = [
    ...new Set(
      Object.values(REQUIRED_WORKFLOW_NOTICES)
        .filter((notice) => reaches(notice.audience, viewer))
        .map((notice) => notice.label),
    ),
  ];
  const first = joinWithAnd(system);
  const items = [
    first.charAt(0).toUpperCase() + first.slice(1),
    "Payment receipts and invitations you must answer, by email",
  ];
  const kinds = REQUIRED_NOTICE_KINDS.filter((kind) =>
    reaches(REQUIRED_NOTICE_AUDIENCE[kind], viewer),
  );
  if (kinds.length > 0) {
    const subject = kinds.some(
      (kind) => REQUIRED_NOTICE_AUDIENCE[kind] === "expert",
    )
      ? "your booking or your co-hosting"
      : "your booking";
    const labels = [
      ...new Set(kinds.map((kind) => REQUIRED_NOTICE_LABEL[kind])),
    ];
    items.push(
      `Changes someone else makes to ${subject}: ${labels.join("; ")}`,
    );
  }
  return items;
}
