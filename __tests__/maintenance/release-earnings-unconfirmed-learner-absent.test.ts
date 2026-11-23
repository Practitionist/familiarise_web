/**
 * @jest-environment node
 */

// Invariant: a consultation or trial earning whose session reads LEARNER_ABSENT
// stays PENDING until that verdict is confirmed, on both arms, in the release
// run, its idle probe and a sponsor's trust-park release; a subscription's
// earning releases per tranche and is not held by it.

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: jest.fn(
    async (_key: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

jest.mock("../../lib/prisma", () => {
  const { memTable } = jest.requireActual("../fixtures/mem-db");
  const client = {
    consultantEarnings: memTable([], "ce"),
    organizationEarnings: memTable([], "oe"),
  };
  return {
    __esModule: true,
    default: {
      ...client,
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(client)),
      $disconnect: jest.fn(),
    },
  };
});

import prisma from "@/lib/prisma";
import type { memTable, Row } from "../fixtures/mem-db";
import { releaseSponsorTrustPark } from "@/lib/payments/payouts/trust-park";
import {
  hasReleasableEarningsWork,
  releaseEarningsFromHold,
} from "@/scripts/earnings/release-earnings";

type Table = ReturnType<typeof memTable>;
const PAST = new Date("2026-06-01T00:00:00.000Z");
const consultantEarnings = prisma.consultantEarnings as unknown as Table;
const organizationEarnings = prisma.organizationEarnings as unknown as Table;
const db = () => ({ consultantEarnings, organizationEarnings }) as never;

function seed(
  status: "PENDING" | "PENDING_TRUST",
  opts: { confirmedAt?: Date | null; subscriptionId?: string | null } = {},
) {
  const subscriptionId = opts.subscriptionId ?? null;
  const occurrence: Row = {
    id: "occ_1",
    deletedAt: null,
    isTentative: false,
    completionStatus: "COMPLETED",
    outcome: "LEARNER_ABSENT",
    outcomeConfirmedAt: opts.confirmedAt ?? null,
    hostCancelledAt: null,
    voidedAt: null,
    seatsSettledAt: null,
    meeting: { endedReason: "session_timeout" },
    appointment: { subscriptionId },
  };
  const payment: Row = {
    id: "pay_1",
    amount: 100_000,
    organizationId: "org_sponsor",
    appointmentId: "apt_1",
    refunds: [],
    refundOwedKey: null,
    appointment: { subscriptionId, occurrences: [occurrence] },
  };
  consultantEarnings.rows.splice(0, consultantEarnings.rows.length, {
    id: "ce_1",
    status,
    holdUntil: PAST,
    consultantSharePaise: 80_000,
    consultantProfile: { user: { name: "C", email: "c@x" } },
    payment,
  });
  organizationEarnings.rows.splice(0, organizationEarnings.rows.length, {
    id: "oe_1",
    status,
    holdUntil: PAST,
    orgSharePaise: 10_000,
    organization: { name: "Host org" },
    payment,
  });
}

beforeEach(() => jest.clearAllMocks());

it("keeps both arms PENDING while the verdict is unconfirmed", async () => {
  seed("PENDING");
  expect(await hasReleasableEarningsWork(db(), new Date(), () => false)).toBe(
    false,
  );
  expect(await releaseEarningsFromHold()).toMatchObject({
    releasedCount: 0,
    organizationEarningsReleased: 0,
  });
  expect(consultantEarnings.rows[0].status).toBe("PENDING");
  expect(organizationEarnings.rows[0].status).toBe("PENDING");
});

it("releases both arms once the verdict is confirmed", async () => {
  seed("PENDING", { confirmedAt: PAST });
  expect(await hasReleasableEarningsWork(db(), new Date(), () => false)).toBe(
    true,
  );
  expect(await releaseEarningsFromHold()).toMatchObject({
    releasedCount: 1,
    organizationEarningsReleased: 1,
  });
  expect(consultantEarnings.rows[0].status).toBe("READY");
});

it("does not hold a subscription's earning", async () => {
  seed("PENDING", { subscriptionId: "sub_1" });
  expect(await releaseEarningsFromHold()).toMatchObject({ releasedCount: 1 });
});

it("a sponsor's trust-park release parks an unconfirmed one as PENDING, not READY", async () => {
  seed("PENDING_TRUST");
  expect(
    await releaseSponsorTrustPark(
      { consultantEarnings, organizationEarnings } as never,
      "org_sponsor",
    ),
  ).toMatchObject({ ready: 0, pending: 2 });
});
