/**
 * @jest-environment node
 */

/**
 * Personal vs org appointment scopes. A booking is personal on the buyer side
 * when it carries no org tag, and on the delivery side when no org hosts the
 * plan (a sponsor tag is a funding rail, not a host). Real-Postgres coverage
 * lives in __tests__/db/scope/org-scoping.db.test.ts.
 */

import { buildWhere } from "@/lib/api/scope/list-appointments";

const live = { in: ["HELD", "CONFIRMED", "ATTENDED"] };
// A collaborator's own participant row is never an attended seat.
const learnerOrHost = { role: { not: "COLLABORATOR" } };

describe("buildWhere — personal and org scopes", () => {
  const where = buildWhere({
    scope: { kind: "personal" },
    userId: "u1",
  }) as { organizationId?: unknown; OR: Array<Record<string, unknown>> };

  it("pins no org at the top level: each side carries its own personal test", () => {
    expect(where.organizationId).toBeUndefined();
  });

  it("buyer and attendee arms require an untagged booking, the attendee seat included", () => {
    expect(where.OR).toContainEqual({
      organizationId: null,
      OR: [
        { consultation: { requestedBy: { userId: "u1" } } },
        { subscription: { requestedBy: { userId: "u1" } } },
        {
          participants: {
            some: { userId: "u1", status: live, ...learnerOrHost },
          },
        },
      ],
    });
  });

  it("delivery arms require a plan no org hosts, whatever the booking's tag", () => {
    expect(where.OR).toContainEqual({
      consultation: {
        consultationPlan: {
          organizationId: null,
          consultantProfile: { userId: "u1" },
        },
      },
    });
    expect(where.OR).toContainEqual({
      class: {
        classPlan: {
          organizationId: null,
          collaborators: {
            some: { consultantProfile: { userId: "u1" }, status: "ACCEPTED" },
          },
        },
      },
    });
  });

  it("org scope: tagged rows on the org's grounds, or any row on a plan it hosts; no user filter", () => {
    const w = buildWhere({
      scope: { kind: "org", orgId: "org1" },
      userId: "u1",
    }) as { OR: Array<Record<string, unknown>> };
    const readable = { is: { status: { in: expect.any(Array) } } };
    expect(w.OR).toEqual([
      {
        organizationId: "org1",
        organization: readable,
        OR: [
          { payment: { none: {} } },
          {
            payment: {
              some: {
                organizationId: "org1",
                paymentMethod: { in: ["WALLET", "INVOICE", "LICENSE"] },
              },
            },
          },
        ],
      },
      {
        consultation: {
          consultationPlan: { organizationId: "org1", organization: readable },
        },
      },
      {
        subscription: {
          subscriptionPlan: { organizationId: "org1", organization: readable },
        },
      },
      {
        webinar: {
          webinarPlan: { organizationId: "org1", organization: readable },
        },
      },
      {
        class: {
          classPlan: { organizationId: "org1", organization: readable },
        },
      },
    ]);
    // No user filter: `operations.read` gates it, below that is `orgMember`.
    expect(JSON.stringify(w)).not.toContain("userId");
  });

  it("orgMember splits the same way: booked/attended under the tag, delivered on this org's plans", () => {
    const w = buildWhere({
      scope: { kind: "orgMember", orgId: "org1", userId: "u1" },
      userId: "u1",
    }) as { OR: Array<Record<string, unknown>> };
    expect(w.OR).toContainEqual({
      organizationId: "org1",
      OR: [
        { consultation: { requestedBy: { userId: "u1" } } },
        { subscription: { requestedBy: { userId: "u1" } } },
        {
          participants: {
            some: { userId: "u1", status: live, ...learnerOrHost },
          },
        },
      ],
    });
    expect(w.OR).toContainEqual({
      webinar: {
        webinarPlan: {
          organizationId: "org1",
          consultantProfile: { userId: "u1" },
        },
      },
    });
    // A trial appears only on its delivery side, split on the plan's host org.
    expect(w.OR).toContainEqual({
      trial: {
        consultantProfile: { userId: "u1" },
        subscriptionPlan: { organizationId: "org1" },
      },
    });
    expect(JSON.stringify(w)).not.toContain("consulteeProfile");
  });
});
