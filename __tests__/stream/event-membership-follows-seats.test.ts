/**
 * @jest-environment node
 */

/**
 * A registration syncs the event's chat and call from seats holding access
 * (`paidParticipant`), never from payments, which outlive the seat they bought.
 */

import { matchesWhere, type Row, type Where } from "../fixtures/mem-db";

const mockStreamMembers = new Set<string>();
const mockState = { channelExists: true };
const mockAddSeatHoldersToOpenCalls = jest.fn();
const mockCreateDirectMessageChannel = jest.fn();
const mockAppointmentFindUnique = jest.fn();
const mockEventFindUnique = jest.fn();

const memberIds = (spec: unknown[] = []) =>
  spec.map((m) =>
    typeof m === "string" ? m : (m as { user_id: string }).user_id,
  );

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findUnique: (args: unknown) => mockAppointmentFindUnique(args),
      updateMany: async () => ({ count: 1 }),
    },
    webinar: { findUnique: (args: unknown) => mockEventFindUnique(args) },
    class: { findUnique: (args: unknown) => mockEventFindUnique(args) },
    collaborator: { findFirst: async () => null },
  },
}));

jest.mock("@/lib/stream-client", () => ({
  getStreamChatClient: () => ({
    channel: (_type: string, _id: string, data?: { members?: unknown[] }) => ({
      addMembers: async (spec: unknown[]) => {
        if (!mockState.channelExists) throw new Error("channel not found");
        memberIds(spec).forEach((id) => mockStreamMembers.add(id));
        return {};
      },
      create: async () => {
        mockState.channelExists = true;
        memberIds(data?.members).forEach((id) => mockStreamMembers.add(id));
        return {};
      },
      assignRoles: async () => ({}),
    }),
  }),
  withStreamCircuitBreaker: (fn: () => unknown) => fn(),
  isExpectedStreamError: () => false,
  StreamUnavailableError: class extends Error {},
}));

jest.mock("@/lib/stream-cache", () => ({
  isChannelCached: () => undefined,
  markChannelExists: () => undefined,
  getMembershipCached: () => undefined,
  markMembership: () => undefined,
}));

jest.mock("@/actions/stream/chat/user.action", () => ({
  upsertUserToStream: async () => ({}),
  upsertUsersToStream: async () => ({ droppedIds: [] }),
}));

jest.mock("@/actions/stream/chat/channel.action", () => ({
  ...jest.requireActual("@/actions/stream/chat/channel.action"),
  createDirectMessageChannel: (...args: unknown[]) =>
    mockCreateDirectMessageChannel(...args),
}));

jest.mock("@/lib/meetings/seat-call-members", () => ({
  addSeatHoldersToOpenCalls: (...args: unknown[]) =>
    mockAddSeatHoldersToOpenCalls(...args),
}));

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { ensureChannelsForAppointment } from "@/lib/payments/webhooks/ensure-channels";
import {
  createClassChannel,
  createWebinarChannel,
} from "@/actions/stream/chat/channel.action";

const pay = (over: Row = {}): Row => ({
  paymentStatus: "SUCCEEDED",
  description: null,
  refundOwedKey: null,
  refunds: [],
  ...over,
});
const seat = (userId: string, status: string, payment: Row | null): Row => ({
  userId,
  role: "CONSULTEE",
  status,
  paymentId: payment ? `pay-${userId}` : null,
  payment,
});

const ENDED = ["left", "removed", "refunded", "lapsed-hold", "auto-refunded"];

function seatsWith(newcomerPayment: Row): Row[] {
  return [
    { ...seat("host", "CONFIRMED", null), role: "CONSULTANT" },
    seat("stays", "CONFIRMED", pay()),
    seat("left", "CANCELLED", pay({ amountPaise: 0 })),
    seat("removed", "CANCELLED", pay()),
    seat("refunded", "REFUNDED", pay({ refunds: [{ status: "SUCCEEDED" }] })),
    seat("lapsed-hold", "HELD", pay({ paymentStatus: "EXPIRED" })),
    seat("auto-refunded", "HELD", pay({ refundOwedKey: "capture:x" })),
    seat("newcomer", "CONFIRMED", newcomerPayment),
  ];
}

const plan = {
  title: "Event",
  organizationId: null,
  consultantProfile: { user: { id: "host" } },
  collaborators: [{ role: "CO_HOST", consultantProfile: { userId: "collab" } }],
};

function arrange(kind: "WEBINAR" | "CLASS", seats: Row[]) {
  const pick = (where: Where) =>
    seats
      .filter((s) => matchesWhere(s, where))
      .map((s) => ({ userId: s.userId }));
  const planKey = kind === "WEBINAR" ? "webinarPlan" : "classPlan";
  mockEventFindUnique.mockImplementation(
    async (args: {
      include: { appointment: { include: { participants: { where: Where } } } };
    }) => ({
      id: "event-1",
      status: "SCHEDULED",
      [planKey]: plan,
      appointment: {
        organizationId: null,
        participants: pick(args.include.appointment.include.participants.where),
      },
    }),
  );
  mockAppointmentFindUnique.mockImplementation(
    async (args: { select: { participants: { where: Where } } }) => ({
      id: "appt-1",
      appointmentType: kind,
      organizationId: null,
      // Every buyer's payment is still SUCCEEDED, as it is after a leave or a refund.
      payment: seats
        .filter((s) => s.role === "CONSULTEE")
        .map((s) => ({ userId: s.userId })),
      participants: pick(args.select.participants.where),
      consultation: null,
      subscription: null,
      webinar:
        kind === "WEBINAR"
          ? {
              id: "event-1",
              webinarPlan: {
                organizationId: null,
                consultantProfile: { userId: "host" },
              },
            }
          : null,
      class:
        kind === "CLASS"
          ? {
              id: "event-1",
              classPlan: {
                organizationId: null,
                consultantProfile: { userId: "host" },
              },
            }
          : null,
      trial: null,
    }),
  );
}

describe("event chat and call membership follows seats holding access", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStreamMembers.clear();
  });

  it.each([
    ["WEBINAR", "free", pay({ amountPaise: 0, isMockPayment: true })],
    ["WEBINAR", "paid", pay({ amountPaise: 50_000 })],
    ["CLASS", "free", pay({ amountPaise: 0, isMockPayment: true })],
    ["CLASS", "paid", pay({ amountPaise: 50_000 })],
  ] as const)(
    "a %s registration (%s) adds only live seats to the chat, the DMs and the call",
    async (kind, _path, newcomerPayment) => {
      arrange(kind, seatsWith(newcomerPayment));
      mockState.channelExists = true;

      await expect(ensureChannelsForAppointment("appt-1")).resolves.toEqual({
        ensured: true,
      });

      expect([...mockStreamMembers].sort()).toEqual(["newcomer", "stays"]);
      expect(mockAddSeatHoldersToOpenCalls).toHaveBeenCalledWith("appt-1", [
        "stays",
        "newcomer",
      ]);
      const dmUsers = mockCreateDirectMessageChannel.mock.calls.map(
        (c) => c[1],
      );
      expect(dmUsers).toEqual(["stays", "newcomer"]);
    },
  );

  it.each(["WEBINAR", "CLASS"] as const)(
    "a %s channel created on registration holds the host, collaborators and live seats only",
    async (kind) => {
      arrange(kind, seatsWith(pay()));
      mockState.channelExists = false;

      await ensureChannelsForAppointment("appt-1");

      expect([...mockStreamMembers].sort()).toEqual([
        "collab",
        "host",
        "newcomer",
        "stays",
      ]);
    },
  );

  it.each([
    ["WEBINAR", createWebinarChannel],
    ["CLASS", createClassChannel],
  ] as const)(
    "the %s create route seeds the same roster",
    async (kind, create) => {
      arrange(kind, seatsWith(pay()));
      mockState.channelExists = false;

      await create("event-1", null);

      expect([...mockStreamMembers].sort()).toEqual([
        "collab",
        "host",
        "newcomer",
        "stays",
      ]);
      for (const ended of ENDED) expect(mockStreamMembers).not.toContain(ended);
    },
  );
});
