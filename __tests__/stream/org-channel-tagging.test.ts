/**
 * @jest-environment node
 */

/**
 * #1280 PR 7 — the org tag, and the logout gap next to it.
 *
 * Measured live on 2026-08-30: ZERO of 886 Stream channels carried
 * `organization_id`, in any form, and `dmo-` was 0. The org Messages tab and
 * the `/api/organizations/[orgId]/stream/channels` compliance route both filter
 * on that field, so both returned empty for every organization — a compliance
 * export that reported "no channels" rather than failing.
 *
 * #746 §1 records per-org channel tagging as done. It was not.
 */

import { bookingOrgId } from "../../lib/stream-utils";

describe("bookingOrgId — one resolver for every booking shape", () => {
  it("resolves an event plan's org", () => {
    // Webinars and classes were the gap: the helper only knew about
    // consultation and subscription plans, so the lazy event-channel create
    // path had nothing to ask and tagged nothing.
    expect(bookingOrgId({ webinarPlan: { organizationId: "org-1" } })).toBe(
      "org-1",
    );
    expect(bookingOrgId({ classPlan: { organizationId: "org-2" } })).toBe(
      "org-2",
    );
  });

  it("prefers the PLAN over the appointment, for every booking kind", () => {
    // The precedence is the whole point of having one resolver. A second
    // implementation for events is how the tag came to disagree between the
    // creator, approval and the reconciler in the first place.
    for (const planKey of [
      "consultationPlan",
      "subscriptionPlan",
      "webinarPlan",
      "classPlan",
    ] as const) {
      expect(
        bookingOrgId({
          [planKey]: { organizationId: "from-plan" },
          appointment: { organizationId: "from-appointment" },
        }),
      ).toBe("from-plan");
    }
  });

  it("resolves the appointment's org when the plan carries none", () => {
    // The arm that was missing. A personal plan booked under an organization
    // has its org on the APPOINTMENT, and the DM-eligibility path reads it —
    // so a tagger that only looked at the plan would leave the channel
    // untagged while the pair was treated as org-scoped elsewhere. A resolver
    // that disagrees with itself depending on the caller is the bug class this
    // whole change is about.
    expect(
      bookingOrgId({
        consultationPlan: { organizationId: null },
        appointment: { organizationId: "org-4" },
      }),
    ).toBe("org-4");
    expect(
      bookingOrgId({
        subscriptionPlan: { organizationId: null },
        appointment: { organizationId: "org-5" },
      }),
    ).toBe("org-5");
  });

  it("has one row to read, so there is no order to disagree over (#1554)", () => {
    // #1304 review found `find()` over an unordered relation minting two DM
    // channels for one relationship. A booking is now ONE Appointment, so the
    // org tag is a single column and the helper carries no list arm at all.
    expect(
      bookingOrgId({
        classPlan: { organizationId: null },
        appointment: { organizationId: "org-a" },
      }),
    ).toBe("org-a");
  });

  it("returns null for a wholly personal booking", () => {
    // Null must stay null: the create path spreads the field in only when it is
    // set, because a literal `organization_id: null` is a SET on Stream's side
    // and the reconciler's `$exists` filters treat that differently from absent.
    expect(
      bookingOrgId({
        consultationPlan: { organizationId: null },
        appointment: { organizationId: null },
      }),
    ).toBeNull();
  });
});

const mockPaymentFindMany = jest.fn();
const mockRecordingFindMany = jest.fn();
const mockRecordingPurchaseFindMany = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findMany: (...args: unknown[]) => mockPaymentFindMany(...args),
    },
    recordingPurchase: {
      findMany: (...args: unknown[]) => mockRecordingPurchaseFindMany(...args),
    },
    recording: {
      findMany: (...args: unknown[]) => mockRecordingFindMany(...args),
    },
  },
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamVideoClient: jest.fn(),
  withStreamCircuitBreaker: <T>(fn: () => T) => fn(),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("RecordingService.getConsulteeRecordings organizationId filter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPaymentFindMany.mockResolvedValue([
      {
        amount: 50000,
        appointmentId: "appt-1",
        refunds: [],
        appointment: {
          id: "appt-1",
          webinar: {
            webinarPlanId: "wp-1",
            webinarPlan: { shareRecordingsWithAllAttendees: false },
          },
          class: null,
          consultation: null,
          subscription: null,
          trial: null,
        },
      },
    ]);
    mockRecordingPurchaseFindMany.mockResolvedValue([]);
    mockRecordingFindMany.mockResolvedValue([]);
  });

  it("applies organizationId filter when set to an org id or null, and omits it when undefined", async () => {
    const { RecordingService } =
      await import("../../lib/stream/recording-service");

    await RecordingService.getConsulteeRecordings("user-1", {
      organizationId: "org-123",
    });
    expect(mockRecordingFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-123",
        }),
      }),
    );

    await RecordingService.getConsulteeRecordings("user-1", {
      organizationId: null,
    });
    expect(mockRecordingFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: null,
        }),
      }),
    );

    await RecordingService.getConsulteeRecordings("user-1");
    const lastWhere = mockRecordingFindMany.mock.calls.at(-1)?.[0]
      ?.where as Record<string, unknown>;
    expect(lastWhere).not.toHaveProperty("organizationId");
  });
});
