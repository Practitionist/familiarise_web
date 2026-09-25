/**
 * @jest-environment node
 */

// Classic P2002 carries `meta.target`; Prisma 7's pg adapter carries 23505 in `driverAdapterError`.
import { Prisma } from "@prisma/client";

import { isUniqueViolationOn } from "@/lib/db/unique-violation";

const p2002 = (meta: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta,
  });

it("matches the named column in both Prisma error shapes, and nothing else", () => {
  const classic = p2002({ target: ["userId", "clientIdempotencyKey"] });
  const adapter = p2002({
    driverAdapterError: {
      cause: {
        originalCode: "23505",
        kind: "UniqueConstraintViolation",
        constraint: { fields: ['"dedupeKey"'] },
      },
    },
  });
  expect(isUniqueViolationOn(classic, "clientIdempotencyKey")).toBe(true);
  expect(isUniqueViolationOn(adapter, "dedupeKey")).toBe(true);
  expect(isUniqueViolationOn(adapter, "refundId")).toBe(false);
  expect(isUniqueViolationOn(new Error("dedupeKey"), "dedupeKey")).toBe(false);
});
