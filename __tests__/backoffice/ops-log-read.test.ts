/**
 * @jest-environment node
 */

/**
 * #1771 K-9 — the audit read: a STAFF viewer gets their own rows whatever
 * actor they ask for; an ADMIN may filter by any actor.
 */

const findMany = jest.fn(async (_a: unknown) => []);
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    opsActionLog: {
      findMany: (a: unknown) => findMany(a),
      count: async () => 0,
    },
  },
}));

import { readOpsLog } from "../../lib/backoffice/ops-log-read";

const whereOf = () =>
  (findMany.mock.calls.at(-1)?.[0] as { where: Record<string, unknown> }).where;

it("pins a staff viewer to their own rows", async () => {
  await readOpsLog({
    viewer: { userId: "staff_1", role: "STAFF" },
    filters: { actorUserId: "admin_1", surface: "refunds.manage" },
    page: 1,
  });
  expect(whereOf()).toEqual({
    actorUserId: "staff_1",
    surface: "refunds.manage",
  });
});

it("lets an admin filter by any actor, or read every row", async () => {
  await readOpsLog({
    viewer: { userId: "admin_1", role: "ADMIN" },
    filters: { actorUserId: "staff_1" },
    page: 1,
  });
  expect(whereOf()).toEqual({ actorUserId: "staff_1" });
  await readOpsLog({
    viewer: { userId: "admin_1", role: "ADMIN" },
    filters: {},
    page: 1,
  });
  expect(whereOf()).toEqual({});
});
