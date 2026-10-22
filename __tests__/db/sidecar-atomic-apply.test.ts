/** @jest-environment node */
import { applySidecarStatements } from "../../scripts/db/apply-sidecar-statements";

it("rolls a dependent DROP back when its CREATE fails", async () => {
  const applied: string[] = [];
  const committed: string[] = [];
  const database = {
    $transaction: jest.fn(
      async (
        run: (tx: {
          $executeRawUnsafe: (sql: string) => Promise<unknown>;
        }) => Promise<void>,
      ) => {
        await run({
          $executeRawUnsafe: async (sql: string) => {
            applied.push(sql);
            if (sql === "CREATE bad") throw new Error("invalid DDL");
          },
        });
        committed.push(...applied);
      },
    ),
  };
  await expect(
    applySidecarStatements(database, ["DROP trigger", "CREATE bad"]),
  ).rejects.toThrow("invalid DDL");
  expect(database.$transaction).toHaveBeenCalledTimes(1);
  expect(applied).toEqual([
    "SET LOCAL lock_timeout = '3s'",
    "DROP trigger",
    "CREATE bad",
  ]);
  expect(committed).toEqual([]);
});
