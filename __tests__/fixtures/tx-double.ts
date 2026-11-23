import { Prisma } from "@prisma/client";
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

let delegates: Set<string> | undefined;
function isDelegate(key: string): boolean {
  delegates ??= new Set(
    Object.values(Prisma.ModelName).map((m) => m[0].toLowerCase() + m.slice(1)),
  );
  return delegates.has(key);
}

const DELEGATE_METHODS = new Set<string>([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

function strictDelegate(label: string, delegate: object): object {
  return new Proxy(delegate, {
    get(target, key, receiver) {
      if (
        typeof key === "string" &&
        DELEGATE_METHODS.has(key) &&
        !(key in target)
      ) {
        throw new Error(`${label}.${key} is not stubbed`);
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

/**
 * Like `txDouble`, but reading a client delegate, delegate method or `$` method
 * the test did not stub throws, so code guarded on a method existing cannot
 * quietly take a branch production never runs.
 */
export function strictClientDouble<T extends object>(
  parts: T,
  label: string,
): T {
  return new Proxy(parts, {
    get(target, key, receiver) {
      if (typeof key !== "string") return Reflect.get(target, key, receiver);
      const delegate = isDelegate(key);
      if ((delegate || /^\$[a-z]/i.test(key)) && !(key in target)) {
        throw new Error(`${label}.${key} is not stubbed`);
      }
      const value: unknown = Reflect.get(target, key, receiver);
      return delegate && value && typeof value === "object"
        ? strictDelegate(`${label}.${key}`, value)
        : value;
    },
  });
}

/** A strict transaction double: see `strictClientDouble`. */
export function strictTxDouble(parts: TxDouble): Tx {
  return strictClientDouble(parts, "tx") as Tx;
}
