/**
 * Checked-in baseline of known ledger findings.
 *
 * The auditor raises a finding for every divergence it sees. Some of those
 * divergences are known demo/QA rows nobody has cleaned up yet, and a nightly
 * run that is permanently red teaches ops to ignore it — the worst outcome for
 * a safety net. A baseline entry pins ONE such finding by fingerprint so the
 * run fails only on NEW drift.
 *
 * The rules the baseline keeps:
 *
 *   - An entry matches a finding only when the kind, the delta and every
 *     identifier the finding carries agree, so a new row, a new amount or a
 *     new counter is never excused.
 *   - Every entry carries an owner, a reason and an expiry. An expired entry
 *     excuses nothing, so an allowlist can never become permanent.
 *   - A malformed entry is ignored AND fails the run, so a broken baseline can
 *     never silently green a run.
 *
 * The raw findings are never touched: the baseline only decides which ones
 * fail the run, and every finding still lands in the persisted report.
 */

import { z } from "zod";
import type { Finding } from "./reconcile-ledgers";

/** The entity ids a finding may carry. Each one is a fingerprint component. */
const LEDGER_BASELINE_ID_FIELDS = [
  "organizationId",
  "billingAccountId",
  "paymentId",
  "payoutId",
  "invoiceId",
  "programAssignmentId",
  "billingSubscriptionId",
] as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) return false;
    // Date.parse normalises an impossible date instead of rejecting it, so
    // 2026-02-30 would become 2 March and quietly extend the entry's life.
    // The parsed components must read back as the ones that were written.
    return (
      parsed.getUTCFullYear() === Number(value.slice(0, 4)) &&
      parsed.getUTCMonth() + 1 === Number(value.slice(5, 7)) &&
      parsed.getUTCDate() === Number(value.slice(8, 10))
    );
  }, "must be a real calendar date");

/**
 * One known finding. `kind` is checked against the kinds the auditor can
 * raise at match time, so a renamed or retired kind is rejected rather than
 * silently never matching.
 */
export const ledgerBaselineEntrySchema = z
  .object({
    kind: z.string().min(1),
    organizationId: z.string().min(1).optional(),
    billingAccountId: z.string().min(1).optional(),
    paymentId: z.string().min(1).optional(),
    payoutId: z.string().min(1).optional(),
    invoiceId: z.string().min(1).optional(),
    programAssignmentId: z.string().min(1).optional(),
    billingSubscriptionId: z.string().min(1).optional(),
    /** Pins one `details` key for findings that carry no entity id of their own. */
    detail: z
      .object({ key: z.string().min(1), value: z.string().min(1) })
      .optional(),
    deltaPaise: z.number().int(),
    /** How many findings of this fingerprint the entry excuses. Defaults to one. */
    occurrences: z.number().int().positive().optional().default(1),
    owner: z.string().min(1),
    reason: z.string().min(1),
    expires: isoDate,
  })
  .refine(
    (entry) =>
      entry.kind !== "EARNINGS_WITHOUT_BOOKING_TXN" || !!entry.paymentId,
    {
      message: "missing booking journal baselines must pin paymentId",
      path: ["paymentId"],
    },
  );

/** A baseline entry as authored. The kind must be one the auditor can raise. */
export type LedgerBaselineEntry = Omit<
  z.input<typeof ledgerBaselineEntrySchema>,
  "kind"
> & {
  kind: Finding["kind"];
};

type ParsedBaselineEntry = z.output<typeof ledgerBaselineEntrySchema>;

export type LedgerBaselineEvaluation = {
  /** True when the run may pass: every finding baselined and the baseline sound. */
  ok: boolean;
  /** How many findings the baseline excuses. */
  baselinedCount: number;
  /** How many findings the baseline does not excuse — each one fails the run. */
  unbaselinedCount: number;
  /** Entries whose expiry has passed. They excuse nothing. */
  expiredEntryCount: number;
  /** Why the baseline was rejected. A non-empty list fails the run. */
  problems: string[];
  /** Per finding, in order: whether the baseline excuses it. */
  baselined: boolean[];
};

/**
 * The known findings of the current database.
 *
 * Every entry is a seeded demo/QA row, owned by finance, and expires on the
 * date in its `expires` field — after which the finding fails the run again.
 */
export const LEDGER_FINDINGS_BASELINE: LedgerBaselineEntry[] = [
  {
    kind: "EARNINGS_WITHOUT_BOOKING_TXN",
    paymentId: "qa2188_pc1",
    deltaPaise: -1,
    owner: "finance",
    reason: "QA fixture id written without a booking journal",
    expires: "2026-12-15",
  },
  {
    kind: "EARNINGS_WITHOUT_BOOKING_TXN",
    paymentId: "qa2188_pc3",
    deltaPaise: -1,
    owner: "finance",
    reason: "QA fixture id written without a booking journal",
    expires: "2026-12-15",
  },
  {
    kind: "EARNINGS_WITHOUT_BOOKING_TXN",
    paymentId: "qa2188_pr1",
    deltaPaise: -1,
    owner: "finance",
    reason: "QA fixture id written without a booking journal",
    expires: "2026-12-15",
  },
  {
    kind: "EARNINGS_WITHOUT_BOOKING_TXN",
    paymentId: "qa2188_pr2",
    deltaPaise: -1,
    owner: "finance",
    reason: "QA fixture id written without a booking journal",
    expires: "2026-12-15",
  },
  {
    kind: "EARNINGS_WITHOUT_BOOKING_TXN",
    paymentId: "qa2188_pr3",
    deltaPaise: -1,
    owner: "finance",
    reason: "QA fixture id written without a booking journal",
    expires: "2026-12-15",
  },
  {
    kind: "EARNINGS_WITHOUT_BOOKING_TXN",
    paymentId: "qa2188_pt",
    deltaPaise: -1,
    owner: "finance",
    reason: "QA fixture id written without a booking journal",
    expires: "2026-12-15",
  },
  {
    kind: "EARNINGS_WITHOUT_BOOKING_TXN",
    paymentId: "qa2188_px",
    deltaPaise: -1,
    owner: "finance",
    reason: "QA fixture id written without a booking journal",
    expires: "2026-12-15",
  },
  {
    kind: "REFUND_BOOKING_COHERENCE",
    paymentId: "7d747d97-efa6-4bef-9857-8453a5798330",
    detail: {
      key: "bookingUtilizationId",
      value: "b3d9d798-a58f-4e07-8dc7-af0243887a01",
    },
    deltaPaise: 231_305,
    owner: "finance",
    reason: "seeded QA payment",
    expires: "2026-12-15",
  },
  {
    kind: "EARNINGS_LEDGER_DRIFT",
    paymentId: "81ec1be6-0e84-4a6a-9e9a-b5799379d857",
    deltaPaise: 32_000_000,
    owner: "finance",
    reason: "seeded demo booking",
    expires: "2026-12-15",
  },
  {
    kind: "EARNINGS_LEDGER_DRIFT",
    paymentId: "qa1724-case7-pay",
    deltaPaise: -1_619_371,
    owner: "finance",
    reason: "QA fixture id",
    expires: "2026-12-15",
  },
  {
    kind: "EARNINGS_LEDGER_DRIFT",
    paymentId: "a1a1a1a1-0008-4b1a-9c1a-0000000000a1",
    deltaPaise: -337_713,
    owner: "finance",
    reason: "QA fixture id",
    expires: "2026-12-15",
  },
  {
    kind: "EARNINGS_LEDGER_DRIFT",
    paymentId: "26e9243c-0f8e-4341-80a4-193cc12cec32",
    deltaPaise: -4_638_743,
    owner: "finance",
    reason: "seeded demo booking",
    expires: "2026-12-15",
  },
  {
    kind: "EARNINGS_LEDGER_DRIFT",
    paymentId: "bb5c5e7b-9721-4a3f-a385-ea5dd9a601dc",
    deltaPaise: -1_985_033,
    owner: "finance",
    reason: "seeded demo booking",
    expires: "2026-12-15",
  },
  {
    kind: "EARNINGS_LEDGER_DRIFT",
    paymentId: "49c37361-4942-4797-933c-a3f1da480f4d",
    deltaPaise: -3_970_067,
    owner: "finance",
    reason: "seeded demo booking",
    expires: "2026-12-15",
  },
  {
    kind: "EARNINGS_LEDGER_DRIFT",
    paymentId: "qa1834_paymentA_case7",
    deltaPaise: -2_000_000,
    owner: "finance",
    reason: "QA fixture id",
    expires: "2026-12-15",
  },
  {
    kind: "EARNINGS_LEDGER_DRIFT",
    paymentId: "57dd6725-f0fe-498c-a176-8a928e6a72e8",
    deltaPaise: 1_995_000,
    owner: "finance",
    reason: "seeded demo booking",
    expires: "2026-12-15",
  },
  {
    kind: "EARNINGS_LEDGER_DRIFT",
    paymentId: "57dd6725-f0fe-498c-a176-8a928e6a72e8",
    deltaPaise: 1_990_000,
    owner: "finance",
    reason: "seeded demo booking",
    expires: "2026-12-15",
  },
  {
    kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
    payoutId: "cmu15ushp03qec7yoj64escgg",
    deltaPaise: 2_904_242,
    owner: "finance",
    reason: "seeded demo payout predating the posting",
    expires: "2026-12-15",
  },
  {
    kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
    payoutId: "qa2152_payout_prior",
    deltaPaise: 24_000_000,
    owner: "finance",
    reason: "QA fixture id",
    expires: "2026-12-15",
  },
  {
    kind: "SPLIT_SUM_MISMATCH",
    paymentId: "81ec1be6-0e84-4a6a-9e9a-b5799379d857",
    deltaPaise: 32_000_000,
    owner: "finance",
    reason:
      "seeded demo booking, same payment as the EARNINGS_LEDGER_DRIFT entry",
    expires: "2026-12-15",
  },
];

/** True when the entry's expiry date has passed (valid through the end of it). */
function isExpired(expires: string, now: Date): boolean {
  return now.getTime() > Date.parse(`${expires}T23:59:59.999Z`);
}

/**
 * The fingerprint test: kind, delta, the entity ids and the pinned detail key
 * must all agree. An identifier the finding carries but the entry does not pin
 * means the finding drifted into a shape the entry never described, so the
 * entry does not excuse it.
 */
function matchesEntry(finding: Finding, entry: ParsedBaselineEntry): boolean {
  if (finding.kind !== entry.kind) return false;
  if (finding.deltaPaise !== entry.deltaPaise) return false;
  for (const field of LEDGER_BASELINE_ID_FIELDS) {
    const findingValue = finding[field];
    const entryValue = entry[field];
    if (findingValue === undefined && entryValue === undefined) continue;
    if (findingValue === undefined || entryValue === undefined) return false;
    if (findingValue !== entryValue) return false;
  }
  if (entry.detail) {
    const detailValue = finding.details?.[entry.detail.key];
    if (typeof detailValue !== "string") return false;
    if (detailValue !== entry.detail.value) return false;
  }
  return true;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "entry"}: ${issue.message}`)
    .join("; ");
}

/**
 * Split the findings into the ones the baseline excuses and the ones that
 * fail the run.
 *
 * A malformed entry is reported as a problem and excuses nothing, and any
 * problem fails the run: a broken baseline must never be able to green it.
 */
export function evaluateLedgerBaseline(args: {
  findings: readonly Finding[];
  entries: unknown;
  knownKinds: readonly string[];
  now: Date;
}): LedgerBaselineEvaluation {
  const { findings, entries, knownKinds, now } = args;
  const problems: string[] = [];
  const usable: Array<{ entry: ParsedBaselineEntry; remaining: number }> = [];
  let expiredEntryCount = 0;

  if (!Array.isArray(entries)) {
    problems.push("baseline is not a list of entries");
  } else {
    entries.forEach((raw, index) => {
      const parsed = ledgerBaselineEntrySchema.safeParse(raw);
      if (!parsed.success) {
        problems.push(`baseline entry ${index}: ${formatIssues(parsed.error)}`);
        return;
      }
      if (!knownKinds.includes(parsed.data.kind)) {
        problems.push(
          `baseline entry ${index}: unknown finding kind "${parsed.data.kind}"`,
        );
        return;
      }
      if (isExpired(parsed.data.expires, now)) {
        expiredEntryCount += 1;
        return;
      }
      usable.push({ entry: parsed.data, remaining: parsed.data.occurrences });
    });
  }

  const baselined = findings.map(() => false);
  findings.forEach((finding, index) => {
    const match = usable.find(
      (candidate) =>
        candidate.remaining > 0 && matchesEntry(finding, candidate.entry),
    );
    if (!match) return;
    match.remaining -= 1;
    baselined[index] = true;
  });

  const baselinedCount = baselined.filter((isBaselined) => isBaselined).length;
  const unbaselinedCount = findings.length - baselinedCount;

  return {
    ok: unbaselinedCount === 0 && problems.length === 0,
    baselinedCount,
    unbaselinedCount,
    expiredEntryCount,
    problems,
    baselined,
  };
}
