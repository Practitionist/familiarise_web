/**
 * Small grey and coloured text meets WCAG AA (4.5:1): the muted pills use
 * zinc-600, and the session timeline and the checkout's payment line use the
 * full muted foreground and the -700 fills.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  PAYMENT_STATUS_BADGE,
  RECORDING_STATUS_BADGE,
  REFERRAL_STATUS_BADGE,
} from "@/lib/labels/session-labels";

const source = (file: string) =>
  readFileSync(path.join(process.cwd(), file), "utf8");

describe("readable pills and timeline text", () => {
  it("draws EXPIRED and VOID pills in zinc-600", () => {
    for (const style of [
      RECORDING_STATUS_BADGE.EXPIRED,
      PAYMENT_STATUS_BADGE.EXPIRED,
      REFERRAL_STATUS_BADGE.EXPIRED,
      REFERRAL_STATUS_BADGE.VOID,
    ]) {
      expect(style.className).toContain("text-zinc-600");
      expect(style.className).not.toContain("text-zinc-500");
    }
  });

  it("keeps faded text and light fills out of the timeline and the checkout's payment line", () => {
    const timeline = source("components/appointments/SessionTimeline.tsx");
    expect(timeline).not.toMatch(/text-muted-foreground\/70/);
    expect(timeline).not.toMatch(/\btext-amber-500\b/);
    expect(timeline).not.toMatch(/\bbg-(green|amber)-600 text-white/);
    expect(
      source("app/checkout/plans/components/PlanCheckoutShell.tsx"),
    ).not.toMatch(/text-muted-foreground\/70/);
  });
});
