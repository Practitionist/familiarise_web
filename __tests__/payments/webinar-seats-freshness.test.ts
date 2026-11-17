/** Seats left on the webinar checkout is re-read soon and whenever the tab regains focus. */
jest.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null }) }));

import { WEBINAR_SEATS_FRESHNESS } from "@/app/checkout/plans/adapters/use-webinar-checkout";

it("goes stale within 15 s and refetches on focus", () => {
  expect(WEBINAR_SEATS_FRESHNESS.staleTime).toBeLessThanOrEqual(15_000);
  expect(WEBINAR_SEATS_FRESHNESS.refetchOnWindowFocus).toBe(true);
});
