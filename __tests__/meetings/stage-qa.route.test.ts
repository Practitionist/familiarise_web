/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGuardMeetingRoute = jest.fn();
const mockFindUniqueUser = jest.fn();
const mockSendCallEvent = jest.fn();
const mockCallGet = jest.fn();
const mockCallUpdate = jest.fn();

jest.mock("../../lib/meetings/route-guard", () => ({
  guardMeetingRoute: (...args: unknown[]) => mockGuardMeetingRoute(...args),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: (...args: unknown[]) => mockFindUniqueUser(...args),
    },
  },
}));

jest.mock("../../lib/stream-client", () => ({
  withStreamCircuitBreaker: async <T>(fn: () => Promise<T>) => fn(),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
  getStreamVideoClient: () => ({
    video: {
      call: () => ({
        sendCallEvent: (...args: unknown[]) => mockSendCallEvent(...args),
        get: (...args: unknown[]) => mockCallGet(...args),
        update: (...args: unknown[]) => mockCallUpdate(...args),
      }),
    },
  }),
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { POST } from "../../app/api/meetings/[meetingId]/qa/route";
import {
  normalizeStageBannerFromCustomData,
  STAGE_QA_EVENT_TYPES,
} from "../../lib/meetings/stage-qa";
import { StreamUnavailableError } from "../../lib/stream-client";

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/meetings/mtg_123/qa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/meetings/[meetingId]/qa", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendCallEvent.mockResolvedValue({});
    mockCallGet.mockResolvedValue({
      call: { custom: { organizationId: "org_wipro_123" } },
    });
    mockCallUpdate.mockResolvedValue({});
  });

  it("rejects Q&A actions on TRIAL sessions (403 trial_chat_disabled)", async () => {
    mockGuardMeetingRoute.mockResolvedValue({
      ok: true,
      userId: "user_consultee",
      meetingId: "mtg_trial",
      access: {
        role: "participant",
        streamCallId: "occurrence-slot-1",
        appointment: { appointmentType: "TRIAL" },
      },
    });

    const res = await POST(makeReq({ action: "ask", text: "Hello?" }), {
      params: Promise.resolve({ meetingId: "mtg_trial" }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("trial_chat_disabled");
    expect(mockSendCallEvent).not.toHaveBeenCalled();
  });

  it("rejects invalid request payloads with 400 Bad Request", async () => {
    mockGuardMeetingRoute.mockResolvedValue({
      ok: true,
      userId: "user_abhinav",
      meetingId: "mtg_webinar",
      access: {
        role: "participant",
        streamCallId: "occurrence-slot-webinar",
        appointment: { appointmentType: "WEBINAR" },
      },
    });

    const res = await POST(makeReq({ action: "ask", text: "   " }), {
      params: Promise.resolve({ meetingId: "mtg_webinar" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when Stream circuit breaker is open", async () => {
    mockGuardMeetingRoute.mockResolvedValue({
      ok: true,
      userId: "user_abhinav",
      meetingId: "mtg_webinar",
      access: {
        role: "participant",
        streamCallId: "occurrence-slot-webinar",
        appointment: { appointmentType: "WEBINAR" },
      },
    });
    mockFindUniqueUser.mockResolvedValue({ name: "Abhinav" });
    mockSendCallEvent.mockRejectedValueOnce(new StreamUnavailableError());

    const res = await POST(makeReq({ action: "ask", text: "Ping?" }), {
      params: Promise.resolve({ meetingId: "mtg_webinar" }),
    });
    expect(res.status).toBe(503);
  });

  it("allows participant to submit a question with server-verified identity", async () => {
    mockGuardMeetingRoute.mockResolvedValue({
      ok: true,
      userId: "user_abhinav",
      meetingId: "mtg_webinar",
      access: {
        role: "participant",
        streamCallId: "occurrence-slot-webinar",
        appointment: { appointmentType: "WEBINAR" },
      },
    });
    mockFindUniqueUser.mockResolvedValue({
      name: "Abhinav Kumar",
      email: "abhinav@example.com",
    });

    const res = await POST(
      makeReq({
        action: "ask",
        text: "  How does Dynascale handle 1,000 webinar seats?  ",
      }),
      { params: Promise.resolve({ meetingId: "mtg_webinar" }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.question.text).toBe(
      "How does Dynascale handle 1,000 webinar seats?",
    );
    expect(json.question.authorName).toBe("Abhinav Kumar");
    expect(json.question.authorRole).toBe("participant");
    expect(mockSendCallEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user_abhinav",
        custom: expect.objectContaining({
          type: STAGE_QA_EVENT_TYPES.QUESTION_ASKED,
        }),
      }),
    );
  });

  it("blocks non-host participant from pinning or unpinning stage banners (403 not_host)", async () => {
    mockGuardMeetingRoute.mockResolvedValue({
      ok: true,
      userId: "user_abhinav",
      meetingId: "mtg_webinar",
      access: {
        role: "participant",
        streamCallId: "occurrence-slot-webinar",
        appointment: { appointmentType: "WEBINAR" },
      },
    });

    const res = await POST(
      makeReq({
        action: "pin",
        questionId: "qa_1",
        text: "Spoofed banner",
        authorId: "user_abhinav",
        authorName: "Abhinav",
        authorRole: "participant",
      }),
      { params: Promise.resolve({ meetingId: "mtg_webinar" }) },
    );

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("not_host");
    expect(mockCallUpdate).not.toHaveBeenCalled();
  });

  it("allows host/co-presenter to pin a question ON SCREEN while preserving custom.organizationId", async () => {
    mockGuardMeetingRoute.mockResolvedValue({
      ok: true,
      userId: "user_host",
      meetingId: "mtg_webinar",
      access: {
        role: "host",
        streamCallId: "occurrence-slot-webinar",
        appointment: { appointmentType: "WEBINAR" },
      },
    });

    const res = await POST(
      makeReq({
        action: "pin",
        questionId: "qa_42",
        text: "Can you walk through the system design diagram again?",
        authorId: "user_abhinav",
        authorName: "Abhinav Kumar",
        authorRole: "participant",
      }),
      { params: Promise.resolve({ meetingId: "mtg_webinar" }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.banner.questionId).toBe("qa_42");
    expect(mockCallUpdate).toHaveBeenCalledWith({
      custom: {
        organizationId: "org_wipro_123",
        activeStageBanner: expect.objectContaining({
          questionId: "qa_42",
          authorName: "Abhinav Kumar",
        }),
      },
    });
    expect(mockSendCallEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user_host",
        custom: expect.objectContaining({
          type: STAGE_QA_EVENT_TYPES.BANNER_PINNED,
        }),
      }),
    );
  });

  it("allows host to clear the ON SCREEN banner via action: unpin", async () => {
    mockGuardMeetingRoute.mockResolvedValue({
      ok: true,
      userId: "user_host",
      meetingId: "mtg_webinar",
      access: {
        role: "host",
        streamCallId: "occurrence-slot-webinar",
        appointment: { appointmentType: "WEBINAR" },
      },
    });

    const res = await POST(makeReq({ action: "unpin" }), {
      params: Promise.resolve({ meetingId: "mtg_webinar" }),
    });

    expect(res.status).toBe(200);
    expect(mockCallUpdate).toHaveBeenCalledWith({
      custom: {
        organizationId: "org_wipro_123",
        activeStageBanner: null,
      },
    });
    expect(mockSendCallEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user_host",
        custom: expect.objectContaining({
          type: STAGE_QA_EVENT_TYPES.BANNER_UNPINNED,
        }),
      }),
    );
  });

  it("normalizes activeStageBanner custom data safely for late joiners", () => {
    expect(normalizeStageBannerFromCustomData(null)).toBeNull();
    expect(normalizeStageBannerFromCustomData({ activeStageBanner: null })).toBeNull();
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
