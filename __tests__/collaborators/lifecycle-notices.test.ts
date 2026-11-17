/** @jest-environment node */

// Each collaborator transition stages its bells and emails inside its own
// transaction, to the party that did not make it; a co-presenter joining or
// leaving is told to the plan's seat holders; and an org member removal stages
// only the host's WITHDRAWN notice per row.

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
  ...jest.requireActual("@/lib/booking/participants"),
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
  acceptedAt: new Date("2026-11-01T00:00:00Z") as Date | null,
  endedByUserId: null as string | null,
  updatedAt: new Date("2026-11-07T00:00:00Z"),
};
const person = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  email: `${id}@example.com`,
  name: id,
  ...extra,
});
const MUTED = { notificationPreferences: { inAppEnabled: false } };
let users: Record<string, Record<string, unknown>>;
const hostProfile = {
  userId: "u-host",
  user: { name: "Host", erasedAt: null },
};
let plan: {
  title: string;
  organizationId: string | null;
  organization: { name: string } | null;
  consultantProfile: typeof hostProfile | null;
};
let seatHolders: string[];
let claims: Set<string>;

type Created = { recipients: string[]; payload: Record<string, unknown> };
const tx: Record<string, Record<string, jest.Mock> | jest.Mock> & {
  notificationOutbox: { upsert: jest.Mock; createManyAndReturn: jest.Mock };
  failedEmail: { create: jest.Mock; createManyAndReturn: jest.Mock };
  membership: { findFirst: jest.Mock; findMany: jest.Mock };
  appointmentParticipant: { findMany: jest.Mock };
  collaborator: { findMany: jest.Mock; updateManyAndReturn: jest.Mock };
} = {
  $transaction: jest.fn(async (run: (db: unknown) => unknown) => run(tx)),
  webinarPlan: { findUnique: jest.fn(async () => plan) },
  consultantProfile: {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
      where.id === "cp-guest"
        ? { userId: "u-guest", user: { name: "Guest", erasedAt: null } }
        : hostProfile,
    ),
  },
  user: {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
      users[where.id] ? { name: users[where.id].name, erasedAt: null } : null,
    ),
    findMany: jest.fn(async (q: { where: { id: { in: string[] } } }) =>
      q.where.id.in.map((id) => users[id]).filter(Boolean),
    ),
  },
  notificationOutbox: {
    upsert: jest.fn(async (q: { create: Record<string, unknown> }) => ({
      id: "bell",
      ...q.create,
    })),
    createManyAndReturn: jest.fn(async (q: { data: Created[] }) =>
      q.data.map((d, i) => ({ id: `page-${i}`, ...d })),
    ),
  },
  failedEmail: {
    create: jest.fn(async () => ({ id: "fe" })),
    createManyAndReturn: jest.fn(async (q: { data: { recipient: string }[] }) =>
      q.data.map((d, i) => ({ id: `fe-${i}`, recipient: d.recipient })),
    ),
  },
  emailSuppression: {
    findUnique: jest.fn(async () => null),
    findMany: jest.fn(async () => []),
  },
  idempotencyRecord: {
    createMany: jest.fn(async (q: { data: { key: string }[] }) => {
      const fresh = q.data.filter((d) => !claims.has(d.key));
      for (const d of fresh) claims.add(d.key);
      return { count: fresh.length };
    }),
  },
  membership: {
    findFirst: jest.fn(async () => ({
      id: "m-1",
      organizationId: "org",
      userId: "u-guest",
      role: "LEARNER",
      status: "ACTIVE",
    })),
    findMany: jest.fn(async () => [{ userId: "u-op1" }, { userId: "u-op2" }]),
  },
  appointmentParticipant: {
    findMany: jest.fn(async () => seatHolders.map((userId) => ({ userId }))),
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

import { rolesWithOrgPermission } from "@/lib/auth/org-permissions";
import { stageCollaboratorNotifications } from "@/lib/collaborators/notifications";
import { removeMember } from "@/lib/enterprise/member-removal";
import { requiredNoticeOf } from "@/lib/notifications/required-notices";

const bells = (): Created[] =>
  tx.notificationOutbox.upsert.mock.calls.map(
    ([q]) => (q as { create: Created }).create,
  );
const bellsTo = () => bells().map((b) => b.recipients);
const emailsTo = () =>
  tx.failedEmail.create.mock.calls.map(
    ([q]) => (q as { data: { recipient: string } }).data.recipient,
  );
const learnerBells = (): Created[] =>
  tx.notificationOutbox.createManyAndReturn.mock.calls.flatMap(
    ([q]) => (q as { data: Created[] }).data,
  );
const learnerEmailsTo = () =>
  tx.failedEmail.createManyAndReturn.mock.calls.flatMap(([q]) =>
    (q as { data: { recipient: string }[] }).data.map((d) => d.recipient),
  );
const stage = (
  event: Parameters<typeof stageCollaboratorNotifications>[1],
  over: Partial<typeof row> = {},
) => stageCollaboratorNotifications(tx as never, event, { ...row, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  mockStageNotices.mockReturnValue(undefined);
  process.env.EMAIL_DELIVERY_MODE = "live";
  users = {
    "u-guest": person("u-guest"),
    "u-host": person("u-host", MUTED),
    "u-op": person("u-op"),
    "u-op1": person("u-op1"),
    "u-op2": person("u-op2"),
    "u-l1": person("u-l1", MUTED),
    "u-l2": person("u-l2"),
  };
  plan = {
    title: "Systems",
    organizationId: null,
    organization: null,
    consultantProfile: hostProfile,
  };
  seatHolders = [];
  claims = new Set();
});

const GUEST = "u-guest@example.com";
const HOST = "u-host@example.com";

it.each([
  ["INVITED", [["u-guest"]], [GUEST]],
  ["TERMS_CHANGED", [["u-guest"]], [GUEST]],
  ["ACCEPTED", [["u-host"]], [GUEST, HOST]],
  ["DECLINED", [["u-host"]], [HOST]],
  ["WITHDRAWN", [["u-host"]], [HOST]],
  ["REMOVED", [["u-guest"]], [GUEST]],
  ["EXPIRED", [["u-guest"], ["u-host"]], [GUEST, HOST]],
] as const)(
  "%s is a required notice to the party that did not act, whatever their switches say",
  async (event, toBells, toEmails) => {
    await stage(event);
    expect(bellsTo()).toEqual(toBells);
    expect(emailsTo()).toEqual(toEmails);
    for (const bell of bells()) {
      expect(requiredNoticeOf(bell.payload)).toBe("COLLABORATION_CHANGED");
    }
  },
);

describe("the reminder before an invitation lapses", () => {
  it("is optional: the invitee's bell switch drops the bell", async () => {
    users["u-guest"] = person("u-guest", MUTED);
    await stage("EXPIRING_SOON", { acceptedAt: null });
    expect(bellsTo()).toEqual([]);
  });

  it("is sent once for an invitation's terms, and again only after they change", async () => {
    const first = await stage("EXPIRING_SOON", { acceptedAt: null });
    expect(first.bells).toHaveLength(1);
    expect(requiredNoticeOf(bells()[0].payload)).toBeNull();
    expect(emailsTo()).toEqual([GUEST]);

    expect(await stage("EXPIRING_SOON", { acceptedAt: null })).toEqual({});
    expect(bellsTo()).toHaveLength(1);
    expect(emailsTo()).toHaveLength(1);

    await stage("EXPIRING_SOON", {
      acceptedAt: null,
      updatedAt: new Date("2026-11-09T00:00:00Z"),
    });
    expect(bellsTo()).toHaveLength(2);
    expect(emailsTo()).toHaveLength(2);
  });
});

describe("the host side", () => {
  it("on a plan with no owning expert is the organisation's catalogue managers, not whoever invited", async () => {
    plan = {
      title: "Systems",
      organizationId: "org",
      organization: { name: "Academy" },
      consultantProfile: null,
    };
    await stage("ACCEPTED");
    expect(tx.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org",
          status: "ACTIVE",
          role: { in: rolesWithOrgPermission("catalog.manage") },
        },
      }),
    );
    expect(bellsTo()).toEqual([["u-op1", "u-op2"]]);
    expect(bells()[0].payload).toMatchObject({
      organizationId: "org",
      scope: "org",
      dashboardUrl: expect.stringContaining(
        "/dashboard/organization/org/collaborations",
      ),
    });
    expect(emailsTo()).toEqual([
      GUEST,
      "u-op1@example.com",
      "u-op2@example.com",
    ]);
  });

  it("never includes the operator who ended the row", async () => {
    plan = { ...plan, organizationId: "org", consultantProfile: null };
    await stage("WITHDRAWN", { endedByUserId: "u-op1" });
    expect(bellsTo()).toEqual([["u-op2"]]);
  });
});

describe("who a removal names", () => {
  it("a withdrawn invitation reads as one, and names the operator who withdrew it", async () => {
    await stage("REMOVED", { acceptedAt: null, endedByUserId: "u-op" });
    expect(bells()[0].payload).toMatchObject({
      pendingInvite: true,
      ownerName: "u-op",
    });
  });

  it("a manager ending their own place is told to the host as someone leaving, not to themself as a removal", async () => {
    await stage("REMOVED", { endedByUserId: "u-guest" });
    expect(bellsTo()).toEqual([["u-host"]]);
    expect(emailsTo()).toEqual([HOST]);
    expect(bells()[0].payload).not.toHaveProperty("pendingInvite");
  });
});

describe("seat holders", () => {
  it.each([
    ["ACCEPTED", "u-guest is now co-hosting Systems."],
    ["WITHDRAWN", "u-guest is no longer co-hosting Systems."],
    ["REMOVED", "u-guest is no longer co-hosting Systems."],
  ] as const)(
    "hear, as a required notice, that the co-presenter changed on %s",
    async (event, sentence) => {
      seatHolders = ["u-l1", "u-l2"];
      users["u-guest"] = person("u-guest");
      tx.consultantProfile.findUnique.mockImplementation(
        async ({ where }: { where: { id: string } }) =>
          where.id === "cp-guest"
            ? { userId: "u-guest", user: { name: "u-guest", erasedAt: null } }
            : hostProfile,
      );
      await stage(event);
      expect(learnerBells()).toHaveLength(1);
      expect(learnerBells()[0].recipients).toEqual(["u-l1", "u-l2"]);
      expect(learnerBells()[0].payload).toMatchObject({ sentence });
      expect(requiredNoticeOf(learnerBells()[0].payload)).toBe(
        "COHOST_CHANGED",
      );
      expect(learnerEmailsTo()).toEqual([
        "u-l1@example.com",
        "u-l2@example.com",
      ]);
    },
  );

  it.each([
    ["a plan nobody has booked", "ACCEPTED", {}, []],
    ["a crew role", "ACCEPTED", { role: "MODERATOR" as const }, ["u-l1"]],
    [
      "an invitation that never joined",
      "REMOVED",
      { acceptedAt: null },
      ["u-l1"],
    ],
    ["a declined invitation", "DECLINED", { acceptedAt: null }, ["u-l1"]],
  ] as const)("hear nothing about %s", async (_what, event, over, seats) => {
    seatHolders = [...seats];
    await stage(event, over as Partial<typeof row>);
    expect(learnerBells()).toEqual([]);
    expect(learnerEmailsTo()).toEqual([]);
  });
});

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
