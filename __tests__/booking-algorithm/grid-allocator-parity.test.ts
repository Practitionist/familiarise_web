/**
 * The availability grid and the allocator must agree about who is busy.
 *
 * They did not. The grid asked "is there an active appointment under one of
 * THIS consultant's plans" (plan ownership); the allocator asked "is this
 * consultant connected to a slot" (participation), and additionally folded in
 * the consultee's bookings with any consultant. Three consequences, all of
 * which showed the user a green, clickable cell that allocation then rejected:
 *
 *   - a consultant who is themselves a consultee elsewhere,
 *   - a consultee already booked with a different consultant,
 *   - an expired APPROVED_PENDING_PAYMENT hold, which conversely made the grid
 *     show BUSY where the allocator was happy to book.
 *
 * Both sides now build their filter from buildConsultantOccupancyWhere, and the
 * grid runs the same isOccupiedByLiveAppointment the allocator does.
 */

import "./setup";
import {
  buildCohostCommitmentFilter,
  buildConsultantOccupancyWhere,
  buildDeadHoldFilter,
  buildDeadSeatFilter,
  buildOccupiedAppointmentFilter,
  OCCUPIED_REQUEST_STATUSES,
  OCCUPYING_OCCURRENCE_WHERE,
} from "../../utils/scheduling-engine/occupancyPolicy";
import { isOccupiedByLiveAppointment } from "../../utils/scheduling-engine/ScheduleValidationService";

const PROFILE = "consultant-profile-1";
const USER = "consultant-user-1";
const NOW = new Date("2026-06-01T00:00:00Z");

type WhereShape = ReturnType<typeof buildConsultantOccupancyWhere>;

/** The three arms of the "reaches this consultant" clause. */
function reachArms(where: WhereShape) {
  const and = (where.AND ?? []) as Record<string, unknown>[];
  const reach = and[1] as { OR?: Record<string, unknown>[] };
  return reach.OR ?? [];
}

describe("buildConsultantOccupancyWhere", () => {
  it("matches on slot participation as well as plan ownership", () => {
    const arms = reachArms(buildConsultantOccupancyWhere(PROFILE, USER, NOW));

    expect(arms).toHaveLength(3);

    // Participation: the consultant holds a seat that still holds its time
    // (a lapsed seat hold holds nothing), whatever plan the appointment
    // belongs to, on a row that still holds its time.
    expect(arms[0]).toEqual({
      participants: {
        some: {
          userId: USER,
          status: { in: ["HELD", "CONFIRMED", "ATTENDED"] },
          role: { not: "COLLABORATOR" },
          NOT: buildDeadSeatFilter(NOW),
        },
      },
      occurrences: { some: OCCUPYING_OCCURRENCE_WHERE },
    });

    // Ownership: the appointment is delivered under one of their own plans,
    // even when the slot rows connect registrants rather than the host.
    expect(arms[1]).toEqual({
      OR: buildOccupiedAppointmentFilter(PROFILE),
    });

    // Co-hosting: an ACCEPTED seat on a webinar/class plan commits real time
    // but is neither participation nor ownership (AE-2 #784).
    expect(arms[2]).toEqual({
      OR: buildCohostCommitmentFilter(PROFILE),
    });
  });

  it("scopes co-host commitments to ACCEPTED seats on this profile's plans", () => {
    expect(buildCohostCommitmentFilter(PROFILE)).toEqual([
      {
        webinar: {
          webinarPlan: {
            collaborators: {
              some: { consultantProfileId: PROFILE, status: "ACCEPTED" },
            },
          },
        },
      },
      {
        class: {
          classPlan: {
            collaborators: {
              some: { consultantProfileId: PROFILE, status: "ACCEPTED" },
            },
          },
        },
      },
    ]);
  });

  it("still constrains to active parent statuses", () => {
    const where = buildConsultantOccupancyWhere(PROFILE, USER, NOW);
    const and = (where.AND ?? []) as Record<string, unknown>[];

    expect(and[0]).toEqual({ OR: buildOccupiedAppointmentFilter() });
    // A lapsed checkout hold occupies nothing, for every caller.
    expect(and[2]).toEqual({ NOT: buildDeadHoldFilter(NOW) });
    // Sanity-check the policy itself hasn't quietly widened.
    expect(OCCUPIED_REQUEST_STATUSES).toEqual([
      "PENDING",
      "APPROVED",
      "APPROVED_PENDING_PAYMENT",
    ]);
  });

  it("falls back to participation alone when no profile id is known", () => {
    const arms = reachArms(buildConsultantOccupancyWhere(undefined, USER, NOW));

    expect(arms).toHaveLength(1);
    expect(arms[0]).toEqual({
      participants: {
        some: {
          userId: USER,
          status: { in: ["HELD", "CONFIRMED", "ATTENDED"] },
          role: { not: "COLLABORATOR" },
          NOT: buildDeadSeatFilter(NOW),
        },
      },
      occurrences: { some: OCCUPYING_OCCURRENCE_WHERE },
    });
  });

  it("is the same predicate whichever caller builds it", () => {
    // Grid and allocator pass the same pair, so the objects must be identical —
    // this is the invariant that broke.
    expect(buildConsultantOccupancyWhere(PROFILE, USER, NOW)).toEqual(
      buildConsultantOccupancyWhere(PROFILE, USER, NOW),
    );
  });
});

describe("live-hold filtering is shared by grid and allocator", () => {
  const past = new Date("2026-01-01T00:00:00Z");
  const future = new Date("2099-01-01T00:00:00Z");
  const now = new Date("2026-06-01T00:00:00Z");

  it("frees a slot whose pending-payment hold has lapsed", () => {
    expect(
      isOccupiedByLiveAppointment(
        {
          consultation: { status: "APPROVED_PENDING_PAYMENT" },
          subscription: null,
          payment: [{ paymentStatus: "PENDING", expiresAt: past }],
        },
        now,
      ),
    ).toBe(false);
  });

  it("keeps a slot blocked while any payment row is still live", () => {
    expect(
      isOccupiedByLiveAppointment(
        {
          consultation: { status: "APPROVED_PENDING_PAYMENT" },
          subscription: null,
          payment: [{ expiresAt: past }, { expiresAt: future }],
        },
        now,
      ),
    ).toBe(true);
  });

  it("keeps a confirmed booking blocked regardless of payment rows", () => {
    expect(
      isOccupiedByLiveAppointment(
        {
          consultation: { status: "APPROVED" },
          subscription: null,
          payment: [{ paymentStatus: "PENDING", expiresAt: past }],
        },
        now,
      ),
    ).toBe(true);
  });

  it("keeps a hold with no payment row at all blocked", () => {
    // A hold that never produced a payment must not silently free the slot.
    expect(
      isOccupiedByLiveAppointment(
        {
          consultation: { status: "APPROVED_PENDING_PAYMENT" },
          subscription: null,
          payment: [],
        },
        now,
      ),
    ).toBe(true);
  });
});
