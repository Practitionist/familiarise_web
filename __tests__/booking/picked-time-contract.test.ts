/**
 * A buyer's picked time, as the picker builds it from the grid, parses at each
 * door: the consultation checkout URL and the request body name the weekly or
 * custom availability row, and the trial body carries the slot.
 */

import {
  buyerTimeOptions,
  singleTimeLeadMs,
} from "@/lib/scheduling/single-session-options";
import {
  consultationCheckoutHref,
  requestForApprovalBody,
  trialCreateBody,
} from "@/lib/booking/picked-time";
import { consultationSearchParamsSchema } from "@/schemas/checkout";
import { RequestForApprovalSchema } from "@/schemas/slots";
import { CreateTrialSchema } from "@/schemas/trials";

const HOUR = 3_600_000;
const DAY = Date.parse("2030-03-12T00:00:00.000Z");

// The doors read the real clock; the pick is two days ahead of it.
beforeEach(() => jest.useFakeTimers({ now: DAY - 48 * HOUR }));
afterEach(() => jest.useRealTimers());

function pickFrom(type: "WEEKLY" | "CUSTOM") {
  const atoms = [10, 10.5].map((h) => ({
    startsAt: new Date(DAY + h * HOUR).toISOString(),
    endsAt: new Date(DAY + (h + 0.5) * HOUR).toISOString(),
    bookingStatus: "available" as const,
    availabilityWindowId: `row-${type}`,
    type,
  }));
  const [option] = buyerTimeOptions({
    atoms,
    dayStartMs: DAY,
    dayEndMs: DAY + 24 * HOUR,
    sessionMinutes: 60,
    zone: "UTC",
    nowMs: DAY - 48 * HOUR,
    leadMs: singleTimeLeadMs("book"),
  });
  return {
    startsAt: new Date(option.startMs).toISOString(),
    endsAt: new Date(option.endMs).toISOString(),
    window: option.window,
  };
}

it.each(["WEEKLY", "CUSTOM"] as const)(
  "a %s pick parses at checkout, at the request door and at the trial door",
  (type) => {
    const pick = pickFrom(type);
    const href = consultationCheckoutHref("plan-1", pick);
    const query = Object.fromEntries(new URL(href, "https://x").searchParams);
    const checkout = consultationSearchParamsSchema.safeParse(query);
    expect(checkout.success).toBe(true);
    const idField =
      type === "WEEKLY"
        ? "availabilityWindowWeeklyId"
        : "availabilityWindowCustomId";
    expect(query[idField]).toBe(`row-${type}`);

    const request = RequestForApprovalSchema.safeParse(
      requestForApprovalBody({
        consultantProfileId: "cp-1",
        consultationPlanId: "plan-1",
        pick,
      }),
    );
    expect(request.success && request.data[idField]).toBe(`row-${type}`);

    const trial = CreateTrialSchema.safeParse(
      trialCreateBody({
        consulteeProfileId: "ce-1",
        consultantProfileId: "cp-1",
        subscriptionPlanId: "sp-1",
        pick,
      }),
    );
    expect(trial.success).toBe(true);
  },
);
