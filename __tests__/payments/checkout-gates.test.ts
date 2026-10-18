/**
 * @jest-environment node
 */

// Checkout's availability, org and metering gates, driven through handleCheckout and validateSlotAvailability.

import "../booking-algorithm/setup";
import {
  buildCheckoutInput,
  buyerRow,
  mintOrder,
  mockCreatePaymentIntent as createPaymentIntent,
  silenceConsole,
} from "../booking/repro/checkout-harness/mocks/setup";

const mockRecordBookingUtilization = jest.fn();
jest.mock("../../lib/api/organizations/program-helpers", () => ({
  __esModule: true,
  ProgramAssignmentLimitError: class extends Error {},
  recordBookingUtilization: (...a: unknown[]) =>
    mockRecordBookingUtilization(...a),
  reverseBookingUtilization: jest.fn(),
}));
jest.mock("../../lib/payments/operations/cancellation-policy-store", () => ({
  __esModule: true,
  ensurePlatformCancellationPolicy: jest.fn(async () => undefined),
  resolveCheckoutCancellationPolicyId: jest.fn(async () => "policy-1"),
}));

import {
  handleCheckout,
  validateSlotAvailability,
} from "../../lib/payments/operations/checkout";
import { db, resetDouble } from "../booking/repro/checkout-harness/setup";
import { SlotTakenError } from "../../lib/booking/booking-rule-error";
import { buildOccupiedAppointmentFilter } from "../../utils/scheduling-engine/occupancyPolicy";
import type { Tx } from "../../lib/prisma";

const HOUR = 3600_000;
const START = new Date(Math.ceil((Date.now() + 7 * 24 * HOUR) / HOUR) * HOUR);
const at = (hours: number) => new Date(START.getTime() + hours * HOUR);

const profile = {
  id: "cons-profile",
  userId: "cons-user",
  deletedAt: null,
  verificationStatus: "VERIFIED",
  acceptingRequests: true,
  user: { id: "cons-user", timezone: "Asia/Kolkata" },
};
const publishedPlan = {
  id: "plan-1",
  price: 100_000,
  priceCurrency: "INR",
  durationInHours: 1,
  maxParticipants: 50,
  refundWindowHours: 24,
  totalSessions: 2,
  lateJoinUntilSession: null,
  archivedAt: null,
  visibility: "PUBLIC",
  status: "PUBLISHED",
  organizationId: null,
  consultantProfileId: "cons-profile",
  consultantProfile: profile,
};
const session = (id: string, hours: number) => ({
  id,
  ordinal: Number(id.slice(-1)),
  startsAt: at(hours),
  endsAt: at(hours + 1),
  deletedAt: null,
  completionStatus: "SCHEDULED",
});
const webinar = {
  id: "web-1",
  status: "SCHEDULED",
  webinarPlan: publishedPlan,
  appointment: {
    id: "appt-webinar",
    occurrences: [session("occ-1", 0)],
    participants: [],
  },
};
const classSessions = [session("s-1", 0), session("s-2", 24)];
const classInstance = {
  id: "class-1",
  status: "SCHEDULED",
  classPlan: publishedPlan,
  appointment: {
    id: "appt-class",
    occurrences: classSessions,
    participants: [],
  },
};

/** A PERSONAL-rail org member whose programme assignment meters the booking. */
const orgMember = (membershipStatus = "ACTIVE") => ({
  "organization.findUnique": () => ({
    id: "org-1",
    status: "ACTIVE",
    canSponsor: true,
    billingAccount: {
      id: "ba-1",
      fundingSource: "PERSONAL",
      creditLimit: null,
      walletBalance: 0,
    },
  }),
  "billingAccount.findFirst": () => ({
    id: "ba-1",
    fundingSource: "PERSONAL",
    creditLimit: null,
  }),
  "membership.findUnique": () => ({
    id: "m-1",
    role: "MEMBER",
    status: membershipStatus,
  }),
  "programAssignment.findFirst": () => ({ id: "pa-1", programId: "prog-1" }),
});

const eventPlanLookup = () => ({
  consultantProfileId: "cons-profile",
  organizationId: null,
  collaborators: [],
});

beforeEach(() => {
  mintOrder("order_1");
  mockRecordBookingUtilization.mockReset();
  mockRecordBookingUtilization.mockResolvedValue({
    wasOverage: false,
    engagementsConsumedDelta: 1,
    engagementsUsedAfter: 1,
    cap: null,
    programType: "LICENSED_SEAT",
    consumedPaiseAfter: 0,
    creditBudgetPaise: null,
  });
  resetDouble({
    "user.findUnique": () => buyerRow(),
    "consultationPlan.findUnique": () => publishedPlan,
    "webinar.findUnique": () => webinar,
    "webinarPlan.findUnique": eventPlanLookup,
    "class.findUnique": () => classInstance,
    "classPlan.findUnique": eventPlanLookup,
    "appointmentOccurrence.findMany": () => classSessions,
  });
  silenceConsole();
});
afterEach(() => jest.restoreAllMocks());

const refusal = (input: Parameters<typeof handleCheckout>[0]) =>
  handleCheckout(input, "buyer").then(
    () => null,
    (caught: unknown) => caught,
  );

describe("published availability is a union of rows, not the named row", () => {
  const coverage = (rows: Array<[number, number]>) =>
    resetDouble({
      "availabilityWindowCustom.findUnique": () => ({
        consultantProfile: profile,
      }),
      "consultantProfile.findUnique": () => ({
        scheduleType: "CUSTOM",
        deletedAt: null,
      }),
      "availabilityWindowCustom.findMany": () =>
        rows.map(([from, to]) => ({ startsAt: at(from), endsAt: at(to) })),
    });
  const twoHours = buildCheckoutInput({
    appointmentType: "CONSULTATION",
    availabilityWindowCustomId: "row-1",
    startsAt: at(0).toISOString(),
    endsAt: at(2).toISOString(),
  });

  it("accepts a window spanning two adjacent rows", async () => {
    coverage([
      [0, 1],
      [1, 2],
    ]);
    await expect(
      validateSlotAvailability(db as Tx, twoHours, "buyer", "cons-user"),
    ).resolves.toEqual({ selfHoldAppointmentIds: [] });
  });

  it("refuses a window with an uncovered half-hour between the rows", async () => {
    coverage([
      [0, 1],
      [1.5, 2],
    ]);
    await expect(
      validateSlotAvailability(db as Tx, twoHours, "buyer", "cons-user"),
    ).rejects.toThrow("does not fall within the specified availability window");
  });
});

describe("the pre-booking conflict check sees live tentative holds", () => {
  const oneHour = buildCheckoutInput({
    appointmentType: "CONSULTATION",
    startsAt: at(0).toISOString(),
    endsAt: at(1).toISOString(),
  });

  it("filters by occupancy status alone, never by confirmed rows only", async () => {
    const wheres: unknown[] = [];
    resetDouble({
      "appointmentOccurrence.findFirst": (args) => {
        wheres.push((args as { where: unknown }).where);
        return null;
      },
    });
    await validateSlotAvailability(db as Tx, oneHour, undefined, "cons-user");

    const where = wheres[0] as { AND: unknown[] };
    expect(JSON.stringify(where)).not.toContain('"isTentative"');
    expect(where.AND).toContainEqual({
      appointment: {
        AND: [{ OR: buildOccupiedAppointmentFilter() }, expect.anything()],
      },
    });
  });

  it("refuses the slot while another buyer's hold occupies it", async () => {
    resetDouble({
      "appointmentOccurrence.findFirst": () => ({
        id: "held",
        isTentative: true,
      }),
    });
    await expect(
      validateSlotAvailability(db as Tx, oneHour, undefined, "cons-user"),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });
});

it("a DRAFT plan is refused for a new sale with PLAN_NOT_PUBLISHED", async () => {
  resetDouble({
    "user.findUnique": () => buyerRow(),
    "consultationPlan.findUnique": () => ({
      ...publishedPlan,
      status: "DRAFT",
    }),
  });
  const error = await refusal(
    buildCheckoutInput({
      appointmentType: "CONSULTATION",
      startsAt: at(0).toISOString(),
      endsAt: at(1).toISOString(),
    }),
  );
  expect(error).toMatchObject({ httpStatus: 409, code: "PLAN_NOT_PUBLISHED" });
  expect(createPaymentIntent).not.toHaveBeenCalled();
});

it("org-funded checkout refuses a non-ACTIVE membership with a typed 403", async () => {
  resetDouble({
    "user.findUnique": () => buyerRow(),
    "webinar.findUnique": () => webinar,
    ...orgMember("SUSPENDED"),
  });
  const error = await refusal(
    buildCheckoutInput({
      appointmentType: "WEBINAR",
      eventId: "web-1",
      organizationId: "org-1",
    }),
  );
  expect(error).toMatchObject({
    httpStatus: 403,
    code: "ORG_MEMBERSHIP_REQUIRED",
  });
  expect(createPaymentIntent).not.toHaveBeenCalled();
});

describe("checkout names the appointments it meters", () => {
  const metered = () => mockRecordBookingUtilization.mock.calls[0]?.[1];

  it("a webinar seat meters the one appointment it joined", async () => {
    resetDouble({
      "user.findUnique": () => buyerRow(),
      "webinar.findUnique": () => webinar,
      "webinarPlan.findUnique": eventPlanLookup,
      ...orgMember(),
    });
    await handleCheckout(
      buildCheckoutInput({
        appointmentType: "WEBINAR",
        eventId: "web-1",
        organizationId: "org-1",
      }),
      "buyer",
    );
    expect(metered()).toMatchObject({
      programAssignmentId: "pa-1",
      engagementsConsumed: 1,
      appointmentIds: ["appt-webinar"],
    });
  });

  it("a class seat meters every class session, not the wrapper", async () => {
    resetDouble({
      "user.findUnique": () => buyerRow(),
      "class.findUnique": () => classInstance,
      "classPlan.findUnique": eventPlanLookup,
      "appointmentOccurrence.findMany": () => classSessions,
      ...orgMember(),
    });
    await handleCheckout(
      buildCheckoutInput({
        appointmentType: "CLASS",
        eventId: "class-1",
        organizationId: "org-1",
      }),
      "buyer",
    );
    expect(metered()).toMatchObject({
      programAssignmentId: "pa-1",
      engagementsConsumed: 2,
      appointmentIds: ["s-1", "s-2"],
    });
  });
});
