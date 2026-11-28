export const refundOwedTestModule = {
  MAX_REFUND_OWED_ATTEMPTS: 3,
  REFUND_OWED_SELECT: {
    id: true,
    refundOwedKey: true,
    refundOwedPaise: true,
    refundOwedReason: true,
    refundOwedAttempts: true,
  },
  markerFromRow: (row: {
    id: string;
    refundOwedKey: string | null;
    refundOwedPaise: number | null;
    refundOwedReason: string | null;
    refundOwedAttempts: number;
  }) =>
    row.refundOwedKey
      ? {
          paymentId: row.id,
          amountPaise: row.refundOwedPaise,
          key: row.refundOwedKey,
          reason: row.refundOwedReason ?? "refund owed",
          attempts: row.refundOwedAttempts,
        }
      : null,
  stampRefundOwed: async () => true,
  // Every stamp wins: no other door's owed refund holds the payment.
  stampOwedOrHeld: async () => null,
  heldInsteadOf: async () => [],
  stampRefundsOwed: async (_tx: unknown, markers: readonly unknown[]) =>
    markers.length,
};

export function bookingExpiryPrismaModels() {
  return {
    consultation: {
      findMany: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    subscription: {
      findMany: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    appointmentOccurrence: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateManyAndReturn: jest.fn().mockResolvedValue([]),
    },
    bookingStatusHistory: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    appointment: { findMany: jest.fn() },
  };
}

/** `lib/prisma` over the sweep's models; a transaction runs on the same client. */
export function bookingExpiryPrismaModule() {
  const db: Record<string, unknown> = {
    ...bookingExpiryPrismaModels(),
    $queryRaw: jest.fn(async () => []),
    $disconnect: jest.fn(),
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { __esModule: true, default: db };
}

export function withNoRefundOwedMarker<T extends { id: string }>(rows: T[]) {
  return rows.map((row) => ({
    ...row,
    refundOwedKey: null,
    refundOwedPaise: null,
  }));
}

export async function countRefundOwedBatch(query: { values: unknown[] }) {
  const ids = query.values[0];
  if (!Array.isArray(ids)) throw new Error("missing marker ids");
  return ids.length;
}
