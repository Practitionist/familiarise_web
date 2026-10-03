/**
 * Postgres error predicates keyed on the SQLSTATE, not the message prose.
 * Exclusion violations keep a narrow constraint-name probe because Prisma does
 * not model EXCLUDE constraints (prisma/prisma#25562).
 */

type MaybePgError = {
  code?: unknown;
  name?: unknown;
  cause?: { originalCode?: unknown };
  meta?: {
    code?: unknown;
    driverAdapterError?: { cause?: { originalCode?: unknown } };
  };
  message?: unknown;
};

/**
 * The SQLSTATE wherever Prisma 7 + adapter-pg put it: on a P-coded error under
 * `meta.driverAdapterError`, or, for unmapped kinds (`kind: "postgres"`, e.g.
 * 40P01/23P01), on the raw rethrown DriverAdapterError's `cause`.
 */
function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as MaybePgError;
  const candidates = [
    e.meta?.code,
    e.meta?.driverAdapterError?.cause?.originalCode,
    e.name === "DriverAdapterError" ? e.cause?.originalCode : undefined,
  ];
  const code = candidates.find((c) => typeof c === "string");
  return typeof code === "string" ? code : undefined;
}

function message(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const m = (error as MaybePgError).message;
  return typeof m === "string" ? m : "";
}

/** Postgres 23505 / Prisma P2002 — unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as MaybePgError).code === "P2002") return true;
  return sqlState(error) === "23505";
}

/** Postgres 23P01 — exclusion-constraint violation (e.g. `occurrence_no_confirmed_overlap`). */
export function isExclusionViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (sqlState(error) === "23P01") return true;
  const msg = message(error);
  return (
    msg.includes("23P01") || msg.includes("occurrence_no_confirmed_overlap")
  );
}

/** Postgres 40P01 — deadlock detected. adapter-pg 7.7 has no mapping for it. */
export function isDeadlock(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return sqlState(error) === "40P01" || message(error).includes("40P01");
}

/**
 * #1696 — the pool ran dry. Prisma P2024 is "timed out fetching a connection
 * from the pool"; the interactive-transaction twin has no code and only the
 * text "Unable to start a transaction in the given time". With PG_POOL_MAX=1
 * on Netlify a burst turns straight into this, so it is tagged centrally
 * (`lib/observability/report.ts`) for an alert rule rather than per call site.
 */
export function isPoolExhaustion(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as MaybePgError).code === "P2024") return true;
  const msg = message(error);
  return (
    msg.includes("Unable to start a transaction in the given time") ||
    msg.includes("Timed out fetching a new connection from the connection pool")
  );
}
