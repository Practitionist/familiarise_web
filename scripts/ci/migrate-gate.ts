/**
 * Gate in front of `prisma migrate deploy` in db-migrate.yml. `migrate status`
 * exits 1 both for "migrations are pending" and for real failures, so its
 * output decides: only a pending-only history may proceed, and a pending
 * `_contract` folder proceeds only when the workflow_dispatch input names it.
 *
 * Usage: DISPATCH_MIGRATION=<folder or empty> tsx scripts/ci/migrate-gate.ts
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

export type StatusVerdict =
  { ok: true; pending: string[] } | { ok: false; reason: string };

const PENDING_HEADER = /^Following migrations? have not yet been applied:$/m;

/** Judge `prisma migrate status` (stdout and stderr together) by its exit code and text. */
export function judgeStatus(exitCode: number, output: string): StatusVerdict {
  if (/have failed:/.test(output))
    return {
      ok: false,
      reason: "a migration is recorded as failed (P3009 territory)",
    };
  const error = /^Error: (.+)$/m.exec(output);
  if (error) return { ok: false, reason: error[1] };
  if (exitCode === 0 && /Database schema is up to date!/.test(output))
    return { ok: true, pending: [] };

  const header = PENDING_HEADER.exec(output);
  if (exitCode === 1 && header) {
    const pending: string[] = [];
    for (const line of output
      .slice(header.index + header[0].length)
      .split("\n")
      .slice(1)) {
      const name = line.trim();
      if (!name) break;
      if (!/^[A-Za-z0-9_]+$/.test(name))
        return {
          ok: false,
          reason: `unexpected line in the pending list: ${name}`,
        };
      pending.push(name);
    }
    if (pending.length > 0) return { ok: true, pending };
  }
  return {
    ok: false,
    reason: `unrecognised migrate status output (exit ${exitCode}); re-pin the strings after a Prisma bump`,
  };
}

/** Why the pending set may not be applied on this run, or null when it may. */
export function contractRefusal(
  pending: string[],
  dispatched: string,
): string | null {
  const wanted = dispatched.trim();
  if (wanted) {
    if (!wanted.endsWith("_contract"))
      return `the dispatch input "${wanted}" is not a _contract folder`;
    if (!pending.includes(wanted))
      return `the dispatch input "${wanted}" is not a pending migration (pending: ${pending.join(", ") || "none"})`;
  }
  const refused = pending.filter(
    (name) => name.endsWith("_contract") && name !== wanted,
  );
  if (refused.length > 0)
    return `pending contract migration(s) ${refused.join(", ")} need a workflow_dispatch run that names exactly one of them`;
  return null;
}

function main(): void {
  const prisma = path.join(
    __dirname,
    "..",
    "..",
    "node_modules",
    ".bin",
    "prisma",
  );
  const run = spawnSync(prisma, ["migrate", "status"], { encoding: "utf8" });
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  console.log(output);

  const verdict = judgeStatus(run.status ?? 1, output);
  if (!verdict.ok) {
    console.error(`::error title=Migration gate::${verdict.reason}`);
    process.exit(1);
  }
  const refusal = contractRefusal(
    verdict.pending,
    process.env.DISPATCH_MIGRATION ?? "",
  );
  if (refusal) {
    console.error(`::error title=Migration gate::${refusal}`);
    process.exit(1);
  }
  console.log(
    verdict.pending.length
      ? `migrate-gate: ok — will apply ${verdict.pending.join(", ")}`
      : "migrate-gate: ok — nothing pending",
  );
}

if (process.argv[1] && /migrate-gate/.test(process.argv[1])) main();
