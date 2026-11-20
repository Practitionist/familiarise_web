/**
 * @jest-environment node
 */

// Checkout's availability, org and metering gates, driven through handleCheckout and validateSlotAvailability.

import "../booking-algorithm/setup";
import {
  buildCheckoutInput,
  buyerRow,
  eventPlanLookup,
  mintOrder,
  mockCreatePaymentIntent as createPaymentIntent,
  orgMember,
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
const mockReportSentryError = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  ...jest.requireActual("../../lib/observability/report"),
  reportSentryError: (...a: unknown[]) => mockReportSentryError(...a),
}));
jest.mock("../../lib/payments/operations/cancellation-policy-store", () => ({
  __esModule: true,
  ensurePlatformCancellationPolicy: jest.fn(async () => undefined),
  resolveCheckoutCancellationPolicyId: jest.fn(async () => "policy-1"),
}));

import { handleCheckout } from "../../lib/payments/checkout";
import { validateSlotAvailability } from "../../lib/payments/checkout/occupancy-validate";
import { db, resetDouble } from "../booking/repro/checkout-harness/setup";
import { SlotTakenError } from "../../lib/booking/booking-rule-error";
import { buildOccupiedAppointmentFilter } from "../../utils/scheduling-engine/occupancyPolicy";
import type { Tx } from "../../lib/prisma";
import { classifyError } from "../../lib/errors/classification/payment-error-classification";

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

    const where = wheres[0] as {
      AND: Array<{ appointment?: { AND?: unknown[] } }>;
    };
    const occupied = where.AND.find((clause) => clause.appointment?.AND);
    expect(occupied).toEqual({
      appointment: {
        AND: [{ OR: buildOccupiedAppointmentFilter() }, expect.anything()],
      },
    });
    // Only the dead-hold subtraction (a booking being moved names its
    // released row) may read tentativeness.
    expect(
      JSON.stringify(where.AND.filter((clause) => clause !== occupied)),
    ).not.toContain('"isTentative"');
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
    ...orgMember("PERSONAL", "SUSPENDED"),
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

describe("modelled refusals answer as refusals", () => {
  it.each([
    ["CONSULTATION", "consultationPlan.findUnique"],
    ["SUBSCRIPTION", "subscriptionPlan.findUnique"],
  ] as const)(
    "an unverified expert's %s is a typed 409, not a 500",
    async (appointmentType, planLookup) => {
      resetDouble({
        "user.findUnique": () => buyerRow(),
        [planLookup]: () => ({
          ...publishedPlan,
          consultantProfile: { ...profile, verificationStatus: "PENDING" },
        }),
      });
      const error = await refusal(
        buildCheckoutInput({
          appointmentType,
          startsAt: at(0).toISOString(),
          endsAt: at(1).toISOString(),
        }),
      );
      expect(error).toMatchObject({
        httpStatus: 409,
        code: "EXPERT_NOT_VERIFIED",
      });
      expect(classifyError(error)).toMatchObject({
        httpStatus: 409,
        isBusinessError: true,
      });
      expect(createPaymentIntent).not.toHaveBeenCalled();
    },
  );

  it("a slot another buyer holds is reported as expected, never as a fault", async () => {
    mockReportSentryError.mockClear();
    resetDouble({
      "user.findUnique": () => buyerRow(),
      "consultationPlan.findUnique": () => publishedPlan,
      "appointmentOccurrence.findFirst": () => ({
        id: "held",
        isTentative: true,
      }),
    });
    const error = await refusal(
      buildCheckoutInput({
        appointmentType: "CONSULTATION",
        startsAt: at(0).toISOString(),
        endsAt: at(1).toISOString(),
      }),
    );
    expect(error).toBeInstanceOf(SlotTakenError);
    const reports = mockReportSentryError.mock.calls.filter(
      ([reported]) => reported === error,
    );
    expect(reports.length).toBeGreaterThan(0);
    for (const [, context] of reports) {
      expect(context).toMatchObject({ expected: true });
    }
  });
});
