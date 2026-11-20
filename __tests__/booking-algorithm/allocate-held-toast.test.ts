/**
 * @jest-environment node
 *
 * "Save picked times" on an unpaid request holds the times: the toast follows
 * the allocate route's `awaitingPayment` and `payExpiresAt`, read through the
 * real client service, and never says "confirmed" before the learner pays.
 */

import "./setup";

import { AllocationAlgorithms } from "@/lib/scheduling/allocationAlgorithms";
import { timingsSaved } from "@/lib/scheduling/allocationMessages";
import { makeConsecutiveTimeSlots } from "../fixtures/booking.mockData";

// Before the fixtures' deadline and slots, so the allocator never refuses them as past.
beforeEach(() => {
  jest.useFakeTimers({
    now: new Date("2030-06-10T00:00:00Z"),
    advanceTimers: true,
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function respondWith(body: Record<string, unknown>) {
  jest.spyOn(global, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

async function saveTwoSlots() {
  const result = await AllocationAlgorithms.manualAllocate(
    makeConsecutiveTimeSlots("2030-06-12T04:30:00Z", 2),
    {
      eventType: "consultation",
      eventId: "cm1a2b3c4d5e6f7g8h9i0j1k2",
      durationInHours: 1,
    },
  );
  expect(result.success).toBe(true);
  return result;
}

const ZONE = { zone: "Asia/Kolkata" };

it("names the pay link's end when the route minted one", async () => {
  respondWith({
    data: [],
    awaitingPayment: true,
    payExpiresAt: "2030-06-11T04:30:00.000Z",
  });
  const toast = timingsSaved(await saveTwoSlots(), ZONE);
  expect(toast.title).toBe("Times held");
  expect(toast.description).toBe(
    "The learner has until Tue, 11 Jun, 10:00 am to pay. The sessions are confirmed once they do.",
  );
});

it("says the learner must pay when no new link carries a deadline", async () => {
  respondWith({ data: [], awaitingPayment: true, payExpiresAt: null });
  const toast = timingsSaved(await saveTwoSlots(), ZONE);
  expect(toast.title).toBe("Times held");
  expect(toast.description).toBe(
    "The learner has to pay before the sessions are confirmed.",
  );
});

it("keeps 'confirmed' for a free or already-paid result", async () => {
  respondWith({ data: [], awaitingPayment: false, payExpiresAt: null });
  expect(timingsSaved(await saveTwoSlots(), ZONE)).toMatchObject({
    title: "Sessions scheduled",
    description: "The times you picked are confirmed.",
  });
});
