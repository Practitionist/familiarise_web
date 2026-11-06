/**
 * Doubles for suites that call the allocator's availability search directly.
 * Importing this module mocks the Prisma client and the lock module the search
 * imports (appointmentlock pulls @upstash/redis, which is ESM, in); import it
 * before anything from `lib/booking/allocation`.
 */

import type { PrismaLike } from "../../lib/prisma";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findMany: jest.fn() },
    rescheduleRequest: { findFirst: jest.fn() },
  },
  ALLOCATION_TX_MAX_WAIT_MS: 8000,
  ALLOCATION_TX_TIMEOUT_MS: 30000,
}));

jest.mock("../../utils/appointmentlock", () => ({
  lockAutoAllocate: jest.fn(),
  unlockAutoAllocate: jest.fn(),
  lockConsulteeBooking: jest.fn(),
  unlockConsulteeBooking: jest.fn(),
}));

/** A search client on which nobody is booked: every candidate the availability allows is placeable. */
export const emptySearchDb = (): PrismaLike =>
  ({
    appointment: { findMany: jest.fn().mockResolvedValue([]) },
  }) as unknown as PrismaLike;
