/**
 * @jest-environment node
 */

// Invariant: the nav badge, Home's Needs-you strip and the personal NeedsYou
// context are one number, countRequestsToAnswer: real PENDING consultations and
// live PENDING subscriptions (a trial never waits on the expert), never a checkout in flight.

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: jest.fn(),
  isPrivileged: jest.fn(() => false),
  forbiddenResponse: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { count: jest.fn() },
    subscription: { count: jest.fn() },
    trial: { count: jest.fn() },
    membership: { findMany: jest.fn() },
    rescheduleRequest: { findMany: jest.fn() },
    appointmentOccurrence: { findMany: jest.fn() },
    appointmentDocument: { count: jest.fn() },
    collaborator: { count: jest.fn() },
    consultantReview: { count: jest.fn() },
  },
}));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { GET as getInbox } from "@/app/api/bookings/inbox/route";
import { readConsultantNeedsYou } from "@/lib/data/consultant-needs-you";
import {
  BEING_MOVED,
  countOpenRequestsForCap,
  countRequestsToAnswer,
  getNeedsYouSummary,
  strandedApprovedConsultationWhere,
} from "@/lib/data/needs-you";

const m = prisma as unknown as Record<string, Record<string, jest.Mock>>;

beforeEach(() => {
  jest.clearAllMocks();
  m.consultation.count.mockResolvedValue(2);
  m.subscription.count.mockResolvedValue(3);
  m.trial.count.mockResolvedValue(1);
  m.membership.findMany.mockResolvedValue([]);
  m.rescheduleRequest.findMany.mockResolvedValue([]);
  m.appointmentOccurrence.findMany.mockResolvedValue([]);
  m.appointmentDocument.count.mockResolvedValue(0);
  m.collaborator.count.mockResolvedValue(0);
  m.consultantReview.count.mockResolvedValue(0);
  (requireApiAuth as jest.Mock).mockResolvedValue({
    session: {
      user: { id: "u-1", role: "CONSULTANT", consultantProfileId: "cp-1" },
    },
  });
});

describe("one requests-to-answer number", () => {
  it("badge, Home strip and NeedsYou all answer countRequestsToAnswer", async () => {
    const count = await countRequestsToAnswer({ consultantProfileId: "cp-1" });
    expect(count).toBe(5);

    const badge = await getInbox(
      new NextRequest(
        "http://localhost/api/bookings/inbox?consultantProfileId=cp-1&countsOnly=1",
      ),
    );
    expect((await badge.json()).toAnswer).toBe(count);

    const home = await readConsultantNeedsYou("cp-1");
    expect(home.requestsToAnswer).toBe(count);

    const summary = await getNeedsYouSummary("u-1", "cp-1");
    const personal = summary.contexts.find((c) => c.organizationId === null);
    // Trials count here too: NeedsYou once said 5 beside a badge of 6.
    expect(personal?.pendingRequests).toBe(count);
  });

  it("counts only invitations on live webinar and class plans, as the Collaborations page lists them", async () => {
    await readConsultantNeedsYou("cp-1");
    expect(m.collaborator.count).toHaveBeenCalledWith({
      where: {
        consultantProfileId: "cp-1",
        status: "PENDING",
        OR: [
          { collaboratorType: "WEBINAR", webinarPlan: { archivedAt: null } },
          { collaboratorType: "CLASS", classPlan: { archivedAt: null } },
        ],
      },
    });
  });

  it("every subscription count reads live rows only", async () => {
    await getNeedsYouSummary("u-1", "cp-1");
    for (const [{ where }] of m.subscription.count.mock.calls) {
      expect(where.deletedAt).toBeNull();
    }
  });

  it("counts each delivering org in that org's scope", async () => {
    m.membership.findMany.mockResolvedValue([
      { organizationId: "org-1", organization: { name: "Acme" } },
    ]);
    const summary = await getNeedsYouSummary("u-1", "cp-1");
    expect(summary.contexts.map((c) => c.organizationId)).toEqual([
      null,
      "org-1",
    ]);
    expect(summary.total).toBe(10);
  });
});

describe("a paid consultation parked without a time", () => {
  it("is counted with the requests, by the predicate the inbox lists it with, in the same statement", async () => {
    await countRequestsToAnswer({ consultantProfileId: "cp-1" });
    expect(m.consultation.count).toHaveBeenCalledTimes(1);
    const [{ where }] = m.consultation.count.mock.calls[0];
    expect(where.OR).toHaveLength(2);
    expect(where.OR[1]).toEqual(
      strandedApprovedConsultationWhere("cp-1", { kind: "personal" }),
    );
    expect(where.OR[1]).toMatchObject({
      status: "APPROVED",
      appointment: {
        occurrences: {
          some: { completionStatus: "RESCHEDULED", deletedAt: null },
        },
        rescheduleRequests: { none: { status: "PENDING_REVIEW" } },
      },
    });
  });

  it("is counted in an organisation's scope too", async () => {
    const orgScope = { kind: "org", orgId: "org-1" } as const;
    await countRequestsToAnswer({ consultantProfileId: "cp-1", orgScope });
    const [{ where }] = m.consultation.count.mock.calls[0];
    expect(where.OR[1]).toEqual(
      strandedApprovedConsultationWhere("cp-1", orgScope),
    );
  });

  it("open plan weeks stay out of the number: subscriptions count PENDING requests only", async () => {
    await countRequestsToAnswer({ consultantProfileId: "cp-1" });
    expect(m.subscription.count).toHaveBeenCalledTimes(1);
    const [{ where }] = m.subscription.count.mock.calls[0];
    expect(JSON.stringify(where)).not.toContain('"APPROVED"}');
    expect(where.AND[0]).toMatchObject({ status: "PENDING" });
  });
});

/** The where-fragment a lapsed move restoring away from PENDING is excluded by. */
const LAPSED =
  /"originStatus":\{"in":\["APPROVED","APPROVED_PENDING_PAYMENT"\]\}/;

describe("a move past its deadline is not a request to answer", () => {
  it("both counts exclude it, with one statement each", async () => {
    await countRequestsToAnswer({ consultantProfileId: "cp-1" });
    expect(m.consultation.count).toHaveBeenCalledTimes(1);
    expect(m.subscription.count).toHaveBeenCalledTimes(1);
    for (const model of [m.consultation, m.subscription]) {
      const [{ where }] = model.count.mock.calls[0];
      const shape = JSON.stringify(where);
      expect(shape).toMatch(LAPSED);
      expect(shape).toContain('"NOT":{"expiresAt":{"gt"');
    }
  });
});

it("Home's reschedule replies leave out a proposal past its deadline", async () => {
  const now = new Date("2026-11-15T12:00:00Z");
  await readConsultantNeedsYou("cp-1", now);
  const [{ where }] = m.rescheduleRequest.findMany.mock.calls[0];
  expect(where).toMatchObject({
    status: "PENDING_REVIEW",
    initiatorRole: "CONSULTEE",
    expiresAt: { gt: now },
  });
  expect(m.rescheduleRequest.findMany).toHaveBeenCalledTimes(1);
});

describe("countOpenRequestsForCap", () => {
  it("counts real submitted requests in every tenant, inside their hold; a trial is never one", async () => {
    const now = new Date("2026-10-27T12:00:00Z");
    const tx = {
      consultation: { count: jest.fn().mockResolvedValue(2) },
      subscription: { count: jest.fn().mockResolvedValue(1) },
      trial: { count: jest.fn().mockResolvedValue(1) },
    };
    await expect(countOpenRequestsForCap("cp-1", tx, now)).resolves.toBe(3);

    const [{ where: consultation }] = tx.consultation.count.mock.calls[0];
    expect(consultation).toEqual({
      status: "PENDING",
      bookingSource: "REQUEST_SUBMITTED",
      consultationPlan: { consultantProfileId: "cp-1" },
      requestedAt: { gte: new Date("2026-10-25T12:00:00Z") },
      NOT: { appointment: BEING_MOVED },
    });
    const [{ where: subscription }] = tx.subscription.count.mock.calls[0];
    expect(subscription).toMatchObject({
      status: "PENDING",
      bookingSource: "REQUEST_SUBMITTED",
      deletedAt: null,
      requestedAt: { gte: new Date("2026-09-27T12:00:00Z") },
    });
    // The only appointment arm EXCLUDES a booking being moved (a NOT over a
    // to-one relation is true when there is no appointment), so an
    // unallocated request still counts in every tenant.
    expect(subscription.NOT).toEqual({ appointment: BEING_MOVED });
    expect(JSON.stringify([consultation, subscription])).not.toContain(
      "payment",
    );
    expect(tx.trial.count).not.toHaveBeenCalled();
    // The global client is never touched when a transaction is passed.
    expect(m.consultation.count).not.toHaveBeenCalled();
  });
});
