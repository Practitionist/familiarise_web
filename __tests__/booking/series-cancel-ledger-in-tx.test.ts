/**
 * @jest-environment node
 */

/**
 * A whole-class cancel nets each seat from ledgers read on its own transaction,
 * under the event and appointment locks, never from a snapshot taken before them.
 */

import fs from "node:fs";
import path from "node:path";

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { classSeriesLedgers } from "@/lib/payments/operations/event-refunds";
import type { PrismaLike } from "@/lib/prisma";

const ROUTE = path.join(
  process.cwd(),
  "app/api/appointments/[appointmentId]/cancel/route.ts",
);

it("reads every seat's ledger only through the client it is given", async () => {
  const boughtAt = new Date("2026-10-01T00:00:00Z");
  const db = {
    payment: {
      findMany: jest.fn(async () => [
        {
          id: "pay-a",
          amount: 10_000,
          userId: "u-a",
          createdAt: boughtAt,
          appointmentId: "appt-1",
        },
      ]),
    },
    appointmentParticipant: {
      findMany: jest.fn(async () => [
        { userId: "u-a", createdAt: boughtAt, sessionsPurchased: 10 },
      ]),
    },
    appointment: {
      findUnique: jest.fn(async () => ({
        class: { classPlan: { totalSessions: 10 } },
      })),
    },
    appointmentOccurrence: { findMany: jest.fn(async () => []) },
    refund: { findMany: jest.fn(async () => [{ amountPaise: 1_000 }]) },
  };

  const ledgers = await classSeriesLedgers(
    "cls-1",
    db as unknown as PrismaLike,
  );

  expect(ledgers.get("pay-a")).toMatchObject({
    heldCount: 10,
    occRefundedPaise: 1_000,
  });
  expect(db.appointmentOccurrence.findMany).toHaveBeenCalled();
  expect(db.refund.findMany).toHaveBeenCalled();
});

it("the cancel route reads the ledgers on its transaction, inside the locks", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  const read = src.indexOf("classSeriesLedgers(");
  expect(read).toBeGreaterThan(src.indexOf("withEventCheckoutLock("));
  expect(src.slice(read, read + 80)).toMatch(
    /classSeriesLedgers\(appointment\.class\.id, tx\)/,
  );
  expect(src.match(/classSeriesLedgers\(/g)).toHaveLength(1);
});
