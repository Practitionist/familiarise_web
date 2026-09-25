/**
 * A unique violation on one column, in both shapes Prisma raises it.
 *
 * The classic engine reports P2002 with the columns in `meta.target` (an array
 * or a string). Prisma 7 with the pg driver adapter leaves `meta.target` unset
 * and carries the Postgres error in `meta.driverAdapterError.cause`: SQLSTATE
 * 23505 as `originalCode`, the columns parsed from the detail line as
 * `constraint.fields`, and the constraint name in `originalMessage`. A check
 * that reads only `target` never matches on that runtime, so every modelled
 * race behind it surfaced as a raw error.
 */

type AdapterCause = {
  originalCode?: unknown;
  originalMessage?: unknown;
  constraint?: { fields?: unknown; index?: unknown };
};

type UniqueErrorShape = {
  code?: unknown;
  meta?: {
    target?: unknown;
    driverAdapterError?: { cause?: AdapterCause };
  };
};

function names(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? [value] : [];
}

/** True when `err` is a unique violation whose columns or constraint name `field`. */
export function isUniqueViolationOn(err: unknown, field: string): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, meta } = err as UniqueErrorShape;
  const cause = meta?.driverAdapterError?.cause;
  if (code !== "P2002" && cause?.originalCode !== "23505") return false;
  return [
    ...names(meta?.target),
    ...names(cause?.constraint?.fields),
    ...names(cause?.constraint?.index),
    ...names(cause?.originalMessage),
  ].some((name) => name.includes(field));
}
