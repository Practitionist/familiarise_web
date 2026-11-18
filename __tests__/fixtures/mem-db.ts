/**
 * A small in-memory table whose `where` matching honours the predicates the
 * money paths repeat in their CAS writes (equality, null, `in` / `notIn` /
 * `not`, range operators, `OR` / `AND` / `NOT`, to-one relations bare or
 * under `is`, and `some` / `none` on to-many relations), so a double that ignored a predicate
 * cannot make a guarded write look safe.
 */

export type Row = Record<string, unknown>;
export type Where = Record<string, unknown>;

const OPERATORS = [
  "in",
  "notIn",
  "not",
  "gt",
  "gte",
  "lt",
  "lte",
  "startsWith",
  "is",
  "some",
  "none",
];

function isOperatorObject(v: unknown): v is Where {
  return (
    !!v &&
    typeof v === "object" &&
    !(v instanceof Date) &&
    !Array.isArray(v) &&
    Object.keys(v).some((k) => OPERATORS.includes(k))
  );
}

const asNumber = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
const sameValue = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date
    ? a.getTime() === b.getTime()
    : (a ?? null) === (b ?? null);

function matchesOperators(actual: unknown, f: Where): boolean {
  if ("in" in f && !(f.in as unknown[]).some((v) => sameValue(v, actual))) {
    return false;
  }
  if ("notIn" in f) {
    if (actual === null || actual === undefined) return false;
    if ((f.notIn as unknown[]).some((v) => sameValue(v, actual))) return false;
  }
  if ("not" in f && sameValue(actual, f.not)) return false;
  const ranged = [
    ["gt", (a: number, b: number) => a > b],
    ["gte", (a: number, b: number) => a >= b],
    ["lt", (a: number, b: number) => a < b],
    ["lte", (a: number, b: number) => a <= b],
  ] as const;
  for (const [op, test] of ranged) {
    if (op in f) {
      if (actual === null || actual === undefined) return false;
      if (!test(asNumber(actual), asNumber(f[op]))) return false;
    }
  }
  if ("startsWith" in f) {
    if (typeof actual !== "string") return false;
    if (!actual.startsWith(String(f.startsWith))) return false;
  }
  if ("is" in f) {
    if (f.is === null) return actual === null || actual === undefined;
    if (!actual || typeof actual !== "object") return false;
    if (!matchesWhere(actual as Row, f.is as Where)) return false;
  }
  if ("some" in f) {
    if (!Array.isArray(actual)) return false;
    if (!actual.some((el) => matchesWhere(el as Row, f.some as Where))) {
      return false;
    }
  }
  if ("none" in f) {
    if (!Array.isArray(actual)) return true;
    if (actual.some((el) => matchesWhere(el as Row, f.none as Where))) {
      return false;
    }
  }
  return true;
}

export function matchesWhere(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, filter]) => {
    if (filter === undefined) return true;
    if (key === "OR") {
      return (filter as Where[]).some((w) => matchesWhere(row, w));
    }
    if (key === "AND") {
      return [filter as Where | Where[]]
        .flat()
        .every((w) => matchesWhere(row, w));
    }
    if (key === "NOT") {
      return ![filter as Where | Where[]]
        .flat()
        .some((w) => matchesWhere(row, w));
    }
    const actual = row[key];
    if (isOperatorObject(filter)) return matchesOperators(actual, filter);
    if (
      filter &&
      typeof filter === "object" &&
      !(filter instanceof Date) &&
      !Array.isArray(filter)
    ) {
      return (
        !!actual &&
        typeof actual === "object" &&
        matchesWhere(actual as Row, filter as Where)
      );
    }
    return sameValue(actual, filter);
  });
}

/** Applies a Prisma `data` object, including numeric `increment` / `decrement`. */
export function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("increment" in v) {
        row[k] = Number(row[k] ?? 0) + Number(v.increment);
        continue;
      }
      if ("decrement" in v) {
        row[k] = Number(row[k] ?? 0) - Number(v.decrement);
        continue;
      }
    }
    row[k] = v;
  }
}

function pick(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const k of Object.keys(select)) out[k] = row[k];
  return out;
}

/**
 * The CRUD surface the money paths use, over a caller-owned row array.
 * `unique` lists opt-in compound keys that `createMany` enforces, skipping a
 * clash under `skipDuplicates` and throwing otherwise, as Postgres would.
 */
export function memTable(
  rows: Row[],
  idPrefix = "row",
  opts: { unique?: string[][] } = {},
) {
  const clashes = (d: Row) =>
    (opts.unique ?? []).some((key) =>
      rows.some((r) => key.every((k) => sameValue(r[k], d[k]))),
    );
  return {
    rows,
    findMany: jest.fn(async (args: { where?: Where; select?: Row } = {}) =>
      rows
        .filter((r) => matchesWhere(r, args.where))
        .map((r) => pick(r, args.select)),
    ),
    findFirst: jest.fn(async (args: { where?: Where; select?: Row } = {}) => {
      const hit = rows.find((r) => matchesWhere(r, args.where));
      return hit ? pick(hit, args.select) : null;
    }),
    findUnique: jest.fn(async (args: { where: Where; select?: Row }) => {
      const hit = rows.find((r) => matchesWhere(r, args.where));
      return hit ? pick(hit, args.select) : null;
    }),
    updateMany: jest.fn(async (args: { where?: Where; data: Row }) => {
      let count = 0;
      for (const r of rows) {
        if (!matchesWhere(r, args.where)) continue;
        applyData(r, args.data);
        count++;
      }
      return { count };
    }),
    update: jest.fn(async (args: { where: Where; data: Row }) => {
      const hit = rows.find((r) => matchesWhere(r, args.where));
      if (!hit) throw new Error("Record to update not found");
      applyData(hit, args.data);
      return { ...hit };
    }),
    create: jest.fn(async (args: { data: Row }) => {
      const row: Row = { id: `${idPrefix}-${rows.length + 1}`, ...args.data };
      rows.push(row);
      return { ...row };
    }),
    createMany: jest.fn(
      async (args: { data: Row[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const d of args.data) {
          if (clashes(d)) {
            if (args.skipDuplicates) continue;
            throw new Error("Unique constraint failed");
          }
          rows.push({ id: `${idPrefix}-${rows.length + 1}`, ...d });
          count++;
        }
        return { count };
      },
    ),
    createManyAndReturn: jest.fn(
      async (args: { data: Row[]; skipDuplicates?: boolean; select?: Row }) => {
        const inserted: Row[] = [];
        for (const d of args.data) {
          if (clashes(d)) {
            if (args.skipDuplicates) continue;
            throw new Error("Unique constraint failed");
          }
          const row: Row = { id: `${idPrefix}-${rows.length + 1}`, ...d };
          rows.push(row);
          inserted.push(pick(row, args.select));
        }
        return inserted;
      },
    ),
    updateManyAndReturn: jest.fn(
      async (args: { where?: Where; data: Row; select?: Row }) => {
        const moved: Row[] = [];
        for (const r of rows) {
          if (!matchesWhere(r, args.where)) continue;
          applyData(r, args.data);
          moved.push(pick(r, args.select));
        }
        return moved;
      },
    ),
  };
}
