import type { Tx } from "@/lib/prisma";

/** The delegates and raw methods a test stubs; every other member stays absent. */
export type TxDouble = {
  [K in keyof Tx]?: Tx[K] extends (...args: never[]) => unknown
    ? Tx[K] | jest.Mock
    : { [M in keyof Tx[K]]?: Tx[K][M] | jest.Mock };
};

/** A transaction client built from only the stubs the code under test calls. */
export function txDouble(parts: TxDouble): Tx {
  return parts as Tx;
}
