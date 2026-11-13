/**
 * @jest-environment node
 */

import { DM_ELIGIBLE_STATUSES } from "../../lib/stream/dm-eligibility-statuses";

const mockUserFindUnique = jest.fn();
const mockConsultationFindFirst = jest.fn();
const mockSubscriptionFindFirst = jest.fn();
const mockWebinarFindFirst = jest.fn();
const mockClassFindFirst = jest.fn();
const mockCollaboratorFindFirst = jest.fn();

const mockConsultationFindMany = jest.fn();
const mockSubscriptionFindMany = jest.fn();
const mockWebinarFindMany = jest.fn();
const mockClassFindMany = jest.fn();

const mockAppointmentFindUnique = jest.fn();
const mockAppointmentUpdateMany = jest.fn();
const mockCreateDirectMessageChannel = jest.fn();
const mockAddUserToEventChannel = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    consultation: {
      findFirst: (...args: unknown[]) => mockConsultationFindFirst(...args),
      findMany: (...args: unknown[]) => mockConsultationFindMany(...args),
    },
    subscription: {
      findFirst: (...args: unknown[]) => mockSubscriptionFindFirst(...args),
      findMany: (...args: unknown[]) => mockSubscriptionFindMany(...args),
    },
    webinar: {
      findFirst: (...args: unknown[]) => mockWebinarFindFirst(...args),
      findMany: (...args: unknown[]) => mockWebinarFindMany(...args),
    },
    class: {
      findFirst: (...args: unknown[]) => mockClassFindFirst(...args),
      findMany: (...args: unknown[]) => mockClassFindMany(...args),
    },
    collaborator: {
      findFirst: (...args: unknown[]) => mockCollaboratorFindFirst(...args),
    },
    appointment: {
      findUnique: (...args: unknown[]) => mockAppointmentFindUnique(...args),
      updateMany: (...args: unknown[]) => mockAppointmentUpdateMany(...args),
    },
  },
}));

jest.mock("../../actions/stream/chat/channel.action", () => ({
  createDirectMessageChannel: (...args: unknown[]) =>
    mockCreateDirectMessageChannel(...args),
}));

jest.mock("../../lib/stream/event-channel-service", () => ({
  addUserToEventChannel: (...args: unknown[]) =>
    mockAddUserToEventChannel(...args),
}));

describe("DM eligibility rules and channel provisioning", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserFindUnique.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === "consultant-u1"
            ? { consultantProfileId: "cp-1", consulteeProfileId: null }
            : { consultantProfileId: null, consulteeProfileId: "ce-2" },
        ),
    );
    mockConsultationFindFirst.mockResolvedValue(null);
    mockSubscriptionFindFirst.mockResolvedValue(null);
    mockWebinarFindFirst.mockResolvedValue(null);
    mockClassFindFirst.mockResolvedValue(null);
    mockCollaboratorFindFirst.mockResolvedValue(null);
    mockConsultationFindMany.mockResolvedValue([]);
    mockSubscriptionFindMany.mockResolvedValue([]);
    mockWebinarFindMany.mockResolvedValue([]);
    mockClassFindMany.mockResolvedValue([]);
    mockAppointmentUpdateMany.mockResolvedValue({ count: 1 });
    mockCreateDirectMessageChannel.mockResolvedValue({ channelId: "dm-a-b" });
    mockAddUserToEventChannel.mockResolvedValue({ success: true });
  });

  it("excludes APPROVED_PENDING_PAYMENT from DM_ELIGIBLE_STATUSES", () => {
    expect(DM_ELIGIBLE_STATUSES).not.toContain("APPROVED_PENDING_PAYMENT");
    expect(DM_ELIGIBLE_STATUSES).toEqual(["APPROVED", "COMPLETED"]);
  });

  it("grants DM eligibility for confirmed webinar and class bookings", async () => {
    const { canDirectMessage } =
      await import("../../lib/stream/dm-eligibility");
    mockWebinarFindFirst.mockResolvedValueOnce({ id: "web-1" });

    const allowed = await canDirectMessage("consultant-u1", "attendee-u2");
    expect(allowed).toBe(true);
    expect(mockWebinarFindFirst).toHaveBeenCalledTimes(1);
    expect(mockClassFindFirst).toHaveBeenCalledTimes(1);
  });

  it("maps WEBINAR and CLASS bookings in pairBookingContexts", async () => {
    const { pairBookingContexts } =
      await import("../../lib/stream/dm-eligibility");
    mockWebinarFindMany.mockResolvedValueOnce([
      {
        webinarPlan: { organizationId: "org-web-1" },
        appointment: { organizationId: null },
      },
    ]);
    mockClassFindMany.mockResolvedValueOnce([
      {
        classPlan: { organizationId: null },
        appointment: { organizationId: null },
      },
    ]);

    const contexts = await pairBookingContexts("consultant-u1", "attendee-u2");
    expect(contexts).toEqual({
      personalAllowed: true,
      organizations: ["org-web-1"],
    });
  });

  it("never lets a trial-backed booking grant a DM", async () => {
    const { canDirectMessage } =
      await import("../../lib/stream/dm-eligibility");
    // The store holds only a trial-backed booking for the pair.
    mockConsultationFindFirst.mockImplementation(
      async ({ where }: { where: { NOT?: unknown } }) =>
        JSON.stringify(where.NOT ?? null).includes('"TRIAL"')
          ? null
          : { id: "consultation-from-trial" },
    );

    await expect(
      canDirectMessage("consultant-u1", "consultee-u2"),
    ).resolves.toBe(false);
  });

  it("never lets a booking whose client seat was refunded keep a DM open", async () => {
    const { pairBookingContexts } =
      await import("../../lib/stream/dm-eligibility");
    // The store holds only a still-SCHEDULED booking whose seat was refunded.
    const refundedOnly = async ({ where }: { where: { NOT?: unknown } }) =>
      JSON.stringify(where.NOT ?? null).includes('"REFUNDED"')
        ? []
        : [
            {
              consultationPlan: { organizationId: null },
              subscriptionPlan: { organizationId: null },
              appointment: { organizationId: null },
            },
          ];
    mockConsultationFindMany.mockImplementation(refundedOnly);
    mockSubscriptionFindMany.mockImplementation(refundedOnly);

    await expect(
      pairBookingContexts("consultant-u1", "consultee-u2"),
    ).resolves.toEqual({ personalAllowed: false, organizations: [] });
    expect(mockConsultationFindMany).toHaveBeenCalled();
  });

  it("leaves an event booking unstamped when the buyer never became a member", async () => {
    const { ensureChannelsForAppointment } =
      await import("../../lib/payments/webhooks/ensure-channels");
    mockAddUserToEventChannel.mockResolvedValueOnce({
      success: false,
      reason: "member_not_added",
    });
    mockAppointmentFindUnique.mockResolvedValueOnce({
      id: "appt-web-2",
      appointmentType: "WEBINAR",
      organizationId: null,
      payment: [{ userId: "buyer-1" }],
      participants: [{ userId: "buyer-1" }],
      consultation: null,
      subscription: null,
      webinar: {
        id: "web-2",
        webinarPlan: {
          organizationId: null,
          consultantProfile: { userId: "consultant-1" },
        },
      },
      class: null,
      trial: null,
    });

    const res = await ensureChannelsForAppointment("appt-web-2");

    expect(res.ensured).toBe(false);
    expect(mockAppointmentUpdateMany).not.toHaveBeenCalled();
  });

  it("blocks trial chat in ensureChannelsForAppointment while stamping chatChannelEnsuredAt", async () => {
    const { ensureChannelsForAppointment } =
      await import("../../lib/payments/webhooks/ensure-channels");

    mockAppointmentFindUnique.mockResolvedValueOnce({
      id: "appt-trial-1",
      appointmentType: "TRIAL",
      organizationId: null,
      payment: [{ userId: "buyer-1" }],
      consultation: null,
      subscription: null,
      webinar: null,
      class: null,
      trial: { consultantProfile: { userId: "consultant-1" } },
    });

    const res = await ensureChannelsForAppointment("appt-trial-1");
    expect(res).toEqual({ ensured: true, skipped: "trial_chat_blocked" });
    expect(mockCreateDirectMessageChannel).not.toHaveBeenCalled();
    expect(mockAddUserToEventChannel).not.toHaveBeenCalled();
    expect(mockAppointmentUpdateMany).toHaveBeenCalledWith({
      where: { id: "appt-trial-1", chatChannelEnsuredAt: null },
      data: { chatChannelEnsuredAt: expect.any(Date) },
    });
  });

  it("provisions both event channel and 1:1 DM for confirmed webinar and class bookings", async () => {
    const { ensureChannelsForAppointment } =
      await import("../../lib/payments/webhooks/ensure-channels");

    mockAppointmentFindUnique.mockResolvedValueOnce({
      id: "appt-web-1",
      appointmentType: "WEBINAR",
      organizationId: "org-1",
      payment: [{ userId: "buyer-1" }],
      participants: [{ userId: "buyer-1" }],
      consultation: null,
      subscription: null,
      webinar: {
        id: "web-1",
        webinarPlan: {
          organizationId: "org-plan",
          consultantProfile: { userId: "consultant-1" },
        },
      },
      class: null,
      trial: null,
    });

    const res = await ensureChannelsForAppointment("appt-web-1");
    expect(res).toEqual({ ensured: true });
    expect(mockAddUserToEventChannel).toHaveBeenCalledWith(
      "webinar",
      "web-1",
      "buyer-1",
    );
    expect(mockCreateDirectMessageChannel).toHaveBeenCalledWith(
      "consultant-1",
      "buyer-1",
      "org-plan",
    );
  });
});
