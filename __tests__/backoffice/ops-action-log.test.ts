/**
 * @jest-environment node
 */

/**
 * #1771 K-1 — a console door writes exactly one OpsActionLog row carrying the
 * actor and the reason, in the door's own transaction; no reason, no door.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "staff_1", role: "STAFF" } },
  })),
}));

const create = jest.fn(async (_args: unknown) => ({ id: "row" }));
const tx = { opsActionLog: { create } };
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
    opsActionLog: { create: (a: unknown) => create(a) },
  },
}));

import { NextRequest } from "next/server";
import { z } from "zod";
import { withOpsAction } from "../../lib/backoffice/ops-action-log";

const door = withOpsAction(
  "appointments.manage",
  "class.note",
  { classId: z.string() },
  {
    mode: "tx",
    run: async (_tx, ctx) => ({
      target: { kind: "Class", id: ctx.body.classId },
      response: { ok: true },
    }),
  },
);

const post = (body: unknown) =>
  door(
    new NextRequest("https://x.test/api", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => create.mockClear());

it("writes one row with the actor, the role and the reason", async () => {
  const res = await post({ classId: "cls_1", reason: "learner asked twice" });
  expect(res.status).toBe(200);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0][0]).toMatchObject({
    data: {
      actorUserId: "staff_1",
      actorRole: "STAFF",
      surface: "appointments.manage",
      action: "class.note",
      targetKind: "Class",
      targetId: "cls_1",
      reason: "learner asked twice",
    },
  });
});

it("refuses a door without a reason and writes nothing", async () => {
  const res = await post({ classId: "cls_1", reason: "ok" });
  expect(res.status).toBe(400);
  expect(create).not.toHaveBeenCalled();
});
