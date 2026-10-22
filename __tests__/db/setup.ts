/**
 * Database-tier setup: re-checks the target per suite, then stubs the edges
 * that would leave the machine. Outbox and email staging stay real (rows only).
 */
import prisma from "../../lib/prisma";
import { assertDisposableDatabase } from "./guard";

assertDisposableDatabase();

jest.mock("../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: jest.fn(async () => undefined),
  restoreClassSeatCredits: jest.fn(async () => undefined),
}));

jest.mock("../../lib/supabase-storage-core", () => ({
  __esModule: true,
  supabaseAdmin: null,
  adminStorage: jest.fn(() => {
    throw new Error("Storage is stubbed in the database tier");
  }),
  ensureBucketExists: jest.fn(async () => true),
  removeObjects: jest.fn(async () => true),
}));

afterAll(async () => {
  await prisma.$disconnect();
});
