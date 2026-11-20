// Shared in-memory Prisma double for driving handleCheckout end to end in repro suites.

type AnyFn = (...args: unknown[]) => unknown;
export type Overrides = Record<string, AnyFn>;

const DEFAULT_BY_OP: Record<string, (args: unknown) => unknown> = {
  findMany: () => [],
  findFirst: () => null,
  findUnique: () => null,
  findFirstOrThrow: () => ({}),
  findUniqueOrThrow: () => ({}),
  count: () => 0,
  updateMany: () => ({ count: 1 }),
  deleteMany: () => ({ count: 0 }),
  update: (a) => ({ id: "row", ...((a as { data?: object })?.data ?? {}) }),
  upsert: () => ({ id: "row" }),
  create: (a) => ({ id: "created", ...((a as { data?: object })?.data ?? {}) }),
  createMany: () => ({ count: 1 }),
  // Every row inserts, as on an empty table; the bulk update moves nothing.
  createManyAndReturn: (a) =>
    ((a as { data?: object[] })?.data ?? []).map((row, i) => ({
      id: `created-${i}`,
      ...row,
    })),
  updateManyAndReturn: () => [],
  aggregate: () => ({ _sum: {}, _count: 0 }),
};

export const calls: { path: string; args: unknown }[] = [];

function model(name: string, overrides: Overrides): object {
  return new Proxy(
    {},
    {
      get: (_t, op: string) => async (args: unknown) => {
        const path = `${name}.${op}`;
        calls.push({ path, args });
        const override = overrides[path];
        if (override) return override(args);
        const fallback = DEFAULT_BY_OP[op];
        return fallback ? fallback(args) : null;
      },
    },
  );
}

export const overrides: Overrides = {};

function makePrismaDouble(): unknown {
  const models = new Map<string, object>();
  const client: Record<string, unknown> = {};
  const root = new Proxy(client, {
    get: (target, prop: string) => {
      if (prop in target) return target[prop];
      if (prop === "$transaction") {
        return async (fn: (tx: unknown) => unknown) => fn(root);
      }
      if (prop === "$queryRaw" || prop === "$executeRaw") {
        return async () => [];
      }
      if (typeof prop !== "string" || prop.startsWith("$")) return undefined;
      if (!models.has(prop)) models.set(prop, model(prop, overrides));
      return models.get(prop);
    },
  });
  return root;
}

export const db = makePrismaDouble();

export function resetDouble(next: Overrides): void {
  for (const key of Object.keys(overrides)) delete overrides[key];
  // The seat's event is on the plan the checkout names unless a test says not.
  Object.assign(
    overrides,
    { "webinar.count": () => 1, "class.count": () => 1 },
    next,
  );
  calls.length = 0;
}
