/** @jest-environment node */

// Each collaborator transition stages one bell and its emails inside its own
// transaction, to the right party, and an org member removal stages only the
// host's WITHDRAWN notice per row.

const mockStageNotices = jest.fn();
const mockFlush = jest.fn(async (..._args: unknown[]) => undefined);
const mockRevoke = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock("@/lib/collaborators/notifications", () => {
  const actual = jest.requireActual("@/lib/collaborators/notifications");
  return {
    stageCollaboratorNotifications: (...args: unknown[]) =>
      mockStageNotices(...args) ??
      actual.stageCollaboratorNotifications(...args),
  };
});
jest.mock("@/lib/email/render", () => ({
  renderEmail: jest.fn(async () => ({ html: "<p>hi</p>", text: "hi" })),
}));
jest.mock("@/lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: (...args: unknown[]) => mockFlush(...args),
}));
jest.mock("@/lib/stream/org-access-revocation", () => ({
  revokeMemberStreamAccess: jest.fn(async () => ({ complete: true })),
}));
const GENERATION = new Date("2026-11-08T00:00:00Z");
jest.mock("@/lib/stream/access-revocation", () => ({
  persistCollaboratorRevocationInTx: jest.fn(async () => GENERATION),
  revokeCollaboratorAccess: (...args: unknown[]) => mockRevoke(...args),
  enqueueOrgMemberRevocationRetry: jest.fn(),
}));
jest.mock("@/lib/enterprise/membership-guards", () => ({
  assertRemovable: jest.fn(async () => ({ obligations: {}, forced: false })),
}));
jest.mock("@/lib/enterprise/transitions", () => ({
  transitionMembership: jest.fn(),
}));
jest.mock("@/lib/sso/session-sweeps", () => ({
  revokeOrgManagedUserSessions: jest.fn(async () => ({ ended: [] })),
}));
jest.mock("@/lib/auth/session-access-log", () => ({
  stampSessionEnds: jest.fn(),
}));
jest.mock("@/lib/api/organizations/seat-count", () => ({
  releaseSeatsForTerminatedAssignments: jest.fn(),
}));
jest.mock("@/lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(),
}));
jest.mock("@/lib/booking/participants", () => ({
  transitionParticipant: jest.fn(),
}));
jest.mock("@/lib/db/serializable-retry", () => ({
  withSerializableRetry: (run: () => unknown) => run(),
}));

const row = {
  id: "c-1",
  consultantProfileId: "cp-guest",
  webinarPlanId: "wp-1",
  classPlanId: null,
  invitedById: "cp-host",
  role: "CO_HOST" as const,
  revenueShareBps: 2500,
  acceptedAt: new Date("2026-11-01T00:00:00Z"),
  updatedAt: new Date("2026-11-07T00:00:00Z"),
};
const users: Record<string, Record<string, unknown>> = {
  "u-guest": { id: "u-guest", email: "guest@example.com", name: "Guest" },
  "u-host": {
    id: "u-host",
    email: "host@example.com",
    name: "Host",
    notificationPreferences: { inAppEnabled: false },
  },
};
const tx: Record<string, Record<string, jest.Mock> | jest.Mock> & {
  notificationOutbox: { upsert: jest.Mock };
  failedEmail: { create: jest.Mock };
} = {
  $transaction: jest.fn(async (run: (db: unknown) => unknown) => run(tx)),
  webinarPlan: {
    findUnique: jest.fn(async () => ({
      title: "Systems",
      consultantProfile: { userId: "u-host", user: { name: "Host" } },
    })),
  },
  consultantProfile: {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
      where.id === "cp-guest"
        ? { userId: "u-guest", user: { name: "Guest", erasedAt: null } }
        : { userId: "u-host", user: { name: "Host", erasedAt: null } },
    ),
  },
  user: {
    findUnique: jest.fn(async () => null),
    findMany: jest.fn(async (q: { where: { id: { in: string[] } } }) =>
      q.where.id.in.map((id) => users[id]).filter(Boolean),
    ),
  },
  notificationOutbox: {
    upsert: jest.fn(async (q: { create: Record<string, unknown> }) => ({
      id: "bell",
      ...q.create,
    })),
  },
  failedEmail: { create: jest.fn(async () => ({ id: "fe" })) },
  emailSuppression: { findUnique: jest.fn(async () => null) },
  membership: {
    findFirst: jest.fn(async () => ({
      id: "m-1",
      organizationId: "org",
      userId: "u-guest",
      role: "LEARNER",
      status: "ACTIVE",
    })),
  },
  collaborator: {
    findMany: jest.fn(async () => [{ id: row.id }]),
    updateManyAndReturn: jest.fn(async () => [row]),
  },
  programAssignment: { updateMany: jest.fn(async () => ({ count: 0 })) },
  orgAuditLog: { create: jest.fn() },
  organization: { findUnique: jest.fn(async () => null) },
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return tx;
  },
}));

import { stageCollaboratorNotifications } from "@/lib/collaborators/notifications";
import { removeMember } from "@/lib/enterprise/member-removal";

const bellsTo = () =>
  tx.notificationOutbox.upsert.mock.calls.map(
    ([q]) => (q as { create: { recipients: string[] } }).create.recipients,
  );
const emailsTo = () =>
  tx.failedEmail.create.mock.calls.map(
    ([q]) => (q as { data: { recipient: string } }).data.recipient,
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockStageNotices.mockReturnValue(undefined);
  process.env.EMAIL_DELIVERY_MODE = "live";
});

it.each([
  ["INVITED", [["u-guest"]], ["guest@example.com"]],
  ["ACCEPTED", [], ["host@example.com"]],
  ["EXPIRED", [["u-guest"]], ["guest@example.com", "host@example.com"]],
] as const)(
  "%s reaches the right party inside the transaction; the host's bell switch drops only the bell",
  async (event, bells, emails) => {
    await stageCollaboratorNotifications(tx as never, event, row);
    expect(bellsTo()).toEqual(bells);
    expect(emailsTo()).toEqual(emails);
  },
);

it("an org member removal stages one WITHDRAWN notice per row for the host and nothing for the member", async () => {
  mockStageNotices.mockResolvedValue({ bells: [], emails: [] });
  await removeMember({
    orgId: "org",
    memberId: "m-1",
    actor: { membershipId: "m-admin", role: "OWNER" },
    actorUserId: "u-admin",
    force: false,
  });
  expect(mockStageNotices).toHaveBeenCalledTimes(1);
  expect(mockStageNotices).toHaveBeenCalledWith(tx, "WITHDRAWN", row, {});
  expect(tx.collaborator.updateManyAndReturn).toHaveBeenCalledWith({
    where: { id: "c-1", status: { in: ["PENDING", "ACCEPTED"] } },
    data: { status: "REMOVED", endedByUserId: "u-admin" },
  });
  expect(mockRevoke).toHaveBeenCalledWith(
    { planType: "webinar", planId: "wp-1" },
    "u-guest",
    GENERATION,
  );
  expect(mockFlush).toHaveBeenCalledTimes(1);
});
