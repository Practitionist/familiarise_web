/** @jest-environment node */
/** The lapse locks the case row before it reads eligibility, so a run that read it first cannot record a second lapse. */

const mockStatements: string[] = [];
const mockTx = {
  $queryRaw: jest.fn(async (sql: TemplateStringsArray) => {
    const text = sql.join("?");
    mockStatements.push(text.includes("FOR UPDATE") ? "lock" : "eligibility");
    return text.includes("FOR UPDATE") ? [{ id: "case-1" }] : [];
  }),
  supportCase: {
    findUniqueOrThrow: jest.fn(async () => ({ updatedAt: new Date(0) })),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(async () => [{ id: "case-1" }]),
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(mockTx)),
  },
  ALLOCATION_TX_MAX_WAIT_MS: 1000,
  ALLOCATION_TX_TIMEOUT_MS: 1000,
}));

import { sweepConductRemovalDeadlines } from "@/lib/support/conduct-removal-case";

it("takes the row lock before it tests eligibility", async () => {
  await sweepConductRemovalDeadlines({ limit: 5, now: new Date(), errors: [] });
  expect(mockStatements[0]).toBe("lock");
});
