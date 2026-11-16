/** @jest-environment node */

// PATCH and DELETE /api/collaborations/{webinar,class}/[planId]/[id]: only a
// manager edits terms; a manager removes any row, a collaborator only their own.

const mockSession = jest.fn();
const mockUpdateTerms = jest.fn();
const mockRemove = jest.fn();
const mockLeave = jest.fn();
jest.mock("@/lib/auth-server", () => ({ getSession: () => mockSession() }));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("@/lib/collaborators/notifications", () => ({}));
jest.mock("@/lib/stream/collaborator-access", () => ({}));
jest.mock("@/lib/stream/access-revocation", () => ({}));
jest.mock("@/lib/collaborators/service", () => ({
  ...jest.requireActual("@/lib/collaborators/service"),
  updatePendingTerms: (...args: unknown[]) => mockUpdateTerms(...args),
  removeCollaborator: (...args: unknown[]) => mockRemove(...args),
  leaveCollaboration: (...args: unknown[]) => mockLeave(...args),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockWorld.db;
  },
}));

import { NextRequest } from "next/server";
import * as classRoute from "@/app/api/collaborations/class/[planId]/[id]/route";
import * as webinarRoute from "@/app/api/collaborations/webinar/[planId]/[id]/route";
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
const ctx = (planId: string, id: string) => ({
  params: Promise.resolve({ planId, id }),
});
const request = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/api/collaborations", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A refusal is `{ error, code }` plus detail, and never carries the response time. */
async function refusalOf(res: Response) {
  const body: Record<string, unknown> = await res.json();
  expect(typeof body.error).toBe("string");
  expect(JSON.stringify(body)).not.toContain("respondedAt");
  return { status: res.status, code: body.code };
}

const SUMMARY = { id: "c-invitee", status: "PENDING" };
const writes = () =>
  [mockUpdateTerms, mockRemove, mockLeave].flatMap((fn) => fn.mock.calls);

beforeEach(() => {
  mockWorld.reset();
  signIn("u-owner");
  mockUpdateTerms.mockResolvedValue(SUMMARY);
  mockRemove.mockResolvedValue({ ...SUMMARY, status: "REMOVED" });
  mockLeave.mockResolvedValue({ ...SUMMARY, status: "WITHDRAWN" });
});

describe.each([
  ["webinar", webinarRoute, "MODERATOR", "TEACHING_ASSISTANT"],
  ["class", classRoute, "TEACHING_ASSISTANT", "MODERATOR"],
] as const)(
  "/api/collaborations/%s/[planId]/[id]",
  (planType, route, role, otherRole) => {
    const ref = { planType, planId: "plan-1" };
    const suspend = (userId: string, memberRole: string) => {
      world.plan = orgPlan("SUSPENDED");
      world.memberships = [member(userId, memberRole)];
      signIn(userId);
    };

    describe("PATCH", () => {
      it.each([
        ["signed out", null, "plan-1", "c-invitee", 401, "UNAUTHORIZED"],
        [
          "an unrelated expert",
          "u-expert",
          "plan-1",
          "c-invitee",
          403,
          "FORBIDDEN",
        ],
        [
          "the invitee, of their own terms",
          "u-invitee",
          "plan-1",
          "c-invitee",
          403,
          "FORBIDDEN",
        ],
        [
          "the presenter",
          "u-presenter",
          "plan-1",
          "c-invitee",
          403,
          "FORBIDDEN",
        ],
        [
          "a plan that does not exist",
          "u-owner",
          "plan-9",
          "c-invitee",
          404,
          "NOT_FOUND",
        ],
        ["a blank plan id", "u-owner", " ", "c-invitee", 404, "NOT_FOUND"],
        ["a blank collaborator id", "u-owner", "plan-1", "", 404, "NOT_FOUND"],
      ])("refuses %s", async (_name, userId, planId, id, status, code) => {
        signIn(userId);
        const res = await route.PATCH(
          request("PATCH", { sharePercent: 20 }),
          ctx(planId, id),
        );
        expect(await refusalOf(res)).toEqual({ status, code });
        expect(writes()).toEqual([]);
      });

      it.each([
        ["the owning expert", "u-owner", "EXPERT"],
        ["a catalogue manager", "u-ops", "OWNER"],
      ])(
        "refuses %s while the organisation is not active",
        async (_name, userId, memberRole) => {
          suspend(userId, memberRole);
          const res = await route.PATCH(
            request("PATCH", { sharePercent: 20 }),
            ctx("plan-1", "c-invitee"),
          );
          expect(await refusalOf(res)).toEqual({
            status: 403,
            code: "FORBIDDEN",
          });
          expect(writes()).toEqual([]);
        },
      );

      it.each<[string, object]>([
        ["the share", { sharePercent: 35 }],
        ["the role", { role }],
        ["both", { role, sharePercent: 1 }],
      ])("lets a manager change %s", async (_name, body) => {
        const res = await route.PATCH(
          request("PATCH", body),
          ctx("plan-1", "c-invitee"),
        );
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ data: SUMMARY });
        expect(mockUpdateTerms).toHaveBeenCalledWith({
          ref,
          collaboratorId: "c-invitee",
          ...body,
        });
      });

      it.each<[string, unknown]>([
        ["no term at all", {}],
        ["a fractional share", { sharePercent: 12.5 }],
        ["a share of 0", { sharePercent: 0 }],
        ["a share of 91", { sharePercent: 91 }],
        ["a role of the other plan type", { role: otherRole }],
        ["an unknown key", { sharePercent: 20, status: "ACCEPTED" }],
      ])("answers 400 INVALID_TERMS to %s", async (_name, body) => {
        const res = await route.PATCH(
          request("PATCH", body),
          ctx("plan-1", "c-invitee"),
        );
        expect(await refusalOf(res)).toEqual({
          status: 400,
          code: "INVALID_TERMS",
        });
        expect(writes()).toEqual([]);
      });

      it("answers the service's TERMS_LOCKED as a 409", async () => {
        mockUpdateTerms.mockRejectedValue(
          new CollaborationError(
            "TERMS_LOCKED",
            "Accepted terms cannot be changed.",
          ),
        );
        const res = await route.PATCH(
          request("PATCH", { sharePercent: 20 }),
          ctx("plan-1", "c-presenter"),
        );
        expect(await refusalOf(res)).toEqual({
          status: 409,
          code: "TERMS_LOCKED",
        });
      });
    });

    describe("DELETE", () => {
      it.each([
        ["signed out", null, "plan-1", "c-crew", 401, "UNAUTHORIZED"],
        [
          "an unrelated expert",
          "u-expert",
          "plan-1",
          "c-crew",
          403,
          "FORBIDDEN",
        ],
        [
          "a user with no expert profile",
          "u-learner",
          "plan-1",
          "c-crew",
          403,
          "FORBIDDEN",
        ],
        [
          "the presenter, of a crew member's row",
          "u-presenter",
          "plan-1",
          "c-crew",
          403,
          "FORBIDDEN",
        ],
        [
          "an invitee, of a team member's row",
          "u-invitee",
          "plan-1",
          "c-presenter",
          403,
          "FORBIDDEN",
        ],
        [
          "someone who left, of their ended row",
          "u-left",
          "plan-1",
          "c-left",
          403,
          "FORBIDDEN",
        ],
        ["a blank plan id", "u-owner", " ", "c-crew", 404, "NOT_FOUND"],
        ["a blank collaborator id", "u-crew", "plan-1", " ", 404, "NOT_FOUND"],
      ])("refuses %s", async (_name, userId, planId, id, status, code) => {
        signIn(userId);
        const res = await route.DELETE(request("DELETE"), ctx(planId, id));
        expect(await refusalOf(res)).toEqual({ status, code });
        expect(writes()).toEqual([]);
      });

      it("refuses a plan that does not exist without a write", async () => {
        const res = await route.DELETE(
          request("DELETE"),
          ctx("plan-9", "c-crew"),
        );
        expect([403, 404]).toContain(res.status);
        expect(writes()).toEqual([]);
      });

      it.each([
        ["the owning expert", "u-owner", "EXPERT"],
        ["a catalogue manager", "u-ops", "MANAGER"],
      ])(
        "refuses %s while the organisation is not active",
        async (_name, userId, memberRole) => {
          suspend(userId, memberRole);
          const res = await route.DELETE(
            request("DELETE"),
            ctx("plan-1", "c-crew"),
          );
          expect(await refusalOf(res)).toEqual({
            status: 403,
            code: "FORBIDDEN",
          });
          expect(writes()).toEqual([]);
        },
      );

      it("lets a manager remove any row, as the person who removed it", async () => {
        const res = await route.DELETE(
          request("DELETE"),
          ctx("plan-1", "c-crew"),
        );
        expect(res.status).toBe(200);
        expect(mockRemove).toHaveBeenCalledWith({
          ref,
          collaboratorId: "c-crew",
          removedByUserId: "u-owner",
        });
        expect(mockLeave).not.toHaveBeenCalled();
      });

      it.each([
        ["a team member", "u-crew", "c-crew", "cp-crew"],
        ["an invitee", "u-invitee", "c-invitee", "cp-invitee"],
      ])(
        "lets %s end their own row and no other",
        async (_name, userId, id, consultantProfileId) => {
          signIn(userId);
          const res = await route.DELETE(request("DELETE"), ctx("plan-1", id));
          expect(res.status).toBe(200);
          expect(mockLeave).toHaveBeenCalledWith({
            ref,
            collaboratorId: id,
            consultantProfileId,
            userId,
          });
          expect(mockRemove).not.toHaveBeenCalled();
        },
      );

      it("answers the service's NOT_FOUND as a 404", async () => {
        mockRemove.mockRejectedValue(
          new CollaborationError("NOT_FOUND", "No longer on this plan."),
        );
        const res = await route.DELETE(
          request("DELETE"),
          ctx("plan-1", "c-gone"),
        );
        expect(await refusalOf(res)).toEqual({
          status: 404,
          code: "NOT_FOUND",
        });
      });
    });
  },
);
