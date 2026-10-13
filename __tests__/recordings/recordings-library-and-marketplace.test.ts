/**
 * @jest-environment node
 */

const mockGetSession = jest.fn();
const mockConsultantProfileFindUnique = jest.fn();
const mockRequireApiAuth = jest.fn();
const mockRecordingCount = jest.fn();
const mockRecordingFindMany = jest.fn();
const mockRecordingPurchaseFindFirst = jest.fn();
const mockRecordingPurchaseFindMany = jest.fn();
const mockConsulteeProfileFindUnique = jest.fn();
const mockConsultationFindMany = jest.fn();
const mockSubscriptionFindMany = jest.fn();
const mockWebinarFindMany = jest.fn();
const mockClassFindMany = jest.fn();
const mockTrialFindMany = jest.fn();
const mockGetBestRecordingUrl = jest.fn();
const mockRecordingFindUnique = jest.fn();
const mockGetPublicRecordingBySlug = jest.fn();
const mockAuditOperatorRecordingAccess = jest.fn();

jest.mock("../../lib/auth-client", () => ({
  __esModule: true,
  useSession: jest.fn(),
  getSession: jest.fn(),
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: (...args: unknown[]) => mockRequireApiAuth(...args),
  forbiddenResponse: (msg: string) =>
    new Response(JSON.stringify({ error: msg }), { status: 403 }),
}));

const mockRecordingPurchaseFindUnique = jest.fn();
const mockRecordingPurchaseUpdateMany = jest.fn();
const mockPaymentFindUnique = jest.fn();
const mockPaymentCreate = jest.fn();
const mockCreateEarningsFromPayment = jest.fn();

const mockTx = {
  recordingPurchase: {
    findFirst: (...args: unknown[]) => mockRecordingPurchaseFindFirst(...args),
    findMany: (...args: unknown[]) => mockRecordingPurchaseFindMany(...args),
    findUnique: (...args: unknown[]) =>
      mockRecordingPurchaseFindUnique(...args),
    updateMany: (...args: unknown[]) =>
      mockRecordingPurchaseUpdateMany(...args),
  },
  payment: {
    findUnique: (...args: unknown[]) => mockPaymentFindUnique(...args),
    create: (...args: unknown[]) => mockPaymentCreate(...args),
  },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (cb: (tx: typeof mockTx) => Promise<unknown>) =>
      cb(mockTx),
    user: { findUnique: async () => ({ country: "IN" }) },
    consultantProfile: {
      findUnique: (...args: unknown[]) =>
        mockConsultantProfileFindUnique(...args),
    },
    recording: {
      count: (...args: unknown[]) => mockRecordingCount(...args),
      findMany: (...args: unknown[]) => mockRecordingFindMany(...args),
      findUnique: (...args: unknown[]) => mockRecordingFindUnique(...args),
    },
    recordingPurchase: {
      findFirst: (...args: unknown[]) =>
        mockRecordingPurchaseFindFirst(...args),
      findMany: (...args: unknown[]) => mockRecordingPurchaseFindMany(...args),
      findUnique: (...args: unknown[]) =>
        mockRecordingPurchaseFindUnique(...args),
      updateMany: (...args: unknown[]) =>
        mockRecordingPurchaseUpdateMany(...args),
    },
    payment: {
      findUnique: (...args: unknown[]) => mockPaymentFindUnique(...args),
      create: (...args: unknown[]) => mockPaymentCreate(...args),
    },
    consulteeProfile: {
      findUnique: (...args: unknown[]) =>
        mockConsulteeProfileFindUnique(...args),
    },
    consultation: {
      findMany: (...args: unknown[]) => mockConsultationFindMany(...args),
    },
    subscription: {
      findMany: (...args: unknown[]) => mockSubscriptionFindMany(...args),
    },
    webinar: {
      findMany: (...args: unknown[]) => mockWebinarFindMany(...args),
    },
    class: {
      findMany: (...args: unknown[]) => mockClassFindMany(...args),
    },
    trial: {
      findMany: (...args: unknown[]) => mockTrialFindMany(...args),
    },
  },
}));

const mockMintConsumerInvoice = jest.fn();
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  mintConsumerInvoiceBestEffort: (...args: unknown[]) =>
    mockMintConsumerInvoice(...args),
}));

jest.mock("../../lib/payments/payouts/earnings-service", () => ({
  __esModule: true,
  createEarningsFromPayment: (...args: unknown[]) =>
    mockCreateEarningsFromPayment(...args),
}));

jest.mock("../../lib/stream/recording-storage", () => {
  const actual = jest.requireActual("../../lib/stream/recording-storage");
  return {
    __esModule: true,
    ...actual,
    getBestRecordingUrl: (...args: unknown[]) =>
      mockGetBestRecordingUrl(...args),
  };
});

jest.mock("../../lib/stream/recording-operator-access", () => {
  const actual = jest.requireActual(
    "../../lib/stream/recording-operator-access",
  );
  return {
    __esModule: true,
    ...actual,
    auditOperatorRecordingAccess: (...args: unknown[]) =>
      mockAuditOperatorRecordingAccess(...args),
  };
});

jest.mock("../../lib/data/recordings-explore", () => ({
  __esModule: true,
  getPublicRecordingBySlug: (...args: unknown[]) =>
    mockGetPublicRecordingBySlug(...args),
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

import { chatAffordancesForVm } from "@/components/appointments/consultee/ConsulteeAppointmentsAdapter";
import { canDeleteRecording } from "@/components/recordings/RecordingManageSheet";
import { resolveActivePlaybackUrl } from "@/components/recordings/RecordingPlayerModal";
import { buildCaptionTrackDataUri } from "@/components/recordings/caption-track";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import { handleRecordingPurchaseSuccess } from "@/lib/payments/webhooks/recording-purchase";

describe("Recordings Library, Marketplace Unlock & Contextual Appointment Chat", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBestRecordingUrl.mockReturnValue(
      "https://signed.example.com/rec.mp4",
    );
    mockAuditOperatorRecordingAccess.mockResolvedValue(undefined);
  });

  describe("Delete guard, Player race guard & Contextual Appointment Chat", () => {
    it("refuses deletion when a recording has buyers", () => {
      expect(canDeleteRecording({ hasBuyers: false })).toBe(true);
      expect(canDeleteRecording({ hasBuyers: true })).toBe(false);
    });

    it("ignores a stale presigned URL response for recording A after switching to recording B", () => {
      const recordingB = { id: "rec-B", playbackUrl: null };
      const lateResponseFromA = {
        recordingId: "rec-A",
        url: "https://signed.example.com/rec-A.mp4",
      };
      expect(
        resolveActivePlaybackUrl(recordingB, lateResponseFromA),
      ).toBeNull();

      const matchingResponseForB = {
        recordingId: "rec-B",
        url: "https://signed.example.com/rec-B.mp4",
      };
      expect(resolveActivePlaybackUrl(recordingB, matchingResponseForB)).toBe(
        "https://signed.example.com/rec-B.mp4",
      );
    });

    it("builds contextual DM and Event Chat affordances across DM_ELIGIBLE_STATUSES and OPENABLE_EVENT_STATUSES while requiring counterpartyUserId and excluding trials", () => {
      const baseConsultationVm = {
        id: "vm-1",
        appointmentId: "apt-1",
        kind: "CONSULTATION",
        status: "APPROVED",
        raw: {
          appointment: {
            consultation: {
              requestedBy: { user: { id: "u-consultee-1" } },
              consultationPlan: {
                consultantProfile: { user: { id: "u-consultant-1" } },
              },
            },
          },
        },
      } as unknown as AppointmentVM;

      // APPROVED is in DM_ELIGIBLE_STATUSES for both consultee and consultant
      const consulteeDmItems = chatAffordancesForVm({
        vm: baseConsultationVm,
        messagesBasePath: "/dashboard/consultee/ce-1/messages",
        role: "consultee",
        push: jest.fn(),
      });
      expect(consulteeDmItems).toEqual([
        expect.objectContaining({
          key: "message",
          label: "Message Consultant",
          href: "/dashboard/consultee/ce-1/messages?contextAppointmentId=apt-1&counterpartyUserId=u-consultant-1",
        }),
      ]);

      const consultantDmItems = chatAffordancesForVm({
        vm: baseConsultationVm,
        messagesBasePath: "/dashboard/consultant/cp-1/messages",
        role: "consultant",
        push: jest.fn(),
      });
      expect(consultantDmItems).toEqual([
        expect.objectContaining({
          key: "message",
          label: "Message Consultee",
          href: "/dashboard/consultant/cp-1/messages?contextAppointmentId=apt-1&counterpartyUserId=u-consultee-1",
        }),
      ]);

      // Missing counterpartyUserId omits the DM link instead of emitting a broken link
      const missingCounterpartyVm = {
        ...baseConsultationVm,
        raw: { appointment: {} },
      } as unknown as AppointmentVM;
      expect(
        chatAffordancesForVm({
          vm: missingCounterpartyVm,
          messagesBasePath: "/dashboard/consultee/ce-1/messages",
          role: "consultee",
          push: jest.fn(),
        }),
      ).toEqual([]);

      // Group webinar in SCHEDULED status offers Open Event Chat + Message Consultant when host userId is resolved
      const webinarVm = {
        id: "vm-web-1",
        appointmentId: "apt-web-1",
        kind: "WEBINAR",
        status: "SCHEDULED",
        raw: {
          appointment: {
            webinarId: "web-1",
            webinar: {
              id: "web-1",
              webinarPlan: {
                consultantProfile: { user: { id: "u-host-1" } },
              },
            },
          },
        },
      } as unknown as AppointmentVM;
      const webinarItems = chatAffordancesForVm({
        vm: webinarVm,
        messagesBasePath: "/dashboard/consultee/ce-1/messages",
        role: "consultee",
        push: jest.fn(),
      });
      expect(webinarItems.map((i) => i.label)).toEqual([
        "Open Event Chat",
        "Message Consultant",
      ]);

      // Trial bookings never emit direct chat or event chat items
      const trialVm = {
        ...baseConsultationVm,
        kind: "TRIAL",
        status: "SCHEDULED",
      } as unknown as AppointmentVM;
      expect(
        chatAffordancesForVm({
          vm: trialVm,
          messagesBasePath: "/dashboard/consultee/ce-1/messages",
          role: "consultee",
          push: jest.fn(),
        }),
      ).toEqual([]);
    });

    it("settles RecordingPurchase, Payment, and ConsultantEarnings atomically inside a transaction and is idempotent on replay", async () => {
      mockRecordingPurchaseFindUnique.mockResolvedValueOnce({
        id: "rp-1",
        buyerId: "u-buyer-1",
        amountPaise: 99900,
        status: "PENDING",
        recording: {
          id: "rec-100",
          organizationId: "org-host-1",
          meeting: {
            occurrence: {
              appointment: {
                organizationId: "org-host-1",
                webinar: {
                  webinarPlanId: "wplan-100",
                  webinarPlan: {
                    id: "wplan-100",
                    consultantProfileId: "cp-host-1",
                    organizationId: "org-host-1",
                  },
                },
                class: null,
                consultation: null,
                subscription: null,
              },
            },
          },
        },
      });
      mockRecordingPurchaseUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockPaymentFindUnique.mockResolvedValueOnce(null);
      mockPaymentCreate.mockResolvedValueOnce({
        id: "pay-rec-1",
        userId: "u-buyer-1",
        appointmentId: null,
        amount: 99900,
        originalAmount: 99900,
        taxAmount: 0,
        currency: "INR",
        paymentMethod: "CARD",
        paymentIntent: "order_rec_1",
        paymentGateway: "RAZORPAY",
        paymentStatus: "SUCCEEDED",
        gatewayPaymentId: "pay_rzp_1",
        organizationId: "org-host-1",
        createdAt: new Date("2026-10-04T00:00:00Z"),
      });
      mockCreateEarningsFromPayment.mockResolvedValueOnce("earn-1");

      // The mint stamps the GST split on the order notes; it sums to the charge.
      await handleRecordingPurchaseSuccess(
        "order_rec_1",
        "pay_rzp_1",
        {
          type: "recording_purchase",
          originalAmountPaise: "84661",
          taxAmountPaise: "15239",
          buyerCountry: "IN",
        },
        99900,
      );

      expect(mockRecordingPurchaseUpdateMany).toHaveBeenCalledWith({
        where: { id: "rp-1", status: "PENDING" },
        data: { status: "SUCCEEDED", gatewayPaymentId: "pay_rzp_1" },
      });
      expect(mockPaymentCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "u-buyer-1",
          appointmentId: null,
          amount: 99900,
          originalAmount: 84661,
          taxAmount: 15239,
          buyerCountry: "IN",
          paymentIntent: "order_rec_1",
          paymentStatus: "SUCCEEDED",
          gatewayPaymentId: "pay_rzp_1",
          organizationId: "org-host-1",
        }),
      });
      expect(mockCreateEarningsFromPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          appointmentType: "WEBINAR",
          tx: mockTx,
          payment: expect.objectContaining({
            id: "pay-rec-1",
            appointment: {
              consultantProfile: { id: "cp-host-1" },
              organizationId: "org-host-1",
              webinar: { webinarPlanId: "wplan-100" },
              class: null,
            },
          }),
        }),
      );
      expect(mockMintConsumerInvoice).toHaveBeenCalledWith({
        paymentId: "pay-rec-1",
      });

      // Replay when already SUCCEEDED does not create duplicate Payment or earnings
      jest.clearAllMocks();
      mockRecordingPurchaseFindUnique.mockResolvedValueOnce({
        id: "rp-1",
        buyerId: "u-buyer-1",
        amountPaise: 99900,
        status: "SUCCEEDED",
        gatewayPaymentId: "pay_rzp_1",
        recording: null,
      });
      await handleRecordingPurchaseSuccess(
        "order_rec_1",
        "pay_rzp_1",
        undefined,
        99900,
      );
      expect(mockRecordingPurchaseUpdateMany).not.toHaveBeenCalled();
      expect(mockPaymentCreate).not.toHaveBeenCalled();
      expect(mockCreateEarningsFromPayment).not.toHaveBeenCalled();
    });

    it("builds WebVTT caption tracks", () => {
      const vttUri = buildCaptionTrackDataUri("Key takeaways from the webinar");
      expect(vttUri.startsWith("data:text/vtt;charset=utf-8,")).toBe(true);
      expect(
        decodeURIComponent(vttUri.replace("data:text/vtt;charset=utf-8,", "")),
      ).toContain("Key takeaways from the webinar");
    });
  });
});
