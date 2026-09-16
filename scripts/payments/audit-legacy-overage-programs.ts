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
 * Programmes created before those guards fail closed at *checkout* with
 * 409 `OVERAGE_CHARGE_MEMBER_UNSUPPORTED` / `OVERAGE_UNSUPPORTED_FUNDING` —
 * after the member has already picked a slot. This read-only audit lists
 * every live programme tripping the rule so ops can migrate (re-fund or
 * re-behave) instead of serving members a permanent 409.
 *
 * Run: `npx tsx scripts/payments/audit-legacy-overage-programs.ts`
 */

import prisma from "@/lib/prisma";
import { overageBehaviorUnsupportedReason } from "@/lib/enterprise/reachable-paths";

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
 * Read-only: scans live programmes and returns the ones whose overage
 * configuration is refused by `overageBehaviorUnsupportedReason`.
 */
export async function auditLegacyOveragePrograms(): Promise<LegacyOverageAuditResult> {
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

  return { checked: programs.length, refused };
}

// Run the audit if this script is executed directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  auditLegacyOveragePrograms()
    .then((result) => {
      console.log(
        `Checked ${result.checked} live programme(s): ${result.refused.length} refused configuration(s).`,
      );
      for (const row of result.refused) {
        console.log(
          `- ${row.organizationName} / ${row.programName} [${row.fundingSource ?? "unknown"} + ${row.programType} + ${row.overageBehavior}] — ${row.reason}`,
        );
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error("Legacy overage audit failed:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
