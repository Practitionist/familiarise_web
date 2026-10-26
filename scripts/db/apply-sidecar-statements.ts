/** Replace a sidecar's dependent objects atomically; a failed CREATE restores its DROP. */
export async function applySidecarStatements(
  database: {
    $transaction: (
      run: (tx: {
        $executeRawUnsafe: (sql: string) => Promise<unknown>;
      }) => Promise<void>,
      options: { timeout: number },
    ) => Promise<unknown>;
  },
  statements: string[],
): Promise<void> {
  await database.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
    },
    { timeout: 60_000 },
  );
}
