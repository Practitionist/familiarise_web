/** @jest-environment node */

// PATCH /api/collaborations/[id]/respond: the signed-in expert answers their
// own invitation; an accept must name the terms they saw.

const mockSession = jest.fn();
const mockRespond = jest.fn();
jest.mock("@/lib/auth-server", () => ({ getSession: () => mockSession() }));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("@/lib/collaborators/notifications", () => ({}));
jest.mock("@/lib/stream/collaborator-access", () => ({}));
jest.mock("@/lib/stream/access-revocation", () => ({}));
jest.mock("@/lib/collaborators/service", () => ({
  ...jest.requireActual("@/lib/collaborators/service"),
  respondToInvitation: (...args: unknown[]) => mockRespond(...args),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockWorld.db;
  },
}));

import { NextRequest } from "next/server";
import { PATCH } from "@/app/api/collaborations/[id]/respond/route";
import { CollaborationError } from "@/lib/collaborators/service";
import { BookingLockUnavailableError } from "@/utils/appointmentlock";
import { collaborationWorld } from "../fixtures/collaboration-world";

const mockWorld = collaborationWorld();

const signIn = (userId: string | null) =>
  mockSession.mockResolvedValue(userId ? { user: { id: userId } } : null);
const respond = (body: unknown, id = "c-invitee") =>
  PATCH(
    new NextRequest("http://localhost/api/collaborations/respond", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

/** A refusal is `{ error, code }` plus detail, and never carries the response time. */
async function refusalOf(res: Response) {
  const body: Record<string, unknown> = await res.json();
  expect(typeof body.error).toBe("string");
  expect(JSON.stringify(body)).not.toContain("respondedAt");
  return { status: res.status, code: body.code, body };
}

const seenTerms = { role: "TECHNICAL_SUPPORT", sharePercent: 5 };
const ACCEPT = { response: "ACCEPTED", seenTerms };
const SUMMARY = { id: "c-invitee", status: "ACCEPTED" };

beforeEach(() => {
  mockWorld.reset();
  signIn("u-invitee");
  mockRespond.mockResolvedValue(SUMMARY);
});

describe("PATCH /api/collaborations/[id]/respond", () => {
  it.each([
    ["signed out", null, "c-invitee", 401, "UNAUTHORIZED"],
    [
      "a user with no expert profile",
      "u-learner",
      "c-invitee",
      404,
      "NOT_FOUND",
    ],
    ["a blank invitation id", "u-invitee", " ", 404, "NOT_FOUND"],
    [
      "an overlong invitation id",
      "u-invitee",
      "c".repeat(65),
      404,
      "NOT_FOUND",
    ],
  ])("refuses %s", async (_name, userId, id, status, code) => {
    signIn(userId);
    expect(await refusalOf(await respond(ACCEPT, id))).toMatchObject({
      status,
      code,
    });
    expect(mockRespond).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ["an accept that names no terms", { response: "ACCEPTED" }],
    ["the old body shape", { planType: "webinar", response: "ACCEPTED" }],
    [
      "a fractional seen share",
      { response: "ACCEPTED", seenTerms: { ...seenTerms, sharePercent: 2.5 } },
    ],
    [
      "a seen share of 0",
      { response: "ACCEPTED", seenTerms: { ...seenTerms, sharePercent: 0 } },
    ],
    [
      "a seen share of 91",
      { response: "ACCEPTED", seenTerms: { ...seenTerms, sharePercent: 91 } },
    ],
    [
      "a role that does not exist",
      { response: "ACCEPTED", seenTerms: { ...seenTerms, role: "OWNER" } },
    ],
    [
      "an unknown key in the seen terms",
      { response: "ACCEPTED", seenTerms: { ...seenTerms, status: "ACCEPTED" } },
    ],
    ["an answer that is neither", { response: "REMOVED" }],
    ["no answer", {}],
  ])("answers 400 INVALID_TERMS to %s", async (_name, body) => {
    expect(await refusalOf(await respond(body))).toMatchObject({
      status: 400,
      code: "INVALID_TERMS",
    });
    expect(mockRespond).not.toHaveBeenCalled();
  });

  it("accepts as the signed-in expert, with the terms they saw", async () => {
    const res = await respond(ACCEPT);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: SUMMARY });
    expect(mockRespond).toHaveBeenCalledWith({
      response: "ACCEPTED",
      seenTerms,
      collaboratorId: "c-invitee",
      consultantProfileId: "cp-invitee",
      userId: "u-invitee",
    });
  });

  it("declines with no terms", async () => {
    const res = await respond({ response: "DECLINED" });
    expect(res.status).toBe(200);
    expect(mockRespond).toHaveBeenCalledWith({
      response: "DECLINED",
      collaboratorId: "c-invitee",
      consultantProfileId: "cp-invitee",
      userId: "u-invitee",
    });
  });

  it("answers another expert's invitation as not found, and never takes the responder from the body", async () => {
    signIn("u-expert");
    mockRespond.mockRejectedValue(
      new CollaborationError("NOT_FOUND", "Invitation not found."),
    );
    const res = await respond({
      response: "DECLINED",
      consultantProfileId: "cp-invitee",
      userId: "u-invitee",
    });
    expect(await refusalOf(res)).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(mockRespond).toHaveBeenCalledWith({
      response: "DECLINED",
      collaboratorId: "c-invitee",
      consultantProfileId: "cp-expert",
      userId: "u-expert",
    });
  });

  it("answers TERMS_CHANGED with the current terms beside the error and code", async () => {
    mockRespond.mockRejectedValue(
      new CollaborationError("TERMS_CHANGED", "The host changed the terms.", {
        terms: { role: "TECHNICAL_SUPPORT", sharePercent: 8 },
      }),
    );
    expect(await refusalOf(await respond(ACCEPT))).toEqual({
      status: 409,
      code: "TERMS_CHANGED",
      body: {
        error: "The host changed the terms.",
        code: "TERMS_CHANGED",
        terms: { role: "TECHNICAL_SUPPORT", sharePercent: 8 },
      },
    });
  });

  it("answers a calendar lock that cannot be taken as a 503 with its code", async () => {
    mockRespond.mockRejectedValue(new BookingLockUnavailableError("accept"));
    expect(await refusalOf(await respond(ACCEPT))).toMatchObject({
      status: 503,
      code: "BOOKING_LOCK_UNAVAILABLE",
    });
  });
});
