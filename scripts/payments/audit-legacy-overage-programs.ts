/**
 * Audit legacy overage configurations that can never clear checkout.
 *
 * #715 / #1458 refused three intersections at *configuration* time
 * (`overageBehaviorUnsupportedReason` in `lib/enterprise/reachable-paths.ts`):
 *   - WALLET + CHARGE_MEMBER (no wallet credit-back exists)
 *   - WALLET + CHARGE_ORG with an overage surcharge (nothing collects a
 *     markup on top of the debited price)
 *   - LICENSE + anything but BLOCK (a flat fee moves no money per booking)
 *
 * #1744 added a fourth: CHARGE_MEMBER on ANY rail, until an earnings hold
 * exists (the member pays after the session; the consultant is paid on the
 * full price). Existing PENDING member overages keep settling.
 *
 * Programmes created before those guards fail closed at *checkout* with
 * 409 `OVERAGE_CHARGE_MEMBER_UNSUPPORTED` / `OVERAGE_UNSUPPORTED_FUNDING` —
 * after the member has already picked a slot. This audit lists every live
 * programme tripping the rule so ops can migrate (re-fund or re-behave)
 * instead of serving members a permanent 409, and records one WARN
 * SystemEvent per programme so the finding survives the terminal (#1744).
 * The org's own action centre shows the same programmes to its owners.
 *
 * Run: `npx tsx scripts/payments/audit-legacy-overage-programs.ts`
 */

import prisma from "@/lib/prisma";
import { overageBehaviorUnsupportedReason } from "@/lib/enterprise/reachable-paths";
import { recordSystemEvent } from "@/lib/enterprise/system-events";

export interface LegacyOverageProgram {
  programId: string;
  programName: string;
  programType: string;
  organizationId: string;
  organizationName: string;
  fundingSource: string | null;
  overageBehavior: string;
  overageSurchargeBps: number | null;
  reason: string;
}

export interface LegacyOverageAuditResult {
  checked: number;
  refused: LegacyOverageProgram[];
}

/**
 * Scans live programmes and returns the ones whose overage configuration is
 * refused by `overageBehaviorUnsupportedReason`. With `record` it also writes
 * one WARN SystemEvent per refused programme (category OVERAGE); the scan
 * itself never writes.
 */
export async function auditLegacyOveragePrograms(
  opts: { record?: boolean } = {},
): Promise<LegacyOverageAuditResult> {
  const programs = await prisma.program.findMany({
    where: { status: "ACTIVE", archivedAt: null },
    select: {
      id: true,
      name: true,
      type: true,
      contract: {
        select: {
          organizationId: true,
          organization: { select: { name: true } },
          billingAccount: { select: { fundingSource: true } },
        },
      },
      licensedSeatConfig: {
        select: { overageBehavior: true, overageSurchargeBps: true },
      },
      creditPoolConfig: {
        select: { overageBehavior: true, overageSurchargeBps: true },
      },
    },
  });

  const refused: LegacyOverageProgram[] = [];
  for (const program of programs) {
    const fundingSource = program.contract.billingAccount?.fundingSource ?? null;
    const config =
      program.type === "CREDIT_POOL"
        ? program.creditPoolConfig
        : program.licensedSeatConfig;
    // No config row yet (programme created but never configured): nothing to
    // refuse — checkout resolves the assignment, not the behaviour, here.
    if (!config) continue;
    const reason = overageBehaviorUnsupportedReason(
      fundingSource,
      config.overageBehavior,
      config.overageSurchargeBps,
    );
    if (reason) {
      refused.push({
        programId: program.id,
        programName: program.name,
        programType: program.type,
        organizationId: program.contract.organizationId,
        organizationName: program.contract.organization.name,
        fundingSource,
        overageBehavior: config.overageBehavior,
        overageSurchargeBps: config.overageSurchargeBps,
        reason,
      });
    }
  }

  if (opts.record) {
    for (const row of refused) {
      await recordSystemEvent({
        organizationId: row.organizationId,
        category: "OVERAGE",
        severity: "WARN",
        message: `Programme ${row.programName} (${row.programId}) is configured ${row.overageBehavior} on the ${row.fundingSource ?? "unknown"} rail, which is refused at configuration time — switch it to BLOCK or CHARGE_ORG`,
        context: row as unknown as Record<string, unknown>,
      });
    }
  }

  return { checked: programs.length, refused };
}

// Run the audit if this script is executed directly. Disconnects before
// exiting (and assigns exitCode instead of calling process.exit) so buffered
// stdout flushes and the Prisma pool closes cleanly.
if (import.meta.url === `file://${process.argv[1]}`) {
  auditLegacyOveragePrograms({ record: true })
    .then(async (result) => {
      console.log(
        `Checked ${result.checked} live programme(s): ${result.refused.length} refused configuration(s).`,
      );
      for (const row of result.refused) {
        console.log(
          `- ${row.organizationName} / ${row.programName} [${row.fundingSource ?? "unknown"} + ${row.programType} + ${row.overageBehavior}] — ${row.reason}`,
        );
      }
      await prisma.$disconnect();
      process.exitCode = 0;
    })
    .catch(async (error) => {
      console.error("Legacy overage audit failed:", error);
      await prisma.$disconnect().catch(() => {});
      process.exitCode = 1;
    });
}
