/**
 * @jest-environment node
 *
 * The booking tag is verified server-side: it answers only when both people in
 * the DM are parties to the appointment, picks the next (else last) session,
 * and opening a DM posts nothing and needs a shared booking scope.
 */
import { NextRequest } from "next/server";
import { pickSessionAnchor } from "@/lib/stream/booking-tag";

let mockUserId = "consultee-u";
let mockMembers: string[] = [];
const mockFindFirst = jest.fn();
const mockEligible = jest.fn<Promise<boolean>, [string, string, string]>();
const mockSendMessage = jest.fn(async () => ({}));
const mockContexts = jest.fn();

jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({
    session: { user: { id: mockUserId, role: "USER" } },
  }),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  streamApiLimiter: {},
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
  },
}));
jest.mock("../../lib/appointments/occurrences", () => ({
  liveOccurrenceWhere: {},
}));
jest.mock("../../lib/stream/dm-eligibility", () => ({
  ...jest.requireActual("../../lib/stream/dm-eligibility"),
  pairBookingContexts: () => mockContexts(),
  isDmChannelIdEligible: (a: string, b: string, channelId: string) =>
    mockEligible(a, b, channelId),
}));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  createCollaboratorChannel: jest.fn(),
  createDirectMessageChannel: async () => ({
    channelId: "dm-consultee-u-expert-u",
  }),
}));
jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUsersToStream: jest.fn(async () => ({})),
  upsertUserToStream: jest.fn(),
}));
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: () => ({
    queryChannels: async () => [
      {
        state: {
          members: Object.fromEntries(mockMembers.map((id) => [id, {}])),
        },
      },
    ],
    channel: () => ({ sendMessage: mockSendMessage }),
    upsertUser: jest.fn(),
  }),
  withStreamCircuitBreaker: <T>(fn: () => Promise<T>) => fn(),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
  isExpectedStreamError: () => false,
}));

const CID = "messaging:dm-consultee-u-expert-u";
const at = (iso: string) => new Date(iso);

const consultation = {
  id: "apt-1",
  appointmentType: "CONSULTATION",
  occurrences: [
    {
      startsAt: at("2026-10-20T10:00:00Z"),
      endsAt: at("2026-10-20T11:00:00Z"),
    },
    {
      startsAt: at("2099-01-02T10:00:00Z"),
      endsAt: at("2099-01-02T11:00:00Z"),
    },
  ],
  participants: [],
  consultation: {
    status: "SCHEDULED",
    requestedBy: { userId: "consultee-u" },
    consultationPlan: {
      title: "Career coaching",
      consultantProfile: { userId: "expert-u" },
    },
  },
  subscription: null,
  webinar: null,
  class: null,
};

async function getTag(query: Record<string, string>) {
  const { GET } = await import("../../app/api/stream/booking-tag/route");
  const url = new URL("http://localhost/api/stream/booking-tag");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return GET(new NextRequest(url));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUserId = "consultee-u";
  mockMembers = ["consultee-u", "expert-u", "familiarise-support"];
  mockFindFirst.mockResolvedValue(consultation);
  mockEligible.mockResolvedValue(true);
  mockContexts.mockResolvedValue({ personalAllowed: true, organizations: [] });
});

describe("GET /api/stream/booking-tag", () => {
  it("answers the verified title and next session for the two parties", async () => {
    const res = await getTag({ appointmentId: "apt-1", cid: CID });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      title: "Career coaching",
      kind: "CONSULTATION",
      nextSessionAt: "2099-01-02T10:00:00.000Z",
      lastSessionAt: null,
    });
    expect(mockEligible).toHaveBeenCalledWith(
      "consultee-u",
      "expert-u",
      "dm-consultee-u-expert-u",
    );
  });

  it("refuses when the other DM member is not a party", async () => {
    mockMembers = ["consultee-u", "stranger-u"];
    expect((await getTag({ appointmentId: "apt-1", cid: CID })).status).toBe(
      404,
    );
  });

  it("refuses when the caller is not a party", async () => {
    mockUserId = "stranger-u";
    mockMembers = ["stranger-u", "expert-u"];
    expect((await getTag({ appointmentId: "apt-1", cid: CID })).status).toBe(
      404,
    );
  });

  it("refuses a DM scope the pair cannot open, and a malformed cid", async () => {
    mockEligible.mockResolvedValue(false);
    expect((await getTag({ appointmentId: "apt-1", cid: CID })).status).toBe(
      404,
    );
    expect(
      (await getTag({ appointmentId: "apt-1", cid: "team:class-1" })).status,
    ).toBe(400);
  });
});

describe("pickSessionAnchor", () => {
  const now = at("2026-10-26T12:00:00Z");
  const slot = (start: string, end: string) => ({
    startsAt: at(start),
    endsAt: at(end),
  });

  it("picks the earliest session not yet over, an ongoing one included", () => {
    expect(
      pickSessionAnchor(
        [
          slot("2026-11-02T10:00:00Z", "2026-11-02T11:00:00Z"),
          slot("2026-10-26T11:30:00Z", "2026-10-26T12:30:00Z"),
          slot("2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z"),
        ],
        now,
      ),
    ).toEqual({
      nextSessionAt: "2026-10-26T11:30:00.000Z",
      lastSessionAt: null,
    });
  });

  it("falls back to the latest session when every one is past", () => {
    expect(
      pickSessionAnchor(
        [
          slot("2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z"),
          slot("2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z"),
        ],
        now,
      ),
    ).toEqual({
      nextSessionAt: null,
      lastSessionAt: "2026-10-20T10:00:00.000Z",
    });
    expect(pickSessionAnchor([], now)).toEqual({
      nextSessionAt: null,
      lastSessionAt: null,
    });
  });
});

async function openDm(body: Record<string, unknown>) {
  const { POST } = await import("../../app/api/stream/channels/open/route");
  return POST(
    new NextRequest("http://localhost/api/stream/channels/open", {
      method: "POST",
      body: JSON.stringify({
        kind: "dm",
        counterpartyUserId: "expert-u",
        ...body,
      }),
    }),
  );
}

it("opening a DM with an appointment context posts nothing", async () => {
  const res = await openDm({ contextAppointmentId: "apt-1" });
  expect(res.status).toBe(200);
  expect(mockSendMessage).not.toHaveBeenCalled();
  expect(mockFindFirst).not.toHaveBeenCalled();
});

it("refuses a DM open when the pair shares no booking scope", async () => {
  mockContexts.mockResolvedValue({ personalAllowed: false, organizations: [] });
  expect((await openDm({})).status).toBe(403);
});
