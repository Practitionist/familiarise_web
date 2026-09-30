/**
 * Postgres error predicates — structured SQLSTATE detection, not message sniffing.
 *
 * Classifying a database error by substring-matching its human-readable message
 * is fragile (wording changes, i18n, refactors) and is the anti-pattern these
 * helpers exist to replace. Prefer the structured signal: Prisma's `code`
 * (e.g. P2002) for modelled constraints, and the underlying Postgres SQLSTATE in
 * `meta.code` for raw-query paths (P2010).
 *
 * Exclusion constraints are the one unavoidable exception. Prisma has a
 * documented gap (prisma/prisma#25562, #26366): a violation of a constraint it
 * does not model — like the `occurrence_no_confirmed_overlap` btree_gist EXCLUDE that
 * lives in the raw-SQL sidecar — surfaces as a `PrismaClientUnknownRequestError`
 * with no `.code` and an undefined `.cause`. The SQLSTATE is then only present in
 * the message text, so a NARROW text probe (the SQLSTATE token and the constraint
 * name) is the only signal available. That heuristic is quarantined here, behind
 * a structured check and a name, rather than scattered through business logic.
 */

type MaybePgError = {
  code?: unknown;
  meta?: {
    code?: unknown;
    driverAdapterError?: { cause?: { originalCode?: unknown } };
  };
  message?: unknown;
};

/** The Postgres SQLSTATE, when Prisma exposes it structurally (raw-query/P2010). */
function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as MaybePgError).meta?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * The Postgres SQLSTATE as the driver adapter reports it: the pg adapter
 * classifies what it recognises and carries the untouched driver error under
 * `meta.driverAdapterError.cause`, with the code as `originalCode`. This is the
 * only structured route to a SQLSTATE the adapter has no Prisma mapping for.
 */
function adapterCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as MaybePgError).meta?.driverAdapterError?.cause
    ?.originalCode;
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

/**
 * Postgres 23P01 — exclusion-constraint violation (e.g. `occurrence_no_confirmed_overlap`).
 * Structured SQLSTATE first; narrow text probe second, only for Prisma's
 * unmodelled-constraint gap (see the module note).
 */
export function isExclusionViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (sqlState(error) === "23P01") return true;
  const msg = message(error);
  return (
    msg.includes("23P01") || msg.includes("occurrence_no_confirmed_overlap")
  );
}

/**
 * Postgres 40P01 — deadlock detected.
 *
 * Unlike 23P01, this one is not Prisma's modelling gap: upstream Prisma maps
 * 40P01 alongside 40001. The pinned driver adapter does not, so a row-lock
 * deadlock lands in its generic `kind: "postgres"` fall-through and reaches us
 * with no Prisma code to key on — hence its own predicate, and hence the text
 * probe below. The probe is on the SQLSTATE token and not on the prose: "40P01"
 * is the SQL-standard code for deadlock_detected and nothing else, so unlike a
 * phrase match it cannot promote a business rejection into a retry.
 */
export function isDeadlock(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (sqlState(error) === "40P01") return true;
  if (adapterCode(error) === "40P01") return true;
  return message(error).includes("40P01");
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
