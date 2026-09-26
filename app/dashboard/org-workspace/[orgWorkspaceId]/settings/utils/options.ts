/**
 * Constant option lists for the settings form.
 *
 * Kept here so the dialog/section components stay declarative and the
 * label copy lives in one place.
 */

import type { NotificationRoutingMode } from "./types";

export const NOTIFICATION_ROUTING_OPTIONS: ReadonlyArray<{
  value: NotificationRoutingMode;
  label: string;
  description: string;
}> = [
  {
    value: "BELL_AND_EMAIL",
    label: "Bell + email digest",
    description:
      "See lifecycle events on the in-app bell AND get the daily email digest.",
  },
  {
    value: "BELL_ONLY",
    label: "Bell only",
    description: "In-app only. No emails for org lifecycle events.",
  },
  {
    value: "EMAIL_ONLY",
    label: "Email only",
    description: "Daily digest only. The bell stream stays empty.",
  },
  {
    value: "NEITHER",
    label: "Neither",
    description:
      "You won’t be paged on lifecycle events. Use sparingly — you may miss invoice or payout updates.",
  },
];
