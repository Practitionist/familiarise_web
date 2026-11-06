/**
 * Constant option lists for the settings form.
 *
 * Kept here so the dialog/section components stay declarative and the
 * label copy lives in one place.
 */

import type { NotificationRoutingMode } from "./types";

/** The mode gates every bell and every optional email; `routingBlocks` in `lib/notifications/receivable.ts` says which. */
export const NOTIFICATION_ROUTING_OPTIONS: ReadonlyArray<{
  value: NotificationRoutingMode;
  label: string;
  description: string;
}> = [
  {
    value: "BELL_AND_EMAIL",
    label: "Bell and email",
    description:
      "Notifications appear in the bell and optional emails are sent, as your personal settings below allow.",
  },
  {
    value: "BELL_ONLY",
    label: "Bell only",
    description: "Notifications appear in the bell. No optional emails.",
  },
  {
    value: "EMAIL_ONLY",
    label: "Email only",
    description: "Optional emails are sent. The bell stays empty.",
  },
  {
    value: "NEITHER",
    label: "Neither",
    description:
      "No bell and no optional emails. You may miss invoice or payout updates.",
  },
];

export function routingLabel(mode: NotificationRoutingMode): string {
  return (
    NOTIFICATION_ROUTING_OPTIONS.find((opt) => opt.value === mode)?.label ??
    mode
  );
}
