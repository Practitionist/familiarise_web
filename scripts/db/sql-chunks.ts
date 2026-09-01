/**
 * Shared splitter for the `-- SPLIT`-delimited sidecar SQL files.
 *
 * `prisma db push` does not manage triggers or CHECK constraints, so three
 * scripts under this directory replay `prisma/sql/*.sql` after every push (see
 * `db:sidecars`). Prisma's `$executeRawUnsafe` runs one statement per call
 * (extended protocol), so each file is chunked on `-- SPLIT` markers. All three
 * had the same splitter copy-pasted; it lives here now so the next fix lands
 * once.
 */

/**
 * Is this chunk nothing but SQL comment lines?
 *
 * Replaces `/^(--.*\n?)*$/`, which SonarCloud flags as `typescript:S5852`
 * (super-linear backtracking) — the only CRITICAL security finding on `dev`
 * and the reason the branch's `new_security_rating` sat at 4.
 *
 * The flag is a heuristic, and here it is a false alarm. S5852 fires on the
 * shape — a quantified group whose body matches a variable span — but this
 * body cannot actually overlap itself: `.` never crosses a newline, so every
 * iteration is line-bounded and the engine has no ambiguous partition to
 * explore. Measured against six adversarial shapes (20k near-miss lines, a
 * 300k-char single line, alternating blanks), the old regex never exceeded
 * 1ms. There was no live denial of service to fix, and nobody should "re-fix"
 * this later believing there was.
 *
 * It is replaced anyway because clearing the gate is worth more than the
 * regex, and because these files are load-bearing: they recreate the money-path
 * invariants on a fresh database, so the splitter should be one nobody has to
 * squint at.
 *
 * Semantics are preserved exactly, not merely approximately — including the
 * two edge cases a first pass got wrong (#1307 review): `""` is true, because
 * the old regex's `*` permitted zero iterations, and a trailing
 * whitespace-only line is false, because a space is not `--`. Neither is
 * reachable through `splitSqlStatements`, which trims and drops empties first,
 * but the predicate is exported and should not need that caveat to be correct.
 * Pinned by `__tests__/db/sidecar-sql-splitter.test.ts`, which keeps the old
 * regex as an oracle and asserts agreement across every chunk of all three
 * real files plus the adversarial and degenerate inputs.
 */
export function isOnlyComments(chunk: string): boolean {
  const lines = chunk.split("\n");
  // The legacy regex's trailing `\n?` allowed exactly one final newline, which
  // `split` renders as one empty last element. Everything else — a blank line,
  // a whitespace-only line — was NOT a comment line and made it return false.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.every((line) => line.startsWith("--"));
}

/** Chunk a sidecar SQL file into individually executable statements. */
export function splitSqlStatements(raw: string): string[] {
  return raw
    .split(/^--\s*SPLIT\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !isOnlyComments(s));
}
