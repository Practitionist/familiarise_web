/**
 * Two read-only reconcile checks: org-invoice output tax against the
 * GST_PAYABLE booked behind it, and clawback receivables that have
 * gone unrecovered for longer than the recovery window.
 */

import prisma from "@/lib/prisma";
import { sumPaise } from "@/lib/payments/utils/money";
import type { LedgerDirection } from "@prisma/client";
import {
  CLAWBACK_RECOVERY_KEY_PREFIX,
  CLAWBACK_RECOVERY_RELEASE_KEY_PREFIX,
  ORG_CLAWBACK_KEY_FILTER,
  RECOVERY_RELEASING_STATUSES,
  type ClawbackPayee,
} from "@/lib/payments/payouts/clawback-recovery";
import type { Finding } from "./reconcile-ledgers";

const CHUNK = 5_000;

/** A clawback still owed after this long raises the run's one stale-receivable finding. */
export const CLAWBACK_RECOVERY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Per issued org invoice: its output tax (less credit-note tax) must equal the
 * net GST_PAYABLE behind it — the billed bookings' journals for an invoice that
 * bills bookings (within a paisa per booking), else its own `invoice-issued:`
 * and refund journals, exactly.
 */
export async function orgInvoiceGstFindings(
  organizationId?: string,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  let cursor: string | undefined;
  for (;;) {
    const slice = await prisma.organizationInvoice.findMany({
      where: {
        status: { in: ["ISSUED", "PAID", "OVERDUE"] },
        ...(organizationId ? { organizationId } : {}),
      },
      orderBy: { id: "asc" },
      take: CHUNK,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        organizationId: true,
        igstPaise: true,
        cgstPaise: true,
        sgstPaise: true,
        billedPayments: { select: { id: true } },
        creditNotes: {
          where: { status: "ISSUED" },
          select: { igstPaise: true, cgstPaise: true, sgstPaise: true },
        },
      },
    });
    if (slice.length === 0) break;
    cursor = slice[slice.length - 1].id;

    const bookingIdsByInvoice = new Map<string, string[]>();
    const journalledIds: string[] = [];
    for (const inv of slice) {
      if (inv.billedPayments.length > 0) {
        bookingIdsByInvoice.set(
          inv.id,
          inv.billedPayments.map((p) => p.id),
        );
      } else {
        journalledIds.push(inv.id);
      }
    }

    const entries = await prisma.ledgerEntry.findMany({
      where: {
        account: { kind: "GST_PAYABLE" },
        transaction: {
          OR: [
            {
              paymentId: {
                in: [...bookingIdsByInvoice.values()].flat(),
              },
            },
            { invoiceId: { in: journalledIds } },
          ],
        },
      },
      select: {
        direction: true,
        amountPaise: true,
        transaction: { select: { paymentId: true, invoiceId: true } },
      },
    });
    const gstByPayment = new Map<string, number>();
    const gstByInvoice = new Map<string, number>();
    for (const e of entries) {
      const signed =
        e.direction === "CREDIT"
          ? sumPaise(e.amountPaise)
          : -sumPaise(e.amountPaise);
      const { paymentId, invoiceId } = e.transaction;
      if (paymentId) {
        gstByPayment.set(
          paymentId,
          (gstByPayment.get(paymentId) ?? 0) + signed,
        );
      } else if (invoiceId) {
        gstByInvoice.set(
          invoiceId,
          (gstByInvoice.get(invoiceId) ?? 0) + signed,
        );
      }
    }

    for (const inv of slice) {
      const noteTax = inv.creditNotes.reduce(
        (s, n) => s + n.igstPaise + n.cgstPaise + n.sgstPaise,
        0,
      );
      const expected = inv.igstPaise + inv.cgstPaise + inv.sgstPaise - noteTax;
      const bookingIds = bookingIdsByInvoice.get(inv.id);
      const posted = bookingIds
        ? bookingIds.reduce((s, id) => s + (gstByPayment.get(id) ?? 0), 0)
        : (gstByInvoice.get(inv.id) ?? 0);
      const tolerance = bookingIds ? bookingIds.length : 0;
      if (Math.abs(expected - posted) <= tolerance) continue;
      findings.push({
        kind: "ORG_INVOICE_GST_MISMATCH",
        organizationId: inv.organizationId,
        invoiceId: inv.id,
        expectedPaise: expected,
        actualPaise: posted,
        deltaPaise: posted - expected,
        details: bookingIds
          ? {
              billedPayments: bookingIds.length,
              note: "The invoice's output tax (less its credit notes) differs from the net GST_PAYABLE its billed bookings posted.",
            }
          : {
              note: "The invoice's output tax (less its credit notes) differs from the net GST_PAYABLE of its invoice-issued and refund journals.",
            },
      });
    }
    if (slice.length < CHUNK) break;
  }
  return findings;
}

type ReceivableEvent = {
  payeeId: string;
  kind: "OWED" | "RECOVERED" | "RELEASED";
  paise: number;
  at: Date;
  payoutId: string | null;
};

/** The date the oldest still-unrecovered clawback was booked, or null when none is owed. */
export function oldestUnrecoveredAt(events: ReceivableEvent[]): Date | null {
  const recovered = events.reduce(
    (s, e) =>
      e.kind === "RECOVERED"
        ? s + e.paise
        : e.kind === "RELEASED"
          ? s - e.paise
          : s,
    0,
  );
  let covered = 0;
  const owed = events
    .filter((e) => e.kind === "OWED")
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const e of owed) {
    covered += e.paise;
    if (covered > recovered) return e.at;
  }
  return null;
}

/** A recovery on a payout that has since failed, been cancelled or reversed no longer stands. */
async function dropLapsedRecoveries(
  events: ReceivableEvent[],
  rail: ClawbackPayee["rail"],
): Promise<ReceivableEvent[]> {
  const released = new Set(
    events.filter((e) => e.kind === "RELEASED").map((e) => e.payoutId),
  );
  const open = [
    ...new Set(
      events
        .filter((e) => e.kind === "RECOVERED" && !released.has(e.payoutId))
        .map((e) => e.payoutId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (open.length === 0) return events;
  const where = {
    id: { in: open },
    status: { in: RECOVERY_RELEASING_STATUSES },
  };
  const lapsed =
    rail === "CONSULTANT"
      ? await prisma.consultantPayout.findMany({ where, select: { id: true } })
      : await prisma.organizationPayout.findMany({
          where,
          select: { id: true },
        });
  const lapsedIds = new Set(lapsed.map((p) => p.id));
  return events.filter(
    (e) => !(e.kind === "RECOVERED" && e.payoutId && lapsedIds.has(e.payoutId)),
  );
}

function classify(
  key: string,
  direction: LedgerDirection,
  rail: ClawbackPayee["rail"],
): ReceivableEvent["kind"] {
  if (key.startsWith(CLAWBACK_RECOVERY_RELEASE_KEY_PREFIX)) return "RELEASED";
  if (key.startsWith(CLAWBACK_RECOVERY_KEY_PREFIX)) return "RECOVERED";
  // The consultant receivable is debited when owed; the org twin credits ORG_PAYABLE.
  if (rail === "CONSULTANT")
    return direction === "DEBIT" ? "OWED" : "RECOVERED";
  return direction === "CREDIT" ? "OWED" : "RECOVERED";
}

async function staleForRail(
  rail: ClawbackPayee["rail"],
  now: Date,
  organizationId?: string,
): Promise<{ payeeId: string; outstandingPaise: number; since: Date }[]> {
  const entries = await prisma.ledgerEntry.findMany({
    where:
      rail === "CONSULTANT"
        ? { account: { kind: "CONSULTANT_RECEIVABLE" } }
        : {
            account: {
              kind: "ORG_PAYABLE",
              ...(organizationId ? { organizationId } : {}),
            },
            transaction: ORG_CLAWBACK_KEY_FILTER,
          },
    select: {
      direction: true,
      amountPaise: true,
      createdAt: true,
      account: { select: { consultantProfileId: true, organizationId: true } },
      transaction: { select: { idempotencyKey: true, payoutId: true } },
    },
  });
  const byPayee = new Map<string, ReceivableEvent[]>();
  for (const e of entries) {
    const payeeId =
      rail === "CONSULTANT"
        ? e.account.consultantProfileId
        : e.account.organizationId;
    if (!payeeId) continue;
    const list = byPayee.get(payeeId) ?? [];
    list.push({
      payeeId,
      kind: classify(e.transaction.idempotencyKey, e.direction, rail),
      paise: sumPaise(e.amountPaise),
      at: e.createdAt,
      payoutId: e.transaction.payoutId,
    });
    byPayee.set(payeeId, list);
  }
  const stale: { payeeId: string; outstandingPaise: number; since: Date }[] =
    [];
  for (const [payeeId, raw] of byPayee) {
    const events = await dropLapsedRecoveries(raw, rail);
    const since = oldestUnrecoveredAt(events);
    if (
      !since ||
      now.getTime() - since.getTime() < CLAWBACK_RECOVERY_WINDOW_MS
    ) {
      continue;
    }
    const outstandingPaise = events.reduce(
      (s, e) =>
        e.kind === "OWED" || e.kind === "RELEASED" ? s + e.paise : s - e.paise,
      0,
    );
    stale.push({ payeeId, outstandingPaise, since });
  }
  return stale;
}

/** One finding per run, never per payee, listing every receivable past the window. */
export async function staleClawbackFindings(
  now: Date,
  organizationId?: string,
): Promise<Finding[]> {
  const consultants = organizationId
    ? []
    : await staleForRail("CONSULTANT", now);
  const orgs = await staleForRail("ORG", now, organizationId);
  const all = [
    ...consultants.map((s) => ({ ...s, rail: "CONSULTANT" as const })),
    ...orgs.map((s) => ({ ...s, rail: "ORG" as const })),
  ];
  if (all.length === 0) return [];
  const total = all.reduce((s, r) => s + r.outstandingPaise, 0);
  return [
    {
      kind: "CLAWBACK_RECEIVABLE_STALE",
      ...(organizationId ? { organizationId } : {}),
      expectedPaise: 0,
      actualPaise: total,
      deltaPaise: total,
      details: {
        payees: all.length,
        sample: all.slice(0, 20).map((r) => ({
          rail: r.rail,
          payeeId: r.payeeId,
          outstandingPaise: r.outstandingPaise,
          since: r.since.toISOString(),
        })),
        note: "Clawbacks unrecovered for more than 90 days: the payee has had no payout large enough to net them.",
      },
    },
  ];
}
