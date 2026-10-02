/**
 * @jest-environment node
 */

/**
 * Organisation member removal MUST end the person's Stream access.
 *
 * `lib/enterprise/member-removal.ts` used to import nothing from Stream at all,
 * and that was the whole defect: `assertCanMintToken` checks session identity
 * and the platform-level `session.user.banned` flag, never org membership, so a
 * removed member could keep minting one-hour chat and video tokens
 * indefinitely. Nothing on the token or join path ever re-derived "are they
 * still in this org", so they kept reading and writing every `dmo-<org>-…`
 * thread and every `webinar-*` channel they were on until an unrelated booking
 * cancellation happened to trip the booking-derived reconciler.
 *
 * These tests pin the properties that make the fix real:
 *   1. the token is revoked for the removed person and nobody else;
 *   2. the durable debt is committed INSIDE the transaction, and no provider call
 *      happens until it has;
 *   3. a vendor failure does not roll back the local removal;
 *   4. eviction still runs when only the token revoke fails.
 * (`__tests__/stream/org-wind-down.test.ts` covers the retry half.)
 */

const order: string[] = [];

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/**
 * The transaction double, defined INSIDE the factory: a hoisted `jest.mock`
 * body runs before the module-level `const`s, so referencing them here is a
 * temporal-dead-zone crash rather than a test failure. Reached from the test
 * through `jest.requireMock` instead.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      const { txMock } = jest.requireMock("../../lib/prisma");
      order.push("tx:open");
      const out = await fn(txMock);
      order.push("tx:commit");
      return out;
    }),
    membership: { findFirst: jest.fn(async () => null) },
    appointment: { findMany: jest.fn(async () => []) },
    consultation: { findMany: jest.fn(async () => []) },
    subscription: { findMany: jest.fn(async () => []) },
    $disconnect: jest.fn(async () => undefined),
  },
  txMock: {
    membership: {
      findFirst: jest.fn(async () => null),
      // `transitionMembership` writes the debt row through this.
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    programAssignment: { updateMany: jest.fn(async () => ({ count: 1 })) },
    orgAuditLog: { create: jest.fn(async () => ({})) },
    organization: {
      findUnique: jest.fn(async () => ({ name: "Acme", slug: "acme" })),
    },
    user: { findUnique: jest.fn(async () => ({ name: "Owner", email: null })) },
  },
}));

jest.mock("../../lib/enterprise/membership-guards", () => ({
  assertRemovable: jest.fn(async () => ({ obligations: {}, forced: false })),
  MembershipGuardError: class extends Error {},
}));

jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(async () => undefined),
}));

jest.mock("../../lib/api/organizations/seat-count", () => ({
  releaseSeatsForTerminatedAssignments: jest.fn(async () => undefined),
}));

jest.mock("../../lib/api/organizations/membership-transitions", () => ({
  recomputeConsultantIsIndependent: jest.fn(async () => undefined),
}));

jest.mock("../../lib/novu/service", () => ({
  notifyOrgExpertRemoved: jest.fn(async () => ({ success: true })),
}));

jest.mock("../../lib/novu/workflows", () => ({}));

jest.mock("../../lib/email", () => ({
  stageOrgMembershipChangedEmail: jest.fn(async () => null),
  attemptOnboardingEmail: jest.fn(async () => undefined),
  EMAIL_BUDGET_MS: {},
}));

jest.mock("../../lib/api/after-safe", () => ({ scheduleAfter: jest.fn() }));

/**
 * The real `transitionMembership` is what writes the membership row, and the
 * ordering assertion below depends on it running inside the transaction — so
 * only the Serializable wrapper is doubled, not the transition itself.
 */
jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: jest.fn(async (fn: () => Promise<unknown>) => fn()),
}));

jest.mock("../../lib/stream-client", () => {
  const removeMembers = jest.fn(async () => ({}));
  const revokeUserToken = jest.fn(async () => undefined);
  return {
    streamMocks: { removeMembers, revokeUserToken },
    getStreamChatClient: jest.fn(() => ({
      revokeUserToken,
      channel: jest.fn(() => ({ removeMembers })),
    })),
    isStreamConfigured: jest.fn(() => true),
    isExpectedStreamError: jest.fn(() => false),
    withStreamCircuitBreaker: jest.fn(async (fn: () => Promise<unknown>) =>
      fn(),
    ),
  };
});

import * as Sentry from "@sentry/nextjs";
import { removeMember } from "../../lib/enterprise/member-removal";
import prisma from "../../lib/prisma";

interface TxShape {
  membership: {
    findFirst: jest.Mock;
    updateMany: jest.Mock;
  };
  programAssignment: { updateMany: jest.Mock };
  orgAuditLog: { create: jest.Mock };
  organization: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
}
const { txMock } = jest.requireMock("../../lib/prisma") as {
  txMock: TxShape;
};

const { streamMocks, isExpectedStreamError } = jest.requireMock(
  "../../lib/stream-client",
) as {
  streamMocks: { removeMembers: jest.Mock; revokeUserToken: jest.Mock };
  isExpectedStreamError: jest.Mock;
};
const { removeMembers, revokeUserToken } = streamMocks;

const REMOVED = {
  id: "mem-removed",
  userId: "user-removed",
  organizationId: "org-1",
  role: "LEARNER",
  status: "ACTIVE",
  consultantProfileId: null,
};

const input = {
  orgId: "org-1",
  memberId: "mem-removed",
  actor: { membershipId: "mem-owner", role: "OWNER" as const },
  actorUserId: "user-owner",
  force: false,
};

/** The channels this org owns, as the surface scan reports them. */
function surfaceScan() {
  (prisma.appointment.findMany as jest.Mock).mockResolvedValue([
    {
      organizationId: "org-1",
      webinar: { id: "web-1", webinarPlan: { organizationId: "org-1" } },
      class: null,
    },
  ]);
  (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
    {
      consultationPlan: {
        organizationId: "org-1",
        consultantProfile: { user: { id: "user-consultant" } },
      },
      requestedBy: { user: { id: "user-removed" } },
      appointment: { organizationId: "org-1" },
    },
  ]);
  (prisma.subscription.findMany as jest.Mock).mockResolvedValue([]);
}

beforeEach(() => {
  order.length = 0;
  jest.clearAllMocks();
  txMock.membership.findFirst.mockResolvedValue(REMOVED);
  (prisma.membership.findFirst as jest.Mock).mockResolvedValue(null);
  surfaceScan();
  removeMembers.mockResolvedValue({});
  revokeUserToken.mockResolvedValue(undefined);
  isExpectedStreamError.mockReturnValue(false);
  (Sentry.captureException as jest.Mock).mockReturnValue("");
});

describe("removeMember — Stream access ends with the membership", () => {
  it("revokes the removed person's token and nobody else's", async () => {
    const result = await removeMember(input);

    expect(result).toEqual({ removed: true });
    expect(revokeUserToken).toHaveBeenCalledTimes(1);
    expect(revokeUserToken).toHaveBeenCalledWith(
      "user-removed",
      expect.any(Date),
    );
    const revokedFor = revokeUserToken.mock.calls.map((c) => c[0]);
    expect(revokedFor).not.toContain("user-owner");
    expect(revokedFor).not.toContain("user-consultant");
  });

  it("evicts them from the org's event channels and its DM threads", async () => {
    await removeMember(input);

    // One `webinar-web-1` from the appointment scan, one `dmo-…` derived from
    // the DM-eligible consultation they are a party to. Both carry the removed
    // person and nobody else.
    expect(removeMembers).toHaveBeenCalledTimes(2);
    for (const call of removeMembers.mock.calls) {
      expect(call[0]).toEqual(["user-removed"]);
    }
  });

  it("commits the durable debt inside the transaction and touches Stream only after it", async () => {
    revokeUserToken.mockImplementation(async () => {
      order.push("stream:revoke");
      return undefined;
    });

    await removeMember(input);

    // The debt IS the membership row — the state-as-outbox shape already
    // shipped in this repo as `Appointment.chatChannelEnsuredAt` (#1356):
    // `transitionMembership` writes it in the same transaction as the local
    // removal, so the obligation is durable and atomic with the fact that
    // created it. `jobs/stream/wind-down-deactivated-orgs` re-drives whatever
    // this post-commit attempt fails to land.
    expect(txMock.membership.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "mem-removed" }),
        data: { status: "REMOVED" },
      }),
    );

    // No provider call may run while that transaction is still open: a network
    // round trip inside a Serializable transaction holds a Postgres connection
    // and a snapshot open across the wire.
    expect(order).toEqual(["tx:open", "tx:commit", "stream:revoke"]);
  });

  it("leaves the removal committed when Stream is down, and reports the debt", async () => {
    revokeUserToken.mockRejectedValue(new Error("Stream circuit open"));
    removeMembers.mockRejectedValue(new Error("Stream circuit open"));

    // The local fact must not roll back on a vendor failure.
    await expect(removeMember(input)).resolves.toEqual({ removed: true });
    expect(txMock.membership.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "REMOVED" } }),
    );
    // …and the failure is reported, not swallowed, so the unlanded obligation
    // is visible rather than silent.
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ op: "org.member-removal.revoke" }),
      }),
    );
  });

  it("still evicts the org's channels when only the token revoke fails", async () => {
    revokeUserToken.mockRejectedValue(new Error("Stream: user not found"));

    await removeMember(input);

    expect(removeMembers).toHaveBeenCalledTimes(2);
  });

  it("treats a channel the person was never in as evicted, not as a failure", async () => {
    isExpectedStreamError.mockReturnValue(true);
    removeMembers.mockRejectedValue(new Error("channel not found"));

    await removeMember(input);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("does not revoke for a repeat removal that moved no row", async () => {
    txMock.membership.findFirst.mockResolvedValue({
      ...REMOVED,
      status: "REMOVED",
    });

    const result = await removeMember(input);

    expect(result).toEqual({ removed: false });
    expect(revokeUserToken).not.toHaveBeenCalled();
  });

  it("skips a member who has been reinstated, so a retry cannot evict them", async () => {
    // The still-applicable guard `retry-moderation-enforcement` calls
    // `stillApplicable` for: a revocation that is no longer owed must never be
    // re-applied, or the sweep would undo the reactivation.
    (prisma.membership.findFirst as jest.Mock).mockResolvedValue({
      id: "mem-removed",
    });

    await removeMember(input);

    expect(revokeUserToken).not.toHaveBeenCalled();
    expect(removeMembers).not.toHaveBeenCalled();
  });
});
