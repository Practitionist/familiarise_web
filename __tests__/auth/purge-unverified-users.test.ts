/**
 * @jest-environment node
 */

const mockFindMany = jest.fn();
const mockDeleteMany = jest.fn();
const mockReport = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
  },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _opts: unknown, fn: () => Promise<unknown>) =>
    fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryMessage: (...args: unknown[]) => mockReport(...args),
}));

import {
  purgeUnverifiedUsers,
  unverifiedUserPurgeWhere,
} from "../../lib/auth/purge-unverified-users";

const NOW = new Date("2026-10-09T03:00:00Z");

afterEach(() => jest.clearAllMocks());

describe("unverifiedUserPurgeWhere", () => {
  const where = unverifiedUserPurgeWhere(NOW);

  it("selects never-verified consumers older than 7 days", () => {
    expect(where).toMatchObject({
      emailVerified: false,
      role: "CONSULTEE",
      erasedAt: null,
      createdAt: { lt: new Date("2026-10-02T03:00:00Z") },
    });
  });

  it("spares anyone with another sign-in method, a profile or any activity", () => {
    expect(where).toMatchObject({
      accounts: { every: { providerId: "credential" } },
      consultantProfileId: null,
      consulteeProfileId: null,
      staffProfileId: null,
      adminProfileId: null,
      orgWorkspaceProfileId: null,
      Payment: { none: {} },
      consumerInvoices: { none: {} },
      appointmentParticipations: { none: {} },
      referralCredits: { none: {} },
      memberships: { none: {} },
    });
  });
});

describe("purgeUnverifiedUsers", () => {
  it("re-applies the predicate in each delete and reports failures once", async () => {
    mockFindMany.mockResolvedValue([{ id: "u1" }, { id: "u2" }, { id: "u3" }]);
    mockDeleteMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 }) // verified mid-run
      .mockRejectedValueOnce(new Error("fk"));

    const result = await purgeUnverifiedUsers({ limit: 3, now: NOW });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 3 }),
    );
    for (const [i, id] of ["u1", "u2", "u3"].entries()) {
      expect(mockDeleteMany.mock.calls[i][0].where).toMatchObject({
        ...unverifiedUserPurgeWhere(NOW),
        id,
      });
    }
    expect(result).toEqual({
      success: false,
      scanned: 3,
      purged: 1,
      failed: 1,
    });
    expect(mockReport).toHaveBeenCalledTimes(1);
  });
});
