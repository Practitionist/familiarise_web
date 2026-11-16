/** @jest-environment node */

// GET and POST /api/collaborations/{webinar,class}/[planId]: who may read a
// plan's team, who may invite, and what a refused request is told.

const mockSession = jest.fn();
const mockInvite = jest.fn();
const mockRateLimit = jest.fn();
const mockReport = jest.fn();
jest.mock("@/lib/auth-server", () => ({ getSession: () => mockSession() }));
jest.mock("@/lib/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => mockRateLimit(...args),
  collaboratorInviteLimiter: { name: "collaborator-invite" },
}));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReport(...args),
}));
jest.mock("@/lib/collaborators/notifications", () => ({}));
jest.mock("@/lib/stream/collaborator-access", () => ({}));
jest.mock("@/lib/stream/access-revocation", () => ({}));
jest.mock("@/lib/collaborators/service", () => ({
  ...jest.requireActual("@/lib/collaborators/service"),
  inviteCollaborator: (...args: unknown[]) => mockInvite(...args),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockWorld.db;
  },
}));

import { NextRequest, NextResponse } from "next/server";
import * as classRoute from "@/app/api/collaborations/class/[planId]/route";
import * as webinarRoute from "@/app/api/collaborations/webinar/[planId]/route";
import { CollaborationError } from "@/lib/collaborators/service";
import {
  collaborationWorld,
  member,
  orgPlan,
} from "../fixtures/collaboration-world";

const mockWorld = collaborationWorld();
const { world } = mockWorld;

const signIn = (userId: string | null) =>
  mockSession.mockResolvedValue(userId ? { user: { id: userId } } : null);
const ctx = (planId: string) => ({ params: Promise.resolve({ planId }) });
const request = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/api/collaborations", {
    method,
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

/** A refusal is `{ error, code }` plus detail, and never carries the response time. */
async function refusalOf(res: Response) {
  const body: Record<string, unknown> = await res.json();
  expect(typeof body.error).toBe("string");
  expect(JSON.stringify(body)).not.toContain("respondedAt");
  return { status: res.status, code: body.code, body };
}

const SUMMARY = { id: "c-new", status: "PENDING" };

beforeEach(() => {
  mockWorld.reset();
  signIn("u-owner");
  mockRateLimit.mockResolvedValue(null);
  mockInvite.mockResolvedValue(SUMMARY);
});

describe.each([
  ["webinar", webinarRoute, "MODERATOR", "TEACHING_ASSISTANT"],
  ["class", classRoute, "TEACHING_ASSISTANT", "MODERATOR"],
] as const)(
  "/api/collaborations/%s/[planId]",
  (planType, route, role, otherRole) => {
    const invite = { consultantProfileId: "cp-expert", role, sharePercent: 20 };

    describe("GET", () => {
      it.each([
        ["signed out", null, "plan-1", 401, "UNAUTHORIZED"],
        ["an unrelated expert", "u-expert", "plan-1", 403, "FORBIDDEN"],
        [
          "a user with no expert profile",
          "u-learner",
          "plan-1",
          403,
          "FORBIDDEN",
        ],
        ["someone who left the team", "u-left", "plan-1", 403, "FORBIDDEN"],
        ["a plan that does not exist", "u-owner", "plan-9", 404, "NOT_FOUND"],
        ["a blank plan id", "u-owner", " ", 404, "NOT_FOUND"],
        ["an overlong plan id", "u-owner", "p".repeat(65), 404, "NOT_FOUND"],
      ])("refuses %s", async (_name, userId, planId, status, code) => {
        signIn(userId);
        const refusal = await refusalOf(
          await route.GET(request("GET"), ctx(planId)),
        );
        expect(refusal).toMatchObject({ status, code });
        expect(mockWorld.db.collaborator.findMany).not.toHaveBeenCalled();
      });

      it.each([
        ["the owner", "u-owner", "manager", true, [3000, 1000, 500]],
        ["the presenter", "u-presenter", "presenter", false, [3000, null]],
        ["a crew member", "u-crew", "crew", false, [null, 1000]],
        ["an invitee", "u-invitee", "invitee", false, [null, null, 500]],
      ])(
        "shows %s the team they may see",
        async (_name, userId, viewer, canManage, shares) => {
          signIn(userId);
          const res = await route.GET(request("GET"), ctx("plan-1"));
          const body = await res.json();
          expect(res.status).toBe(200);
          expect(body).toMatchObject({ viewer, canManage });
          expect(
            body.data.map(
              (c: { revenueShareBps: number | null }) => c.revenueShareBps,
            ),
          ).toEqual(shares);
          expect(JSON.stringify(body)).not.toContain("respondedAt");
        },
      );

      it("lets a manager of a suspended organisation read but not manage", async () => {
        world.plan = orgPlan("SUSPENDED");
        world.memberships = [member("u-owner", "EXPERT")];
        const res = await route.GET(request("GET"), ctx("plan-1"));
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({
          viewer: "manager",
          canManage: false,
        });
      });
    });

    describe("POST", () => {
      it.each([
        ["signed out", null, "plan-1", 401, "UNAUTHORIZED"],
        ["an unrelated expert", "u-expert", "plan-1", 403, "FORBIDDEN"],
        ["the presenter", "u-presenter", "plan-1", 403, "FORBIDDEN"],
        ["a crew member", "u-crew", "plan-1", 403, "FORBIDDEN"],
        ["an invitee", "u-invitee", "plan-1", 403, "FORBIDDEN"],
        ["a plan that does not exist", "u-owner", "plan-9", 404, "NOT_FOUND"],
        ["a blank plan id", "u-owner", "", 404, "NOT_FOUND"],
      ])(
        "refuses %s before the limiter or the service is reached",
        async (_name, userId, planId, status, code) => {
          signIn(userId);
          const refusal = await refusalOf(
            await route.POST(request("POST", invite), ctx(planId)),
          );
          expect(refusal).toMatchObject({ status, code });
          expect(mockRateLimit).not.toHaveBeenCalled();
          expect(mockInvite).not.toHaveBeenCalled();
        },
      );

      it.each([
        ["the owning expert", "u-owner", [member("u-owner", "EXPERT")]],
        ["a catalogue manager", "u-ops", [member("u-ops", "MANAGER")]],
      ])(
        "refuses %s while the organisation is not active",
        async (_name, userId, memberships) => {
          world.plan = orgPlan("SUSPENDED");
          world.memberships = memberships;
          signIn(userId);
          const refusal = await refusalOf(
            await route.POST(request("POST", invite), ctx("plan-1")),
          );
          expect(refusal).toMatchObject({ status: 403, code: "FORBIDDEN" });
          expect(mockInvite).not.toHaveBeenCalled();
        },
      );

      it("invites for the owner, as the owner's profile", async () => {
        const res = await route.POST(request("POST", invite), ctx("plan-1"));
        expect(res.status).toBe(201);
        await expect(res.json()).resolves.toEqual({ data: SUMMARY });
        expect(mockInvite).toHaveBeenCalledWith({
          ref: { planType, planId: "plan-1" },
          ...invite,
          invitedByProfileId: "cp-owner",
        });
        expect(mockRateLimit).toHaveBeenCalledWith(
          { name: "collaborator-invite" },
          "collab-invite:u-owner",
        );
      });

      it("invites for an organisation operator, who has no profile to invite as", async () => {
        world.plan = orgPlan("ACTIVE", null);
        world.memberships = [member("u-ops", "MAINTAINER")];
        signIn("u-ops");
        const res = await route.POST(request("POST", invite), ctx("plan-1"));
        expect(res.status).toBe(201);
        expect(mockInvite).toHaveBeenCalledWith(
          expect.objectContaining({ invitedByProfileId: null }),
        );
      });

      it.each<[string, unknown]>([
        ["a fractional share", { ...invite, sharePercent: 12.5 }],
        ["a share of 0", { ...invite, sharePercent: 0 }],
        ["a share of 91", { ...invite, sharePercent: 91 }],
        ["a share sent as text", { ...invite, sharePercent: "20" }],
        ["a role of the other plan type", { ...invite, role: otherRole }],
        ["an unknown key", { ...invite, revenueSharePercentage: 20 }],
        ["no invitee", { role, sharePercent: 20 }],
        ["a body that is not JSON", "not json"],
      ])("answers 400 INVALID_TERMS to %s", async (_name, body) => {
        const refusal = await refusalOf(
          await route.POST(request("POST", body), ctx("plan-1")),
        );
        expect(refusal).toMatchObject({ status: 400, code: "INVALID_TERMS" });
        expect(mockInvite).not.toHaveBeenCalled();
      });

      it("passes the invite limiter's 429 through untouched", async () => {
        mockRateLimit.mockResolvedValue(
          NextResponse.json(
            { error: "Too many requests.", code: "RATE_LIMITED" },
            { status: 429, headers: { "Retry-After": "60" } },
          ),
        );
        const res = await route.POST(request("POST", invite), ctx("plan-1"));
        expect(res.headers.get("Retry-After")).toBe("60");
        expect(await refusalOf(res)).toMatchObject({
          status: 429,
          code: "RATE_LIMITED",
        });
        expect(mockInvite).not.toHaveBeenCalled();
      });

      it("answers a service refusal as its status, code and detail", async () => {
        mockInvite.mockRejectedValue(
          new CollaborationError("COOLDOWN", "Invite them again later.", {
            retryAt: "2027-01-08T00:00:00.000Z",
          }),
        );
        const refusal = await refusalOf(
          await route.POST(request("POST", invite), ctx("plan-1")),
        );
        expect(refusal).toEqual({
          status: 409,
          code: "COOLDOWN",
          body: {
            error: "Invite them again later.",
            code: "COOLDOWN",
            retryAt: "2027-01-08T00:00:00.000Z",
          },
        });
      });

      it("answers anything unexpected as a 500 that says nothing, reported once", async () => {
        mockInvite.mockRejectedValue(
          new Error("connection reset by db-host-7"),
        );
        const refusal = await refusalOf(
          await route.POST(request("POST", invite), ctx("plan-1")),
        );
        expect(refusal).toMatchObject({ status: 500, code: "INTERNAL" });
        expect(JSON.stringify(refusal.body)).not.toContain("db-host-7");
        expect(mockReport).toHaveBeenCalledTimes(1);
        expect(mockReport).toHaveBeenCalledWith(expect.any(Error), {
          subsystem: "collaborators",
          op: `${planType}.team.invite`,
        });
      });
    });
  },
);
