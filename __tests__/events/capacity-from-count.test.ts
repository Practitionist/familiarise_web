/**
 * @jest-environment node
 */

/**
 * `eventCapacityFromCount` is the capacity a public payload can show: the
 * server hands over a seat count and never the attendee list. It must agree
 * with the list-based capacity the checkout gates use.
 */

import {
  eventCapacityFromCount,
  getWebinarCapacity,
} from "@/lib/events/capacity";

describe("eventCapacityFromCount", () => {
  it("reads seats left and sold-out from the count", () => {
    expect(
      eventCapacityFromCount({
        instance: {},
        plan: { maxParticipants: 25 },
        taken: 24,
      }),
    ).toEqual({ max: 25, registered: 24, remaining: 1, isFull: false });
    expect(
      eventCapacityFromCount({
        instance: {},
        plan: { maxParticipants: 25 },
        taken: 25,
      }),
    ).toMatchObject({ remaining: 0, isFull: true });
  });

  it("lets the instance override the plan, and null inherits it", () => {
    const plan = { maxParticipants: 100 };
    expect(
      eventCapacityFromCount({
        instance: { maxParticipants: 10 },
        plan,
        taken: 10,
      }).isFull,
    ).toBe(true);
    expect(
      eventCapacityFromCount({
        instance: { maxParticipants: null },
        plan,
        taken: 10,
      }),
    ).toMatchObject({ max: 100, isFull: false });
  });

  it("never reports negative seats left when over capacity", () => {
    expect(
      eventCapacityFromCount({
        instance: null,
        plan: { maxParticipants: 5 },
        taken: 8,
      }),
    ).toMatchObject({ remaining: 0, isFull: true });
  });

  it("agrees with the roster-based capacity the checkout gates use", () => {
    const roster = [
      { userId: "a", status: "CONFIRMED" as const },
      { userId: "b", status: "HELD" as const },
      { userId: "host", status: "CONFIRMED" as const },
    ];
    const plan = { maxParticipants: 3 };
    const fromRoster = getWebinarCapacity({
      webinar: { appointment: { participants: roster } },
      plan,
      excludeUserIds: ["host"],
    });
    const fromCount = eventCapacityFromCount({
      instance: {},
      plan,
      taken: 2,
    });
    expect(fromCount).toEqual(fromRoster);
  });
});
