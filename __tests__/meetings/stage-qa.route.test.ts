/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGuardMeetingRoute = jest.fn();
const mockFindUniqueUser = jest.fn();
const mockFindFirstParticipant = jest.fn();
const mockSendCallEvent = jest.fn();
const mockCallGet = jest.fn();
const mockCallUpdate = jest.fn();
const mockSendChatChannelMessage = jest.fn();
const mockCreateChannel = jest.fn();

jest.mock("../../lib/meetings/route-guard", () => ({
  guardMeetingRoute: (...args: unknown[]) => mockGuardMeetingRoute(...args),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: (...args: unknown[]) => mockFindUniqueUser(...args),
    },
    appointmentParticipant: {
      findFirst: (...args: unknown[]) => mockFindFirstParticipant(...args),
    },
  },
}));

jest.mock("../../actions/stream/chat/channel.action", () => ({
  createChannel: (...args: unknown[]) => mockCreateChannel(...args),
}));

jest.mock("../../lib/stream-client", () => ({
  withStreamCircuitBreaker: async <T>(fn: () => Promise<T>) => fn(),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
  isStreamConfigured: () => true,
  getStreamVideoClient: () => ({
    video: {
      call: () => ({
        sendCallEvent: (...args: unknown[]) => mockSendCallEvent(...args),
        get: (...args: unknown[]) => mockCallGet(...args),
        update: (...args: unknown[]) => mockCallUpdate(...args),
      }),
    },
  }),
  getStreamChatClient: () => ({
    channel: () => ({
      sendMessage: (...args: unknown[]) => mockSendChatChannelMessage(...args),
    }),
  }),
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

import { resetRedisForTesting } from "../../lib/redis";
import { GET, POST } from "../../app/api/meetings/[meetingId]/qa/route";
import {
  normalizeStageBannerFromCustomData,
  STAGE_QA_EVENT_TYPES,
} from "../../lib/meetings/stage-qa";
import { StreamUnavailableError } from "../../lib/stream-client";

function makeReq(body: unknown) {
  return new NextRequest(
    "http://localhost/api/meetings/occurrence-slot-webinar/qa",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function makeGetReq() {
  return new NextRequest(
    "http://localhost/api/meetings/occurrence-slot-webinar/qa",
    {
      method: "GET",
    },
  );
}

function mockMeetingAccess(opts: {
  userId: string;
  role: "host" | "participant";
  meetingId?: string;
  streamCallId?: string;
  appointmentType?: string;
  webinarId?: string;
}) {
  mockGuardMeetingRoute.mockResolvedValue({
    ok: true,
    userId: opts.userId,
    meetingId: opts.meetingId ?? "occurrence-slot-webinar",
    access: {
      role: opts.role,
      streamCallId: opts.streamCallId ?? "occurrence-slot-webinar",
      appointment: {
        id: "appt_1",
        appointmentType: opts.appointmentType ?? "WEBINAR",
        webinar: opts.webinarId ? { id: opts.webinarId } : undefined,
      },
    },
  });
}

describe("GET & POST /api/meetings/[meetingId]/qa", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRedisForTesting();
    mockSendCallEvent.mockResolvedValue({});
    mockSendChatChannelMessage.mockResolvedValue({
      message: { id: "stream_msg_1" },
    });
    mockCreateChannel.mockResolvedValue({});
    mockCallGet.mockResolvedValue({
      call: { custom: { organizationId: "org_wipro_123" } },
    });
    mockCallUpdate.mockResolvedValue({});
  });

  it("rejects Q&A actions on TRIAL sessions (403 trial_chat_disabled)", async () => {
    mockMeetingAccess({
      userId: "user_consultee",
      role: "participant",
      meetingId: "occurrence-slot-1",
      streamCallId: "occurrence-slot-1",
      appointmentType: "TRIAL",
    });

    const res = await POST(makeReq({ action: "ask", text: "Hello?" }), {
      params: Promise.resolve({ meetingId: "occurrence-slot-1" }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("trial_chat_disabled");
    expect(mockSendCallEvent).not.toHaveBeenCalled();
  });

  it("rejects invalid request payloads with 400 Bad Request", async () => {
    mockMeetingAccess({ userId: "user_abhinav", role: "participant" });

    const res = await POST(makeReq({ action: "ask", text: "   " }), {
      params: Promise.resolve({ meetingId: "occurrence-slot-webinar" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when Stream circuit breaker is open", async () => {
    mockMeetingAccess({ userId: "user_abhinav", role: "participant" });
    mockFindUniqueUser.mockResolvedValue({ name: "Abhinav" });
    mockSendCallEvent.mockRejectedValueOnce(new StreamUnavailableError());

    const res = await POST(makeReq({ action: "ask", text: "Ping?" }), {
      params: Promise.resolve({ meetingId: "occurrence-slot-webinar" }),
    });
    expect(res.status).toBe(503);
  });

  it("persists questions, toggles upvotes, records host replies, sends chat messages with emoji reactions, and hydrates via GET", async () => {
    mockMeetingAccess({
      userId: "user_abhinav",
      role: "participant",
      webinarId: "web_cohort_1",
    });
    mockFindUniqueUser.mockResolvedValue({
      name: "Abhinav Kumar",
      email: "abhinav@example.com",
    });

    const askRes = await POST(
      makeReq({
        action: "ask",
        text: "  How does Dynascale handle 1,000 webinar seats?  ",
      }),
      { params: Promise.resolve({ meetingId: "occurrence-slot-webinar" }) },
    );
    expect(askRes.status).toBe(200);
    const askJson = await askRes.json();
    expect(askJson.question.upvoterIds).toEqual([]);
    expect(askJson.question.status).toBe("open");

    const upvoteRes = await POST(
      makeReq({
        action: "toggle_upvote",
        questionId: askJson.question.id,
      }),
      { params: Promise.resolve({ meetingId: "occurrence-slot-webinar" }) },
    );
    const upvoteJson = await upvoteRes.json();
    expect(upvoteJson.question.upvoterIds).toEqual(["user_abhinav"]);

    const chatRes = await POST(
      makeReq({
        action: "send_chat",
        text: "Sharing architecture notes: https://familiarise.com/docs",
      }),
      { params: Promise.resolve({ meetingId: "occurrence-slot-webinar" }) },
    );
    expect(chatRes.status).toBe(200);
    const chatJson = await chatRes.json();
    expect(chatJson.message.text).toContain("https://familiarise.com/docs");
    expect(mockSendChatChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Sharing architecture notes: https://familiarise.com/docs",
        user_id: "user_abhinav",
      }),
    );

    const reactRes = await POST(
      makeReq({
        action: "toggle_reaction",
        messageId: chatJson.message.id,
        emoji: "🎉",
      }),
      { params: Promise.resolve({ meetingId: "occurrence-slot-webinar" }) },
    );
    const reactJson = await reactRes.json();
    expect(reactJson.message.reactions).toEqual({ "🎉": ["user_abhinav"] });

    mockMeetingAccess({
      userId: "user_host",
      role: "host",
      webinarId: "web_cohort_1",
    });
    mockFindUniqueUser.mockResolvedValue({ name: "Dr. Meera Host" });

    const answerRes = await POST(
      makeReq({
        action: "answer",
        questionId: askJson.question.id,
        answerText: "We shard media relays per region.",
      }),
      { params: Promise.resolve({ meetingId: "occurrence-slot-webinar" }) },
    );
    const answerJson = await answerRes.json();
    expect(answerJson.question.status).toBe("answered");
    expect(answerJson.question.answerText).toBe(
      "We shard media relays per region.",
    );

    const hydrateRes = await GET(makeGetReq(), {
      params: Promise.resolve({ meetingId: "occurrence-slot-webinar" }),
    });
    expect(hydrateRes.status).toBe(200);
    const hydrated = await hydrateRes.json();
    expect(hydrated.questions).toHaveLength(1);
    expect(hydrated.questions[0].status).toBe("answered");
    expect(hydrated.questions[0].upvoterIds).toEqual(["user_abhinav"]);
    expect(hydrated.messages).toHaveLength(1);
    expect(hydrated.messages[0].reactions).toEqual({ "🎉": ["user_abhinav"] });

    // Host reacting adds host user ID alongside participant; clicking again removes only host's reaction
    const addHostReactRes = await POST(
      makeReq({
        action: "toggle_reaction",
        messageId: chatJson.message.id,
        emoji: "🎉",
      }),
      { params: Promise.resolve({ meetingId: "occurrence-slot-webinar" }) },
    );
    expect((await addHostReactRes.json()).message.reactions).toEqual({
      "🎉": ["user_abhinav", "user_host"],
    });

    const removeHostReactRes = await POST(
      makeReq({
        action: "toggle_reaction",
        messageId: chatJson.message.id,
        emoji: "🎉",
      }),
      { params: Promise.resolve({ meetingId: "occurrence-slot-webinar" }) },
    );
    expect((await removeHostReactRes.json()).message.reactions).toEqual({
      "🎉": ["user_abhinav"],
    });

    const reopenRes = await POST(
      makeReq({
        action: "reopen",
        questionId: askJson.question.id,
      }),
      { params: Promise.resolve({ meetingId: "occurrence-slot-webinar" }) },
    );
    expect((await reopenRes.json()).question.status).toBe("open");
  });

  it("mirrors 1:1 CONSULTATION chat messages into canonical DM channel", async () => {
    mockGuardMeetingRoute.mockResolvedValue({
      ok: true,
      userId: "user_consultee_99",
      meetingId: "occurrence-consult-1",
      access: {
        role: "participant",
        streamCallId: "occurrence-consult-1",
        appointment: {
          id: "appt_consult_1",
          appointmentType: "CONSULTATION",
          consultation: {
            consultationPlan: {
              organizationId: null,
              consultantProfile: { userId: "user_consultant_1" },
            },
          },
        },
      },
    });
    mockFindFirstParticipant.mockResolvedValue({ userId: "user_consultee_99" });
    mockFindUniqueUser.mockResolvedValue({ name: "Consultee User" });

    const res = await POST(
      makeReq({ action: "send_chat", text: "Hello before screen share!" }),
      { params: Promise.resolve({ meetingId: "occurrence-consult-1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockCreateChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "messaging",
        members: ["user_consultant_1", "user_consultee_99"],
      }),
    );
  });

  it("blocks non-host participant from pinning, answering, or reopening questions (403 not_host)", async () => {
    mockMeetingAccess({ userId: "user_abhinav", role: "participant" });

    const res = await POST(
      makeReq({
        action: "pin",
        questionId: "qa_1",
      }),
      { params: Promise.resolve({ meetingId: "occurrence-slot-webinar" }) },
    );

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("not_host");
    expect(mockCallUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 question_not_found when host tries to pin an unknown questionId", async () => {
    mockMeetingAccess({ userId: "user_host", role: "host" });

    const res = await POST(
      makeReq({
        action: "pin",
        questionId: "qa_nonexistent",
      }),
      { params: Promise.resolve({ meetingId: "occurrence-slot-webinar" }) },
    );

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.reason).toBe("question_not_found");
    expect(mockCallUpdate).not.toHaveBeenCalled();
  });

  it("allows host/co-presenter to pin a server-stored question ON SCREEN while preserving custom.organizationId", async () => {
    mockMeetingAccess({ userId: "user_abhinav", role: "participant" });
    mockFindUniqueUser.mockResolvedValue({
      name: "Abhinav Kumar",
      email: "abhinav@example.com",
    });

    const askRes = await POST(
      makeReq({
        action: "ask",
        text: "Can you walk through the system design diagram again?",
      }),
      { params: Promise.resolve({ meetingId: "occurrence-slot-webinar" }) },
    );
    const askJson = await askRes.json();

    mockMeetingAccess({ userId: "user_host", role: "host" });

    const pinRes = await POST(
      makeReq({
        action: "pin",
        questionId: askJson.question.id,
      }),
      { params: Promise.resolve({ meetingId: "occurrence-slot-webinar" }) },
    );

    expect(pinRes.status).toBe(200);
    const json = await pinRes.json();
    expect(json.ok).toBe(true);
    expect(json.banner.questionId).toBe(askJson.question.id);
    expect(mockCallUpdate).toHaveBeenCalledWith({
      custom: {
        organizationId: "org_wipro_123",
        activeStageBanner: expect.objectContaining({
          questionId: askJson.question.id,
          authorName: "Abhinav Kumar",
        }),
      },
    });
    expect(mockSendCallEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        user_id: "user_host",
        custom: expect.objectContaining({
          type: STAGE_QA_EVENT_TYPES.BANNER_PINNED,
        }),
      }),
    );
  });

  it("allows host to clear the ON SCREEN banner via action: unpin", async () => {
    mockMeetingAccess({ userId: "user_host", role: "host" });

    const res = await POST(makeReq({ action: "unpin" }), {
      params: Promise.resolve({ meetingId: "occurrence-slot-webinar" }),
    });

    expect(res.status).toBe(200);
    expect(mockCallUpdate).toHaveBeenCalledWith({
      custom: {
        organizationId: "org_wipro_123",
        activeStageBanner: null,
      },
    });
  });

  it("normalizes activeStageBanner custom data safely for late joiners", () => {
    expect(normalizeStageBannerFromCustomData(null)).toBeNull();
    expect(
      normalizeStageBannerFromCustomData({ activeStageBanner: null }),
    ).toBeNull();
    expect(
      normalizeStageBannerFromCustomData({
        activeStageBanner: {
          questionId: "qa_9",
          text: "What is the cohort project deadline?",
          authorId: "u_1",
          authorName: "Rohan",
          authorRole: "participant",
        },
      }),
    ).toMatchObject({
      questionId: "qa_9",
      authorName: "Rohan",
      authorRole: "participant",
    });
  });
});
