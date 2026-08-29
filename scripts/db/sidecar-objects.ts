/**
 * #705 — the one parser for "which objects does the sidecar promise?".
 *
 * Both `assert-sidecar-applied.ts` and its regression test read this, so the
 * test actually guards the script instead of re-implementing the same two
 * regexes and passing while the script drifts.
 *
 * Staged-for-the-reset objects are commented out, so stripping comment lines is
 * what excludes them. Splitting on the banner did NOT — active SQL sits below it
 * too, which is how `appointment_doc_thread_version_unique` and
 * `onboarding_draft_payload_size` went unasserted.
 */

export interface SidecarObjects {
  constraints: string[];
  indexes: string[];
}

export function parseSidecarObjects(sql: string): SidecarObjects {
  const active = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  return {
    constraints: [
      ...active.matchAll(/ADD CONSTRAINT "?([A-Za-z0-9_]+)"?/g),
    ].map((m) => m[1]),
    // `IF NOT EXISTS` is optional in the sidecar; without skipping it the
    // capture group takes the literal "IF" and the assert can never pass.
    indexes: [
      ...active.matchAll(
        /CREATE UNIQUE INDEX (?:IF NOT EXISTS )?"?([A-Za-z0-9_]+)"?/g,
      ),
    ].map((m) => m[1]),
  };
}
