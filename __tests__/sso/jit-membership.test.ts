/**
 * @jest-environment node
 */

/**
 * D11 — SSO JIT writes the typed Membership straight from the sso()
 * provisionUser hook. Covers the gates (org lifecycle, unverified seat cap),
 * idempotent re-login, and the provider-without-org misconfiguration.
 */

import { Prisma } from "@prisma/client";

const tx = {
  membership: { count: jest.fn(), create: jest.fn() },
};
const db = {
  membership: { findUnique: jest.fn() },
  organization: { findUnique: jest.fn() },
  $transaction: jest.fn(
    async (fn: (t: typeof tx) => unknown, _opts?: unknown) => fn(tx),
  ),
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return db;
  },
}));

const recordSystemEvent = jest.fn(async (_params: unknown) => {});
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: (params: unknown) => recordSystemEvent(params),
}));

const applyMembershipRoleEffects = jest.fn(
  async (_tx: unknown, _input: unknown) => ({
    consulteeProfileId: "consultee_1",
    consultantProfileId: null,
    payoutRecipient: "SELF" as const,
  }),
);
jest.mock("../../lib/api/organizations/membership-transitions", () => ({
  applyMembershipRoleEffects: (t: unknown, input: unknown) =>
    applyMembershipRoleEffects(t, input),
}));

import { provisionSsoMembership } from "@/lib/sso/jit-membership";
import { UNVERIFIED_ORG_SEAT_CAP } from "@/lib/enterprise/governance";

const input = {
  userId: "user_1",
  providerId: "oidc-abc",
  organizationId: "org_1",
};

function org(status: string, defaultRoleForAutoJoin?: string) {
  return {
    status,
    ssoSettings: defaultRoleForAutoJoin ? { defaultRoleForAutoJoin } : null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.membership.findUnique.mockResolvedValue(null);
  db.organization.findUnique.mockResolvedValue(org("ACTIVE"));
  tx.membership.count.mockResolvedValue(0);
  tx.membership.create.mockResolvedValue({ id: "m_1" });
});

it("creates an ACTIVE membership with the org's auto-join role in a Serializable transaction", async () => {
  db.organization.findUnique.mockResolvedValue(org("ACTIVE", "EXPERT"));
  applyMembershipRoleEffects.mockResolvedValueOnce({
    consulteeProfileId: null,
    consultantProfileId: "consultant_1",
    payoutRecipient: "SELF",
  } as never);

  await expect(provisionSsoMembership(input)).resolves.toEqual({
    kind: "joined",
    organizationId: "org_1",
    role: "EXPERT",
  });

  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
  expect(applyMembershipRoleEffects).toHaveBeenCalledWith(tx, {
    userId: "user_1",
    role: "EXPERT",
  });
  expect(tx.membership.create).toHaveBeenCalledWith({
    data: {
      userId: "user_1",
      organizationId: "org_1",
      role: "EXPERT",
      status: "ACTIVE",
      consulteeProfileId: null,
      consultantProfileId: "consultant_1",
      payoutRecipient: "SELF",
    },
  });
  // Seat cap only applies to unverified orgs.
  expect(tx.membership.count).not.toHaveBeenCalled();
  expect(recordSystemEvent).not.toHaveBeenCalled();
});

it("defaults to LEARNER when the org has no SSO settings row", async () => {
  await provisionSsoMembership(input);
  expect(tx.membership.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ role: "LEARNER" }),
  });
});

it("is a no-op on re-login when any membership row exists, whatever its status", async () => {
  db.membership.findUnique.mockResolvedValue({ id: "m_removed" });

  await expect(provisionSsoMembership(input)).resolves.toEqual({
    kind: "already_member",
    organizationId: "org_1",
  });

  expect(db.membership.findUnique).toHaveBeenCalledWith({
    where: {
      userId_organizationId: { userId: "user_1", organizationId: "org_1" },
    },
    select: { id: true },
  });
  expect(db.organization.findUnique).not.toHaveBeenCalled();
  expect(db.$transaction).not.toHaveBeenCalled();
});

it("treats a concurrent login winning the unique (P2002) as already joined", async () => {
  tx.membership.create.mockRejectedValue(
    new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    }),
  );

  await expect(provisionSsoMembership(input)).resolves.toEqual({
    kind: "already_member",
    organizationId: "org_1",
  });
});

it("propagates any other failure so the callback never signs the user in half-provisioned", async () => {
  tx.membership.create.mockRejectedValue(new Error("connection reset"));

  await expect(provisionSsoMembership(input)).rejects.toThrow(
    "connection reset",
  );
});

it.each(["SUSPENDED", "DEACTIVATED"])(
  "refuses to join a %s organization and records why",
  async (status) => {
    db.organization.findUnique.mockResolvedValue(org(status));

    await expect(provisionSsoMembership(input)).resolves.toEqual({
      kind: "skipped",
      reason: "ORGANIZATION_INACTIVE",
    });

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(recordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_1",
        category: "SSO",
        severity: "WARN",
        context: expect.objectContaining({
          userId: "user_1",
          organizationStatus: status,
        }),
      }),
    );
  },
);

it("refuses a PENDING_VERIFICATION org at the seat cap, counting inside the transaction", async () => {
  db.organization.findUnique.mockResolvedValue(org("PENDING_VERIFICATION"));
  tx.membership.count.mockResolvedValue(UNVERIFIED_ORG_SEAT_CAP);

  await expect(provisionSsoMembership(input)).resolves.toEqual({
    kind: "skipped",
    reason: "SEAT_CAP_REACHED",
  });

  expect(tx.membership.count).toHaveBeenCalledWith({
    where: { organizationId: "org_1", status: "ACTIVE" },
  });
  expect(applyMembershipRoleEffects).not.toHaveBeenCalled();
  expect(tx.membership.create).not.toHaveBeenCalled();
  expect(recordSystemEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      organizationId: "org_1",
      category: "SSO",
      severity: "WARN",
    }),
  );
});

it("admits a PENDING_VERIFICATION org below the seat cap", async () => {
  db.organization.findUnique.mockResolvedValue(org("PENDING_VERIFICATION"));
  tx.membership.count.mockResolvedValue(UNVERIFIED_ORG_SEAT_CAP - 1);

  await expect(provisionSsoMembership(input)).resolves.toMatchObject({
    kind: "joined",
  });
});

it("retries a serialization abort instead of skipping the join", async () => {
  tx.membership.create
    .mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("serialization failure", {
        code: "P2034",
        clientVersion: "test",
      }),
    )
    .mockResolvedValueOnce({ id: "m_1" });

  await expect(provisionSsoMembership(input)).resolves.toMatchObject({
    kind: "joined",
  });
  expect(db.$transaction).toHaveBeenCalledTimes(2);
});

it("skips a provider that is not linked to an organization", async () => {
  await expect(
    provisionSsoMembership({ ...input, organizationId: null }),
  ).resolves.toEqual({
    kind: "skipped",
    reason: "PROVIDER_WITHOUT_ORGANIZATION",
  });

  expect(db.membership.findUnique).not.toHaveBeenCalled();
  expect(recordSystemEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      category: "SSO",
      context: { userId: "user_1", providerId: "oidc-abc" },
    }),
  );
});

it("skips a provider whose organization no longer exists", async () => {
  db.organization.findUnique.mockResolvedValue(null);

  await expect(provisionSsoMembership(input)).resolves.toEqual({
    kind: "skipped",
    reason: "ORGANIZATION_NOT_FOUND",
  });
  expect(db.$transaction).not.toHaveBeenCalled();
});
