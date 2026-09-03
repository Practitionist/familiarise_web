/**
 * TDS quarterly return draft (#1230) — Form 26Q today, Form 140 from
 * FY 2026-27. Aggregates TDSRecord rows for the requested FY+quarter into a
 * deductee-wise draft and prints it for the filing workflow. Dispatch-only:
 * portal serialization (FVU) and the reportedInForm26Q stamp are deliberate
 * follow-ups gated on CA sign-off of the section mapping.
 */

import { runJob } from "@/lib/observability/job-sentry";
import prisma from "@/lib/prisma";
import * as Sentry from "@sentry/nextjs";
import {
  buildTdsReturnDraft,
  indianFyQuarterOf,
  type TdsReturnSourceRow,
} from "@/lib/compliance/tds-return";
import { getIndianFinancialYear } from "@/lib/payments/tax/tds-service";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";

async function main() {
  // runJob returns void by design (it manages its own lifecycle) — no await.
  runJob("tds-26q-draft-export", async () => {
    await abortIfMaintenance("tds-26q-draft-export");
    // #476 — fail-open: the draft is read-only console output, harmless to repeat.
    await withCronLock(
      "tds-26q-draft-export",
      { failMode: "open" },
      async () => {
        const financialYear =
          process.env.TDS_RETURN_FY || getIndianFinancialYear();
        // CR #1234 r3.5 — fail fast on malformed overrides rather than emitting
        // a mislabeled compliance draft from a workflow typo.
        if (!/^\d{4}-\d{2}$/.test(financialYear)) {
          throw new Error(
            `TDS_RETURN_FY must look like "2026-27", got "${financialYear}"`,
          );
        }
        const quarter = process.env.TDS_RETURN_QUARTER
          ? Number.parseInt(process.env.TDS_RETURN_QUARTER, 10)
          : indianFyQuarterOf(new Date()).quarter;
        if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
          throw new Error(
            `TDS_RETURN_QUARTER must be 1-4, got "${process.env.TDS_RETURN_QUARTER}"`,
          );
        }

        const records = await prisma.tDSRecord.findMany({
          where: { financialYear, quarter },
          orderBy: { createdAt: "asc" },
          select: {
            consultantProfileId: true,
            tdsSection: true,
            cumulativeAmountCredited: true,
            tdsDeducted: true,
            isReversal: true,
            reportedInForm26Q: true,
          },
        });

        const alreadyReported = records.filter(
          (r) => r.reportedInForm26Q,
        ).length;

        // CR #1234 r5 — `cumulativeAmountCredited` is an FY RUNNING TOTAL, so a
        // quarter-scoped export must report the QUARTER DELTA, not the absolute
        // figure (Q1 ending at 10k then Q2 reaching 15k means Q2 credits are
        // 5k). Baseline = each deductee's highest cumulative from EARLIER
        // quarters of the same FY — deliberately INCLUDING already-reported
        // rows, because they establish where the running total stood when the
        // quarter opened. Deductions stay incremental (reversals negative);
        // only unreported rows contribute theirs to this draft.
        type Acc = {
          windowMaxCumulativePaise: number;
          tdsNetPaise: number;
          section: string | null;
        };
        const byDeductee = new Map<string, Acc>();
        for (const r of records) {
          let acc = byDeductee.get(r.consultantProfileId);
          if (!acc) {
            acc = {
              windowMaxCumulativePaise: 0,
              tdsNetPaise: 0,
              section: r.tdsSection,
            };
            byDeductee.set(r.consultantProfileId, acc);
          }
          acc.windowMaxCumulativePaise = Math.max(
            acc.windowMaxCumulativePaise,
            Number(r.cumulativeAmountCredited),
          );
          if (!r.reportedInForm26Q) {
            acc.tdsNetPaise += Number(r.tdsDeducted);
          }
        }

        const deducteeIds = [...byDeductee.keys()];
        const baselines =
          deducteeIds.length > 0
            ? await prisma.tDSRecord.groupBy({
                by: ["consultantProfileId"],
                where: {
                  financialYear,
                  quarter: { lt: quarter },
                  consultantProfileId: { in: deducteeIds },
                },
                _max: { cumulativeAmountCredited: true },
              })
            : [];
        const baselineByDeductee = new Map(
          baselines.map((b) => [
            b.consultantProfileId,
            Number(b._max.cumulativeAmountCredited ?? 0),
          ]),
        );

        const rows: TdsReturnSourceRow[] = [];
        for (const [consultantProfileId, acc] of byDeductee) {
          const baseline = baselineByDeductee.get(consultantProfileId) ?? 0;
          rows.push({
            consultantProfileId,
            tdsSection: acc.section,
            amountCreditedPaise: Math.max(
              0,
              acc.windowMaxCumulativePaise - baseline,
            ),
            tdsDeductedPaise: acc.tdsNetPaise,
            isReversal: false,
          });
        }

        const draft = buildTdsReturnDraft(rows, financialYear, quarter);
        if (alreadyReported > 0) {
          draft.warnings.push(
            `${alreadyReported} record(s) in scope are stamped reportedInForm26Q and were excluded — amendatory filings are manual.`,
          );
        }

        console.log("[tds-return-draft]", JSON.stringify(draft, null, 2));
        for (const w of draft.warnings) {
          console.warn(`[tds-return-draft] WARN ${w}`);
        }
        if (rows.length === 0) {
          Sentry.logger.warn("job:tds-return-draft-empty", {
            financialYear,
            quarter,
          });
        }
      },
    );
  });
}

main().catch((err) => {
  console.error("[tds-return-draft] fatal:", err);
  process.exit(1);
});
