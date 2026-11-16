/** @jest-environment node */
/** Home asks a removed learner for their side while support reviews the removal. */
import { deriveConsulteeActionItems } from "@/lib/dashboard/action-items";

it("lists an open conduct removal case under Needs you, linking the case", () => {
  const items = deriveConsulteeActionItems({
    pendingPaymentCount: 0,
    upcomingSessions: [],
    basePath: "/dashboard/consultee/ce-1",
    removalReviews: [{ caseId: "case-1", title: "Beginner Class" }],
    now: new Date("2026-11-16T12:00:00Z"),
  });
  expect(items).toEqual([
    expect.objectContaining({
      key: "removal-review:case-1",
      ctaHref: "/dashboard/consultee/ce-1/support/requests/c_case-1",
    }),
  ]);
});
