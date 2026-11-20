/**
 * @jest-environment node
 */

/**
 * The Read Committed booking transactions (allocation, reschedule, cancel) are
 * replayed once when Postgres aborts them as a deadlock victim, and never on a
 * business error.
 */

const mockTransaction = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));

import fs from "node:fs";
import path from "node:path";

import { bookingTransaction } from "@/lib/db/booking-transaction";

const deadlock = () => new Error("40P01: deadlock detected");

beforeEach(() => mockTransaction.mockReset());

it("replays a deadlock victim once with the same callback and options", async () => {
  const fn = jest.fn();
  mockTransaction
    .mockRejectedValueOnce(deadlock())
    .mockResolvedValueOnce("committed");

  await expect(bookingTransaction(fn, { timeout: 30_000 })).resolves.toBe(
    "committed",
  );
  expect(mockTransaction).toHaveBeenCalledTimes(2);
  expect(mockTransaction).toHaveBeenNthCalledWith(2, fn, { timeout: 30_000 });
});

it("gives up after one replay", async () => {
  mockTransaction.mockRejectedValue(deadlock());
  await expect(bookingTransaction(jest.fn())).rejects.toThrow(/deadlock/);
  expect(mockTransaction).toHaveBeenCalledTimes(2);
});

it("never replays a business refusal", async () => {
  mockTransaction.mockRejectedValue(
    Object.assign(new Error("not cancellable"), { httpStatus: 409 }),
  );
  await expect(bookingTransaction(jest.fn())).rejects.toThrow(
    /not cancellable/,
  );
  expect(mockTransaction).toHaveBeenCalledTimes(1);
});

describe("the before-attempt hook", () => {
  it("runs ahead of every attempt: a deadlock thrown once runs it twice", async () => {
    const order: string[] = [];
    const beforeAttempt = jest.fn(async () => {
      order.push("renew");
    });
    mockTransaction
      .mockImplementationOnce(async () => {
        order.push("attempt");
        throw deadlock();
      })
      .mockImplementationOnce(async () => {
        order.push("attempt");
        return "committed";
      });
    const fn = jest.fn();

    await expect(
      bookingTransaction(fn, { timeout: 30_000, beforeAttempt }),
    ).resolves.toBe("committed");
    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["renew", "attempt", "renew", "attempt"]);
    // The hook is the caller's; Prisma gets only its own options.
    expect(mockTransaction).toHaveBeenNthCalledWith(2, fn, { timeout: 30_000 });
  });

  it("a hook that throws stops the attempt before a transaction opens", async () => {
    const lost = Object.assign(new Error("lock lost"), { httpStatus: 409 });
    await expect(
      bookingTransaction(jest.fn(), {
        beforeAttempt: async () => {
          throw lost;
        },
      }),
    ).rejects.toBe(lost);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

it("cancel and reschedule renew their locks before each attempt", () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(process.cwd(), rel), "utf8");
  expect(
    read("app/api/appointments/[appointmentId]/reschedule/route.ts"),
  ).toMatch(/beforeAttempt: \(\) => renewAppointmentLock\(lock\)/);
  const cancel = read("app/api/appointments/[appointmentId]/cancel/route.ts");
  expect(cancel).toMatch(
    /beforeAttempt: async \(\) => \{\s*await renewEventLock\(\);\s*await renewAppointmentLock\(lock\);\s*\}/,
  );
});

it.each([
  "lib/booking/allocation/modes/auto.ts",
  "lib/booking/allocation/modes/manual.ts",
  "lib/booking/allocation/modes/use-requested.ts",
  "app/api/appointments/[appointmentId]/reschedule/route.ts",
  "app/api/appointments/[appointmentId]/cancel/route.ts",
])("%s writes through bookingTransaction", (rel) => {
  const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
  expect(src).toContain("bookingTransaction(");
  expect(src).not.toMatch(/prisma\.\$transaction\(/);
});
