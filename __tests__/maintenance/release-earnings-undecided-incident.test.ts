/**
 * @jest-environment node
 */

// Invariant: while a declared incident has not finished its enumeration, an
// earning whose booking has a session overlapping the incident window is not
// released, by the cohort read or the claim's CAS; once the incident is
// enumerated the gate lifts.

jest.mock("../../lib/cron/with-cron-lock", () =>
  jest.requireActual("../fixtures/earnings-release-world").cronLockModule(),
);

jest.mock("../../lib/prisma", () =>
  jest
    .requireActual("../fixtures/earnings-release-world")
    .earningsPrismaModule(),
);

import prisma from "@/lib/prisma";
import type { Row } from "../fixtures/mem-db";
import {
  seedEarnings,
  type EarningsTable as Table,
} from "../fixtures/earnings-release-world";
import { releaseSponsorTrustPark } from "@/lib/payments/payouts/trust-park";
import { releaseEarningsFromHold } from "@/scripts/earnings/release-earnings";

const at = (hour: number) => new Date(Date.UTC(2026, 4, 20, hour));

const appointment: Row = { subscriptionId: null, payment: [] };
appointment.occurrences = [
  {
    startsAt: at(10),
    endsAt: at(11),
    completionStatus: "COMPLETED",
    isTentative: false,
    deletedAt: null,
    outcome: "HELD",
    outcomeConfirmedAt: null,
    seatsSettledAt: null,
    appointment,
  },
];
const payment: Row = {
  id: "pay_1",
  organizationId: "org_sponsor",
  appointmentId: "appt_1",
  appointment,
  refunds: [],
  disputes: [],
  refundOwedKey: null,
};

const consultantEarnings = prisma.consultantEarnings as unknown as Table;
const organizationEarnings = prisma.organizationEarnings as unknown as Table;
const incidents = (prisma as unknown as { platformIncident: Table })
  .platformIncident.rows;

function declare(startsAt: Date, endsAt: Date, enumeratedAt: Date | null) {
  incidents.splice(0, incidents.length, { startsAt, endsAt, enumeratedAt });
}

beforeEach(() => {
  jest.clearAllMocks();
  incidents.splice(0, incidents.length);
  seedEarnings(
    { consultantEarnings, organizationEarnings },
    "PENDING",
    payment,
  );
});

it("holds both arms while an overlapping incident is undecided, releases them once it is enumerated", async () => {
  declare(at(10), at(12), null);

  expect(await releaseEarningsFromHold()).toMatchObject({
    releasedCount: 0,
    organizationEarningsReleased: 0,
  });
  expect(consultantEarnings.rows[0].status).toBe("PENDING");
  expect(organizationEarnings.rows[0].status).toBe("PENDING");

  declare(at(10), at(12), new Date());
  expect(await releaseEarningsFromHold()).toMatchObject({
    releasedCount: 1,
    organizationEarningsReleased: 1,
  });
});

it("an undecided incident that misses the session holds nothing", async () => {
  declare(at(11), at(12), null);

  expect(await releaseEarningsFromHold()).toMatchObject({
    releasedCount: 1,
    organizationEarningsReleased: 1,
  });
});

it("the claim restates the incident gate on both arms", async () => {
  declare(at(10), at(12), null);
  // Each cohort read hands back the row anyway; only the claim's WHERE stands.
  for (const table of [consultantEarnings, organizationEarnings]) {
    table.findMany.mockImplementationOnce(async () => [{ ...table.rows[0] }]);
  }

  expect(await releaseEarningsFromHold()).toMatchObject({
    releasedCount: 0,
    organizationEarningsReleased: 0,
  });
  expect(consultantEarnings.rows[0].status).toBe("PENDING");
  expect(organizationEarnings.rows[0].status).toBe("PENDING");
});

it("a sponsor's trust-park release leaves a session under an undecided incident PENDING, and makes it READY once enumerated", async () => {
  const tables = { consultantEarnings, organizationEarnings };
  declare(at(10), at(12), null);
  seedEarnings(tables, "PENDING_TRUST", payment);

  expect(
    await releaseSponsorTrustPark(prisma as never, "org_sponsor"),
  ).toMatchObject({ ready: 0, pending: 2 });
  expect(consultantEarnings.rows[0].status).toBe("PENDING");
  expect(organizationEarnings.rows[0].status).toBe("PENDING");

  declare(at(10), at(12), new Date());
  seedEarnings(tables, "PENDING_TRUST", payment);

  expect(
    await releaseSponsorTrustPark(prisma as never, "org_sponsor"),
  ).toMatchObject({ ready: 2, pending: 0 });
});
