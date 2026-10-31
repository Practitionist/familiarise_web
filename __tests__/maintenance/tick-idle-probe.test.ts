/** @jest-environment node */
import { NextRequest } from "next/server";

const create = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ $queryRaw: async () => [] }),
    systemJobExecution: { create: (...a: unknown[]) => create(...a) },
  },
}));
jest.mock("../../lib/cron/cleanup-route", () => ({
  bearerMatches: (header: string | null, secret: string) =>
    header === `Bearer ${secret}`,
}));
jest.mock("../../lib/cron/cleanup-registry", () => ({
  CLEANUP_JOB_BUILDERS: {
    "maintenance-booking-remediation": {
      idle: { hasWork: jest.fn(async () => false) },
    },
    "release-earnings": { idle: { hasWork: jest.fn(async () => true) } },
    "sync-payment-earnings": {
      idle: {
        hasWork: jest.fn(async () => {
          throw new Error("statement timeout");
        }),
      },
    },
    "reconcile-ledgers": { idle: { alwaysRun: "aggregates" } },
  },
}));

import { POST } from "../../app/api/health/jobs/tick/route";
import { idleTargets } from "../../lib/cron/idle-probe";
import prisma from "../../lib/prisma";
import { CLEANUP_JOB_BUILDERS } from "../../lib/cron/cleanup-registry";

const due = Object.keys(CLEANUP_JOB_BUILDERS);
function probeOf(slug: string) {
  const idle = CLEANUP_JOB_BUILDERS[slug].idle;
  return "hasWork" in idle ? jest.mocked(idle.hasWork) : null;
}
const call = (targets: string[]) =>
  POST(
    new NextRequest(
      `https://x.test/api/health/jobs/tick?tickId=00000000-0000-8000-8000-000000000000&slot=2026-11-01T10:00:00.000Z&due=${targets.join(",")}`,
      { method: "POST", headers: { authorization: "Bearer s3cret" } },
    ),
  );

beforeEach(() => {
  jest.clearAllMocks();
  create.mockReset().mockResolvedValue({ id: "tick" });
  process.env.CRON_SECRET = "s3cret";
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("tick claim idle probe", () => {
  it("skips only a probed job with no work, recording it on the claim row first", async () => {
    const res = await call(due);
    expect(await res.json()).toEqual({
      claimed: true,
      idle: ["maintenance-booking-remediation"],
    });
    expect(create.mock.calls[0][0].data.result).toMatchObject({
      idle: ["maintenance-booking-remediation"],
      idleCount: 1,
    });
  });

  it("fails open: a throwing probe, an unknown name and an always-run job are dispatched", async () => {
    const body = await (await call([...due, "not-a-target"])).json();
    expect(body.idle).not.toContain("sync-payment-earnings");
    expect(body.idle).not.toContain("reconcile-ledgers");
    expect(probeOf("release-earnings")).toHaveBeenCalled();
  });

  it("probes nothing once the budget is spent, so every target runs", async () => {
    const idle = await idleTargets(due, prisma, new Date(), Date.now() - 1);
    expect(idle).toEqual([]);
    expect(probeOf("maintenance-booking-remediation")).not.toHaveBeenCalled();
  });

  it("answers claimed:false to a second dispatch of the slot", async () => {
    create.mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "P2002" }),
    );
    expect(await (await call(due)).json()).toEqual({ claimed: false });
  });
});
