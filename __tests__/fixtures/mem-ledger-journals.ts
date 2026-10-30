/** Ledger transaction and account doubles that append each posted journal to `txns`. */
export function memLedgerJournals<T extends { idempotencyKey: string }>(
  txns: T[],
) {
  return {
    ledgerTransaction: {
      findUnique: jest.fn(
        async ({ where }: { where: { idempotencyKey: string } }) => {
          const i = txns.findIndex(
            (t) => t.idempotencyKey === where.idempotencyKey,
          );
          return i < 0 ? null : { id: `ltxn-${i}` };
        },
      ),
      create: jest.fn(async ({ data }: { data: T }) => {
        txns.push(data);
        return { id: `ltxn-${txns.length - 1}` };
      }),
    },
    ledgerAccount: {
      createMany: jest.fn(async () => ({ count: 0 })),
    },
  };
}
