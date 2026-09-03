/**
 * TDS quarterly return draft (#1230) — Form 26Q today, Form 140 from
 * FY 2026-27. Aggregates TDSRecord rows for the requested FY+quarter into a
 * deductee-wise draft, prints the MASKED draft for the filing workflow, and
 * writes the full-PAN CSV the chartered accountant imports into the private
 * Supabase bucket. Portal serialization (FVU) and the reportedInForm26Q stamp
 * remain deliberate follow-ups gated on CA sign-off of the section mapping.
 *
 * #1354 — both withholding rails are in scope now. Host-organisation payouts
 * write a TDSRecord at completion, so the draft groups by (deductee type,
 * deductee id) and resolves each rail's identity from its own tax satellite.
 *
 * PAN handling: the draft that reaches stdout, Sentry and any log sink carries
 * `panLast4` only. The decrypted PAN exists in this process just long enough
 * to be written into the private CSV, and the job logs the storage path rather
 * than the object.
 */

import { runJob } from "@/lib/observability/job-sentry";
import prisma from "@/lib/prisma";
import * as Sentry from "@sentry/nextjs";
import {
  buildTdsReturnCsv,
  buildTdsReturnDraft,
  indianFyQuarterOf,
  tdsDeducteeKey,
  tdsReturnCsvStoragePath,
  type TdsDeducteeType,
  type TdsReturnSourceRow,
} from "@/lib/compliance/tds-return";
import { getIndianFinancialYear } from "@/lib/payments/tax/tds-service";
import { decryptPAN } from "@/lib/payments/tax/pan-crypto";
import { uploadPrivateFinanceObject } from "@/lib/pdf/storage";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";

/** Last instant of the requested fiscal quarter, used to pick the rate row. */
function quarterEndUTC(financialYear: string, quarter: number): Date {
  const fyStartYear = Number.parseInt(financialYear.slice(0, 4), 10);
  // Q1 ends Jun, Q2 Sep, Q3 Dec, Q4 Mar of the following calendar year.
  const monthAfterEnd = 3 + quarter * 3; // 0-indexed month AFTER the quarter
  return new Date(Date.UTC(fyStartYear, monthAfterEnd, 1));
}

async function main() {
  // runJob returns void by design (it manages its own lifecycle) — no await.
  runJob("tds-26q-draft-export", async () => {
    await abortIfMaintenance("tds-26q-draft-export");
    // #476 — fail-open: the draft is a read-only export, harmless to repeat.
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
            organizationId: true,
            payoutId: true,
            orgPayoutId: true,
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
          deducteeType: TdsDeducteeType;
          deducteeId: string;
          windowMaxCumulativePaise: number;
          tdsNetPaise: number;
          reversalPaise: number;
          section: string | null;
        };
        const byDeductee = new Map<string, Acc>();
        for (const r of records) {
          // #1354 — the XOR CHECK guarantees exactly one of these is set; a row
          // that somehow has neither is unattributable and is skipped rather
          // than filed against an empty PAN.
          const deducteeType: TdsDeducteeType | null = r.consultantProfileId
            ? "CONSULTANT"
            : r.organizationId
              ? "ORGANIZATION"
              : null;
          const deducteeId = r.consultantProfileId ?? r.organizationId;
          if (!deducteeType || !deducteeId) continue;

          const key = tdsDeducteeKey(deducteeType, deducteeId);
          let acc = byDeductee.get(key);
          if (!acc) {
            acc = {
              deducteeType,
              deducteeId,
              windowMaxCumulativePaise: 0,
              tdsNetPaise: 0,
              reversalPaise: 0,
              section: r.tdsSection,
            };
            byDeductee.set(key, acc);
          }
          acc.windowMaxCumulativePaise = Math.max(
            acc.windowMaxCumulativePaise,
            Number(r.cumulativeAmountCredited),
          );
          if (!r.reportedInForm26Q) {
            if (r.isReversal) acc.reversalPaise += Number(r.tdsDeducted);
            else acc.tdsNetPaise += Number(r.tdsDeducted);
          }
        }

        // Baselines are per rail because the groupBy key is a different column
        // on each; the two results merge into one map keyed the same way the
        // accumulator above is.
        const consultantIds = [...byDeductee.values()]
          .filter((a) => a.deducteeType === "CONSULTANT")
          .map((a) => a.deducteeId);
        const organizationIds = [...byDeductee.values()]
          .filter((a) => a.deducteeType === "ORGANIZATION")
          .map((a) => a.deducteeId);

        const baselineByDeductee = new Map<string, number>();
        if (consultantIds.length > 0) {
          const rows = await prisma.tDSRecord.groupBy({
            by: ["consultantProfileId"],
            where: {
              financialYear,
              quarter: { lt: quarter },
              consultantProfileId: { in: consultantIds },
            },
            _max: { cumulativeAmountCredited: true },
          });
          for (const b of rows) {
            if (!b.consultantProfileId) continue;
            baselineByDeductee.set(
              tdsDeducteeKey("CONSULTANT", b.consultantProfileId),
              Number(b._max.cumulativeAmountCredited ?? 0),
            );
          }
        }
        if (organizationIds.length > 0) {
          const rows = await prisma.tDSRecord.groupBy({
            by: ["organizationId"],
            where: {
              financialYear,
              quarter: { lt: quarter },
              organizationId: { in: organizationIds },
            },
            _max: { cumulativeAmountCredited: true },
          });
          for (const b of rows) {
            if (!b.organizationId) continue;
            baselineByDeductee.set(
              tdsDeducteeKey("ORGANIZATION", b.organizationId),
              Number(b._max.cumulativeAmountCredited ?? 0),
            );
          }
        }

        // ---- Deductee identity, per rail -------------------------------
        type Identity = {
          name: string | null;
          panEncrypted: Buffer | Uint8Array | null;
          panLast4: string | null;
          gstin: string | null;
        };
        const identityByKey = new Map<string, Identity>();

        if (consultantIds.length > 0) {
          const profiles = await prisma.consultantProfile.findMany({
            where: { id: { in: consultantIds } },
            select: {
              id: true,
              user: { select: { name: true } },
              taxInfo: {
                select: { panEncrypted: true, panLast4: true, gstin: true },
              },
            },
          });
          for (const p of profiles) {
            identityByKey.set(tdsDeducteeKey("CONSULTANT", p.id), {
              name: p.user?.name ?? null,
              panEncrypted: p.taxInfo?.panEncrypted ?? null,
              panLast4: p.taxInfo?.panLast4 ?? null,
              gstin: p.taxInfo?.gstin ?? null,
            });
          }
        }
        if (organizationIds.length > 0) {
          const orgs = await prisma.organization.findMany({
            where: { id: { in: organizationIds } },
            select: {
              id: true,
              name: true,
              taxInfo: {
                select: {
                  legalName: true,
                  panEncrypted: true,
                  panLast4: true,
                  gstin: true,
                },
              },
            },
          });
          for (const o of orgs) {
            identityByKey.set(tdsDeducteeKey("ORGANIZATION", o.id), {
              // #1354 — the return needs the name on the PAN; `name` is the
              // editable trade name and is only the fallback.
              name: o.taxInfo?.legalName ?? o.name,
              panEncrypted: o.taxInfo?.panEncrypted ?? null,
              panLast4: o.taxInfo?.panLast4 ?? null,
              gstin: o.taxInfo?.gstin ?? null,
            });
          }
        }

        // ---- §393 payment codes ----------------------------------------
        // One code per section: the newest effective-dated rate row that was
        // already in force when the quarter closed. Filing a quarter under a
        // rate that took effect after it ended misclassifies the line.
        const sections = [
          ...new Set(
            [...byDeductee.values()]
              .map((a) => a.section)
              .filter((s): s is string => !!s),
          ),
        ];
        const paymentCodeBySection = new Map<string, string | null>();
        if (sections.length > 0) {
          const rates = await prisma.tdsRate.findMany({
            where: {
              section: { in: sections },
              effectiveFrom: { lte: quarterEndUTC(financialYear, quarter) },
            },
            orderBy: { effectiveFrom: "desc" },
            select: { section: true, paymentCode: true },
          });
          for (const r of rates) {
            if (!paymentCodeBySection.has(r.section)) {
              paymentCodeBySection.set(r.section, r.paymentCode);
            }
          }
        }

        const rows: TdsReturnSourceRow[] = [];
        for (const [key, acc] of byDeductee) {
          const baseline = baselineByDeductee.get(key) ?? 0;
          const identity = identityByKey.get(key);
          const shared = {
            deducteeType: acc.deducteeType,
            deducteeId: acc.deducteeId,
            deducteeName: identity?.name ?? null,
            deducteePanLast4: identity?.panLast4 ?? null,
            deducteeGstin: identity?.gstin ?? null,
            tdsSection: acc.section,
            paymentCode: acc.section
              ? (paymentCodeBySection.get(acc.section) ?? null)
              : null,
          };
          rows.push({
            ...shared,
            amountCreditedPaise: Math.max(
              0,
              acc.windowMaxCumulativePaise - baseline,
            ),
            tdsDeductedPaise: acc.tdsNetPaise,
            isReversal: false,
          });
          // Reversals stay a separate source row so the draft can report them
          // as their own return line without losing the netted total.
          if (acc.reversalPaise !== 0) {
            rows.push({
              ...shared,
              amountCreditedPaise: 0,
              tdsDeductedPaise: acc.reversalPaise,
              isReversal: true,
            });
          }
        }

        const draft = buildTdsReturnDraft(rows, financialYear, quarter);
        if (alreadyReported > 0) {
          draft.warnings.push(
            `${alreadyReported} record(s) in scope are stamped reportedInForm26Q and were excluded — amendatory filings are manual.`,
          );
        }

        // Masked: the draft carries panLast4 only, never a full PAN.
        console.log("[tds-return-draft]", JSON.stringify(draft, null, 2));
        for (const w of draft.warnings) {
          console.warn(`[tds-return-draft] WARN ${w}`);
        }

        // ---- Full-PAN CSV → private bucket -----------------------------
        // Decrypt per deductee, in this process only. A failure here degrades
        // one line to a blank PAN (which the s.397(2) warning already flags)
        // rather than failing the whole quarter's export.
        const fullPanByDeducteeKey = new Map<string, string | null>();
        for (const [key, identity] of identityByKey) {
          if (!identity.panEncrypted) {
            fullPanByDeducteeKey.set(key, null);
            continue;
          }
          try {
            fullPanByDeducteeKey.set(
              key,
              decryptPAN(Buffer.from(identity.panEncrypted)),
            );
          } catch (err) {
            fullPanByDeducteeKey.set(key, null);
            // The key names the deductee, never the PAN or the ciphertext.
            console.error(
              `[tds-return-draft] PAN decrypt failed for ${key}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        const storagePath = tdsReturnCsvStoragePath(financialYear, quarter);
        await uploadPrivateFinanceObject({
          storagePath,
          body: Buffer.from(
            buildTdsReturnCsv(draft, fullPanByDeducteeKey),
            "utf8",
          ),
          contentType: "text/csv; charset=utf-8",
        });
        // Path only — the object itself is the one place a full PAN lives, and
        // it is reachable solely through the authenticated admin route.
        console.log(`[tds-return-draft] CSV written to ${storagePath}`);

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
