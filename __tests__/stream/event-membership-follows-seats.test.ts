/**
 * @jest-environment node
 */

/**
 * A registration syncs the event's chat and call from seats holding access
 * (`paidParticipant`), never from payments, which outlive the seat they bought,
 * and fences what it granted so a seat that ends mid-sync is taken back.
 */

import { matchesWhere, type Row, type Where } from "../fixtures/mem-db";

const mockChat = new Set<string>();
const mockCall = new Set<string>();
const mockState: {
  channelExists: boolean;
  meetings: { streamCallId: string }[];
  adds: string[];
  onAdd: (ids: string[]) => void;
  onCreate: () => void;
  failRemainder: boolean;
  collabEnded: boolean;
} = {
  failRemainder: false,
  collabEnded: false,
  channelExists: true,
  meetings: [],
  adds: [],
  onAdd: () => undefined,
  onCreate: () => undefined,
};
const mockAppointmentUpdateMany = jest.fn();
const mockCreateDirectMessageChannel = jest.fn();
const mockAppointmentFindUnique = jest.fn();
const mockEventFindUnique = jest.fn();
const mockParticipantFindMany = jest.fn();
const mockIntentCreateMany = jest.fn();

const memberIds = (spec: unknown[] = []) =>
  spec.map((m) =>
    typeof m === "string" ? m : (m as { user_id: string }).user_id,
  );

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findUnique: (args: unknown) => mockAppointmentFindUnique(args),
      updateMany: (args: unknown) => mockAppointmentUpdateMany(args),
    },
    appointmentParticipant: {
      findMany: (args: unknown) => mockParticipantFindMany(args),
    },
    webinar: { findUnique: (args: unknown) => mockEventFindUnique(args) },
    class: { findUnique: (args: unknown) => mockEventFindUnique(args) },
    // The roster's collaborator is on the team at the re-check unless a test ends it.
    collaborator: {
      findFirst: async (args: {
        where: { consultantProfile?: { userId?: string } };
      }) =>
        args.where.consultantProfile?.userId === "collab" &&
        !mockState.collabEnded
          ? { id: "c-1" }
          : null,
    },
    user: { findMany: async () => [] },
    meeting: { findMany: async () => mockState.meetings },
    streamRevocationRetry: {
      updateMany: async () => ({ count: 0 }),
      createMany: (args: unknown) => mockIntentCreateMany(args),
      findMany: async () => [],
    },
  },
}));

jest.mock("@/lib/stream-client", () => ({
  getStreamChatClient: () => ({
    channel: (_type: string, _id: string, data?: { members?: unknown[] }) => ({
      addMembers: async (spec: unknown[]) => {
        if (!mockState.channelExists) throw new Error("channel not found");
        if (mockState.failRemainder && spec.length > 1) {
          throw new Error("429 rate limited");
        }
        const ids = memberIds(spec);
        mockState.onAdd(ids);
        mockState.adds.push(...ids);
        ids.forEach((id) => mockChat.add(id));
        return {};
      },
      removeMembers: async (ids: string[]) => {
        ids.forEach((id) => mockChat.delete(id));
        return {};
      },
      create: async () => {
        mockState.onCreate();
        mockState.channelExists = true;
        memberIds(data?.members).forEach((id) => mockChat.add(id));
        return {};
      },
      assignRoles: async () => ({}),
    }),
  }),
  getStreamVideoClient: () => ({
    video: {
      call: () => ({
        updateCallMembers: async (req: {
          update_members?: { user_id: string }[];
          remove_members?: string[];
        }) => {
          req.update_members?.forEach((m) => mockCall.add(m.user_id));
          req.remove_members?.forEach((id) => mockCall.delete(id));
          return {};
        },
        get: async () => ({ call: { ended_at: null } }),
      }),
    },
  }),
  withStreamCircuitBreaker: (fn: () => unknown) => fn(),
  isExpectedStreamError: () => false,
  isStreamConfigured: () => true,
  streamHttpStatus: () => null,
  streamErrorCode: () => null,
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

jest.mock("@/lib/stream/dm-eligibility", () => ({
  ...jest.requireActual("@/lib/stream/dm-eligibility"),
  isDmContextEligible: async () => false,
}));

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { ensureChannelsForAppointment } from "@/lib/payments/webhooks/ensure-channels";
import { addUserToEventChannel } from "@/lib/stream/event-channel-service";
import { DmNotPermittedError } from "@/lib/stream/dm-eligibility";
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
  appointmentId: "appt-1",
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
  consultantProfile: { userId: "host", user: { id: "host" } },
  collaborators: [
    {
      role: "CO_HOST",
      tier: "PRESENTER",
      consultantProfile: { userId: "collab" },
    },
  ],
};

function arrange(kind: "WEBINAR" | "CLASS", seats: Row[]) {
  const pick = (where: Where) =>
    seats
      .filter((s) => matchesWhere(s, where))
      .map((s) => ({ userId: s.userId }));
  const planKey = kind === "WEBINAR" ? "webinarPlan" : "classPlan";
  const event = { id: "event-1", status: "SCHEDULED", [planKey]: plan };
  mockParticipantFindMany.mockImplementation(async (args: { where: Where }) =>
    pick(args.where),
  );
  mockEventFindUnique.mockImplementation(
    async (args: {
      include: { appointment: { include: { participants: { where: Where } } } };
    }) => ({
      ...event,
      appointment: {
        id: "appt-1",
        organizationId: null,
        participants: pick(args.include.appointment.include.participants.where),
      },
    }),
  );
  mockAppointmentFindUnique.mockImplementation(
    async (args: { select: { participants?: { where: Where } } }) => {
      const base = {
        id: "appt-1",
        deletedAt: null,
        organizationId: null,
        occurrences: [],
        consultation: null,
        subscription: null,
        trial: null,
        webinar: kind === "WEBINAR" ? event : null,
        class: kind === "CLASS" ? event : null,
      };
      // The fence's seat context reads the same row without the roster.
      if (!args.select.participants) return base;
      return {
        ...base,
        appointmentType: kind,
        // Every buyer's payment is still SUCCEEDED, as it is after a leave or a refund.
        payment: seats
          .filter((s) => s.role === "CONSULTEE")
          .map((s) => ({ userId: s.userId })),
        participants: pick(args.select.participants.where),
      };
    },
  );
}

/** The leave commits, and its own revocation runs, just before the sync's grant lands. */
const endSeat = (seats: Row[], userId: string) => () => {
  const row = seats.find((s) => s.userId === userId);
  if (row) row.status = "CANCELLED";
};

describe("event chat and call membership follows seats holding access", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChat.clear();
    mockCall.clear();
    mockState.channelExists = true;
    mockState.meetings = [{ streamCallId: "call-1" }];
    mockState.adds = [];
    mockState.onAdd = () => undefined;
    mockState.onCreate = () => undefined;
    mockState.failRemainder = false;
    mockState.collabEnded = false;
    mockAppointmentUpdateMany.mockResolvedValue({ count: 1 });
  });

  it.each([
    ["WEBINAR", "free", pay({ amountPaise: 0, isMockPayment: true })],
    ["WEBINAR", "paid", pay({ amountPaise: 50_000 })],
    ["CLASS", "free", pay({ amountPaise: 0, isMockPayment: true })],
    ["CLASS", "paid", pay({ amountPaise: 50_000 })],
  ] as const)(
    "a %s registration (%s) adds each live seat once to the chat, the DMs and the call",
    async (kind, _path, newcomerPayment) => {
      arrange(kind, seatsWith(newcomerPayment));

      await expect(ensureChannelsForAppointment("appt-1")).resolves.toEqual({
        ensured: true,
      });

      expect(mockState.adds).toEqual(["stays", "newcomer"]);
      expect([...mockChat].sort()).toEqual(["newcomer", "stays"]);
      expect([...mockCall].sort()).toEqual(["newcomer", "stays"]);
      const dmUsers = mockCreateDirectMessageChannel.mock.calls.map(
        (c) => c[1],
      );
      expect(dmUsers).toEqual(["stays", "newcomer"]);
      expect(mockIntentCreateMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["no open call", false],
    ["an open call", true],
  ] as const)(
    "a seat that ends mid-sync is taken back from chat and rooms with %s",
    async (_label, callOpen) => {
      const seats = seatsWith(pay());
      arrange("WEBINAR", seats);
      mockState.meetings = callOpen ? [{ streamCallId: "call-1" }] : [];
      mockState.onAdd = (ids) => {
        if (ids.includes("stays")) endSeat(seats, "stays")();
      };

      await ensureChannelsForAppointment("appt-1");

      expect([...mockChat]).toEqual(["newcomer"]);
      expect([...mockCall]).toEqual(callOpen ? ["newcomer"] : []);
      expect(mockIntentCreateMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ userId: "stays", planId: "appt-1" })],
        skipDuplicates: true,
      });
      // One batched seat read for every buyer the sync granted.
      expect(mockParticipantFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: { in: ["stays", "newcomer"] },
          }),
        }),
      );
    },
  );

  it.each(["WEBINAR", "CLASS"] as const)(
    "a %s channel created on registration holds the host, collaborators and live seats only",
    async (kind) => {
      arrange(kind, seatsWith(pay()));
      mockState.channelExists = false;

      await ensureChannelsForAppointment("appt-1");

      expect([...mockChat].sort()).toEqual([
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

      expect([...mockChat].sort()).toEqual([
        "collab",
        "host",
        "newcomer",
        "stays",
      ]);
      for (const ended of ENDED) expect(mockChat).not.toContain(ended);
    },
  );
  it("a refused host DM takes back the ended seat and still provisions the other attendees", async () => {
    const seats = seatsWith(pay());
    arrange("WEBINAR", seats);
    mockState.meetings = [];
    mockState.onAdd = (ids) => {
      if (ids.includes("stays")) endSeat(seats, "stays")();
    };
    mockCreateDirectMessageChannel.mockImplementation(
      async (_host: string, userId: string) => {
        if (userId === "stays") throw new DmNotPermittedError("host", userId);
      },
    );

    await expect(ensureChannelsForAppointment("appt-1")).resolves.toEqual({
      ensured: true,
    });

    expect([...mockChat]).toEqual(["newcomer"]);
    expect(mockCreateDirectMessageChannel.mock.calls.map((c) => c[1])).toEqual([
      "stays",
      "newcomer",
    ]);
    expect(mockIntentCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ userId: "stays", planId: "appt-1" })],
      skipDuplicates: true,
    });
  });

  it.each(["WEBINAR", "CLASS"] as const)(
    "a %s with no seat holding access is stamped done, so the repair queue does not retry it",
    async (kind) => {
      arrange(
        kind,
        seatsWith(pay()).filter(
          (s) => s.userId !== "stays" && s.userId !== "newcomer",
        ),
      );

      await expect(ensureChannelsForAppointment("appt-1")).resolves.toEqual({
        ensured: true,
        skipped: "no_seat_holding_access",
      });

      expect(mockAppointmentUpdateMany).toHaveBeenCalledWith({
        where: { id: "appt-1", chatChannelEnsuredAt: null },
        data: { chatChannelEnsuredAt: expect.any(Date) },
      });
      expect(mockChat.size).toBe(0);
    },
  );

  it.each([
    ["WEBINAR", createWebinarChannel],
    ["CLASS", createClassChannel],
  ] as const)(
    "the %s create route takes back a seat that ended while the channel was created",
    async (kind, create) => {
      const seats = seatsWith(pay());
      arrange(kind, seats);
      mockState.channelExists = false;
      mockState.onCreate = endSeat(seats, "stays");

      await create("event-1", null);

      expect([...mockChat].sort()).toEqual(["collab", "host", "newcomer"]);
      expect(mockIntentCreateMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ userId: "stays", planId: "appt-1" })],
        skipDuplicates: true,
      });
    },
  );

  it("a first join that creates the channel takes back a seat that ended meanwhile", async () => {
    const seats = seatsWith(pay());
    arrange("CLASS", seats);
    mockState.channelExists = false;
    mockState.onCreate = endSeat(seats, "stays");

    await addUserToEventChannel("class", "event-1", "newcomer");

    expect([...mockChat].sort()).toEqual(["collab", "host", "newcomer"]);
  });
  it("a first join that creates the channel takes back a collaborator removed meanwhile", async () => {
    arrange("CLASS", seatsWith(pay()));
    mockState.channelExists = false;
    mockState.onCreate = () => {
      mockState.collabEnded = true;
    };

    await addUserToEventChannel("class", "event-1", "newcomer");

    expect(mockChat.has("collab")).toBe(false);
    expect(mockIntentCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ kind: "COLLAB_REVOKE", userId: "collab" }),
      ],
      skipDuplicates: true,
    });
  });
  it("a first join whose remainder add throws still takes back an ended seat from the first chunk", async () => {
    const seats = [
      ...seatsWith(pay()),
      ...Array.from({ length: 120 }, (_, i) =>
        seat(`extra-${i}`, "CONFIRMED", pay()),
      ),
    ];
    arrange("WEBINAR", seats);
    mockState.channelExists = false;
    mockState.onCreate = endSeat(seats, "stays");
    mockState.failRemainder = true;

    await expect(
      addUserToEventChannel("webinar", "event-1", "newcomer"),
    ).rejects.toThrow("429");

    expect(mockChat).not.toContain("stays");
    expect(mockIntentCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ userId: "stays", planId: "appt-1" })],
      skipDuplicates: true,
    });
  });

  it("a chat open by someone whose seat already ended takes them back out of the new channel", async () => {
    arrange("WEBINAR", seatsWith(pay()));
    mockState.channelExists = false;

    await addUserToEventChannel("webinar", "event-1", "left");

    expect([...mockChat].sort()).toEqual([
      "collab",
      "host",
      "newcomer",
      "stays",
    ]);
  });

  it("a chat open into an existing channel takes the caller back when their seat ends meanwhile", async () => {
    const seats = seatsWith(pay());
    arrange("CLASS", seats);
    mockState.onAdd = (ids) => {
      if (ids.includes("stays")) endSeat(seats, "stays")();
    };

    await addUserToEventChannel("class", "event-1", "stays");

    expect(mockChat).not.toContain("stays");
    expect(mockIntentCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ userId: "stays", planId: "appt-1" })],
      skipDuplicates: true,
    });
  });
  it("a chat open whose revocation owner cannot be read is refused before anything is written", async () => {
    const seats = seatsWith(pay());
    arrange("CLASS", seats);
    mockState.onAdd = (ids) => {
      if (ids.includes("stays")) endSeat(seats, "stays")();
    };
    const appointmentRead = mockAppointmentFindUnique.getMockImplementation();
    mockAppointmentFindUnique.mockImplementation(
      async (args: { where: { classId?: string } }) => {
        if (args.where.classId) {
          throw new Error("canceling statement due to statement timeout");
        }
        return appointmentRead?.(args);
      },
    );

    await expect(
      addUserToEventChannel("class", "event-1", "stays"),
    ).resolves.toEqual({
      success: false,
      channelId: "class-event-1",
      reason: "member_not_added",
    });

    expect(mockState.adds).toEqual([]);
    expect(mockChat).not.toContain("stays");
  });
});
