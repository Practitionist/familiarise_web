/**
 * @jest-environment node
 */

/**
 * A notice the other party causes skips the recipient's switches through a
 * per-send override; the same template sent about the recipient's own action
 * stays gated, and erasure still stops both. The real-Postgres twin of these
 * pins is `__tests__/db/required-notices.db.test.ts`.
 */
const mockFindMany = jest.fn();
const mockUpsert = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: (...args: unknown[]) => mockFindMany(...args) },
    notificationOutbox: { upsert: (...args: unknown[]) => mockUpsert(...args) },
  },
}));
jest.mock("../../lib/novu/client", () => ({
  __esModule: true,
  isNovuConfigured: () => true,
  getNovuClient: () => ({ trigger: jest.fn(), triggerBulk: jest.fn() }),
}));

import { resolveRecipientBellPolicy } from "@/lib/novu/policy";
import {
  notifyAppointmentCancelled,
  notifyAppointmentRescheduled,
  sessionMovesText,
} from "@/lib/novu/service";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import { loadEmailRecipients } from "@/lib/email/preferences";
import {
  ALWAYS_SENT_LINE,
  REQUIRED_NOTICE_KINDS,
  REQUIRED_NOTICE_LABEL,
  requiredNoticeOf,
} from "@/lib/notifications/required-notices";
import {
  CLASS_SESSION_REFUND_REASON,
  STAFF_CANCEL_REFUND_REASON,
  cancelRefundReason,
  refundNoticeKind,
  rejectionRefundReason,
  trialCancelRefundReason,
  seatRemovalRefundReason,
  wholeEventCancelRefundReason,
} from "@/lib/payments/operations/refund-cause";

const MUTED = {
  allNotifications: false,
  inAppEnabled: false,
  emailEnabled: false,
  appointmentReminders: false,
  paymentNotifications: false,
  subscriptionAlerts: false,
  trialNotifications: false,
  supportUpdates: false,
  feedbackAlerts: false,
  orgBillingAlerts: false,
  orgMembershipAlerts: false,
  orgProgramAlerts: false,
};

const user = (id: string, erased = false) => ({
  id,
  email: `${id}@example.test`,
  name: id,
  timezone: "Asia/Kolkata",
  erasedAt: erased ? new Date() : null,
  notificationPreferences: MUTED,
});

beforeEach(() => {
  mockFindMany.mockReset();
  mockUpsert.mockReset();
  mockUpsert.mockImplementation(async ({ create }) => ({
    id: create.transactionId,
    ...create,
    attempts: 0,
  }));
});

describe("the bell gate", () => {
  it("lets a required send through every switch, never past erasure", async () => {
    mockFindMany.mockResolvedValue([user("muted"), user("erased", true)]);
    const required = await resolveRecipientBellPolicy(
      NOVU_WORKFLOWS.APPOINTMENT_CANCELLED,
      ["muted", "erased"],
      { required: true },
    );
    const ownAction = await resolveRecipientBellPolicy(
      NOVU_WORKFLOWS.APPOINTMENT_CANCELLED,
      ["muted", "erased"],
    );
    expect(required.allowedRecipients).toEqual(["muted"]);
    expect(ownAction.allowedRecipients).toEqual([]);
  });

  it.each(REQUIRED_NOTICE_KINDS)(
    "%s: stages the listed recipient with the kind on the row, and drops the rest",
    async (kind) => {
      mockFindMany.mockResolvedValue([user("buyer"), user("expert")]);
      const results = await notifyAppointmentCancelled(
        ["buyer", "expert"],
        {
          ...notificationScope(null),
          appointmentType: "CONSULTATION",
          consultantName: "Expert",
          consulteeName: "Buyer",
          planTitle: "Plan",
          dashboardUrl: "/dashboard",
          cancelledBy: "consultant",
        },
        { deferAttempt: true, required: { kind, recipients: ["buyer"] } },
      );
      expect(mockUpsert).toHaveBeenCalledTimes(1);
      const { create } = mockUpsert.mock.calls[0][0];
      expect(create.recipients).toEqual(["buyer"]);
      expect(requiredNoticeOf(create.payload)).toBe(kind);
      expect(results.filter((r) => r.staged)).toHaveLength(1);
    },
  );
});

describe("the email gate", () => {
  it("sends a required notice to a muted recipient without an unsubscribe link, and keeps the rest gated", async () => {
    mockFindMany.mockResolvedValue([
      user("buyer"),
      user("expert"),
      user("erased", true),
    ]);
    const recipients = await loadEmailRecipients(
      ["buyer", "expert", "erased"],
      "appointments",
      undefined,
      ["buyer", "erased"],
    );
    expect(recipients.map((r) => [r.userId, r.allowed, r.category])).toEqual([
      ["buyer", true, null],
      ["expert", false, "appointments"],
    ]);
    expect(recipients[0].unsubscribeUrl).toBeNull();
  });
});

describe("refund cause", () => {
  it("marks only the host side's refunds as required", () => {
    expect(refundNoticeKind(cancelRefundReason(100, "consultant"))).toBe(
      "REFUND_FROM_HOST_CANCEL",
    );
    expect(refundNoticeKind(cancelRefundReason(50, "consultee"))).toBeNull();
    expect(
      refundNoticeKind(wholeEventCancelRefundReason("class", "host ill")),
    ).toBe("REFUND_FROM_HOST_CANCEL");
    expect(
      refundNoticeKind(seatRemovalRefundReason("webinar", "w1", true, 100)),
    ).toBe("SEAT_RELEASED");
    expect(
      refundNoticeKind(seatRemovalRefundReason("webinar", "w1", false, 100)),
    ).toBeNull();
    expect(refundNoticeKind("support refund")).toBeNull();
    expect(refundNoticeKind(cancelRefundReason(100, "staff"))).toBe(
      "REFUND_FROM_STAFF_CANCEL",
    );
    expect(
      refundNoticeKind(wholeEventCancelRefundReason("webinar", "x", true)),
    ).toBe("REFUND_FROM_STAFF_CANCEL");
    expect(refundNoticeKind(STAFF_CANCEL_REFUND_REASON.MODERATION)).toBe(
      "REFUND_FROM_STAFF_CANCEL",
    );
    expect(refundNoticeKind(STAFF_CANCEL_REFUND_REASON.MAINTENANCE)).toBe(
      "REFUND_FROM_STAFF_CANCEL",
    );
    expect(refundNoticeKind(rejectionRefundReason("consultation", 100))).toBe(
      "REQUEST_DECLINED",
    );
    expect(refundNoticeKind(CLASS_SESSION_REFUND_REASON.HOST_CANCELLED)).toBe(
      "CLASS_SESSION_REFUNDED",
    );
    expect(refundNoticeKind(CLASS_SESSION_REFUND_REASON.HOST_VOIDED)).toBe(
      "CLASS_SESSION_REFUNDED",
    );
    expect(refundNoticeKind(CLASS_SESSION_REFUND_REASON.VOIDED)).toBeNull();
    const tier = { tierRefundPct: 100, creditRestoresInFull: false };
    expect(refundNoticeKind(trialCancelRefundReason("consultant", tier))).toBe(
      "REFUND_FROM_HOST_CANCEL",
    );
    expect(refundNoticeKind(trialCancelRefundReason("staff", tier))).toBe(
      "REFUND_FROM_STAFF_CANCEL",
    );
    expect(
      refundNoticeKind(trialCancelRefundReason("consultee", tier)),
    ).toBeNull();
  });
});

describe("copy", () => {
  it("the Settings line names every required kind once", () => {
    for (const kind of REQUIRED_NOTICE_KINDS) {
      expect(ALWAYS_SENT_LINE.split(REQUIRED_NOTICE_LABEL[kind])).toHaveLength(
        2,
      );
    }
  });

  it("a series move lists ten sessions, then the rest as a count", () => {
    const moves = Array.from({ length: 12 }, (_, i) => ({
      from: new Date(Date.UTC(2026, 11, 1 + i, 4, 30)).toISOString(),
      to: new Date(Date.UTC(2026, 11, 1 + i, 6, 30)).toISOString(),
    }));
    const text = sessionMovesText(moves, "Asia/Kolkata");
    expect(text.split(" → ")).toHaveLength(11);
    expect(text.endsWith("; and 2 more")).toBe(true);
  });

  it("a proposal names its answer-by time in the recipient's zone", async () => {
    mockFindMany.mockResolvedValue([
      { ...user("buyer"), notificationPreferences: null },
    ]);
    await notifyAppointmentRescheduled(
      ["buyer"],
      {
        ...notificationScope(null),
        appointmentType: "CONSULTATION",
        consultantName: "Expert",
        consulteeName: "Buyer",
        planTitle: "Plan",
        dashboardUrl: "/dashboard",
        outcome: "PROPOSED",
        oldDateTime: "2026-12-01T04:30:00.000Z",
        newDateTime: "2026-12-02T04:30:00.000Z",
        respondBy: "2026-11-30T12:30:00.000Z",
      },
      { deferAttempt: true },
    );
    const { create } = mockUpsert.mock.calls[0][0];
    expect(create.payload.respondByIso).toBe("2026-11-30T12:30:00.000Z");
    expect(create.payload.respondBy).toMatch(/30 Nov 2026.*6:00 PM/);
  });
});
