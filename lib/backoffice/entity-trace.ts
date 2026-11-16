import prisma from "@/lib/prisma";
import { getBookingTimeline } from "@/lib/data/booking-history";
import { sentrySearchHref } from "@/lib/observability/sentry-issues";
import { formatCurrencyAmount } from "@/utils/formatting";
import { formatOperatorInstant } from "@/lib/time/operator-zone";
import {
  TRACE_SOURCES,
  type EntityTrace,
  type TraceCandidates,
  type TraceRow,
  type TraceSource,
  type TraceSourceReport,
} from "./entity-trace-types";

export type {
  EntityTrace,
  TraceCandidates,
  TraceRow,
} from "./entity-trace-types";

/**
 * One payment's or booking's whole life as a single read-only timeline. One
 * bounded query per source, run in sequence (PG_POOL_MAX=1), each reading one
 * row over its cap so a cut is measured; a failed source is reported, not fatal.
 */

export const TRACE_ROW_CAP = 50;
/** Payments read for one booking, and per user in the picker. */
export const TRACE_PAYMENT_CAP = 20;
const CASE_CAP = 10;
const CASE_EVENT_CAP = 30;

const SOURCE_RANK = new Map<TraceSource, number>(
  TRACE_SOURCES.map((source, i) => [source, i]),
);

/** Oldest first; equal instants order by source, then key; duplicate keys collapse. */
export function mergeTimeline(rows: readonly TraceRow[]): TraceRow[] {
  const byKey = new Map<string, TraceRow>();
  for (const row of rows) {
    if (Number.isNaN(Date.parse(row.at))) continue;
    if (!byKey.has(row.key)) byKey.set(row.key, row);
  }
  return [...byKey.values()].sort((a, b) => {
    const delta = Date.parse(a.at) - Date.parse(b.at);
    if (delta !== 0) return delta;
    const rank =
      (SOURCE_RANK.get(a.source) ?? 0) - (SOURCE_RANK.get(b.source) ?? 0);
    if (rank !== 0) return rank;
    if (a.key < b.key) return -1;
    return a.key > b.key ? 1 : 0;
  });
}

type RowInput = Partial<Pick<TraceRow, "currency" | "actor" | "detail">> & {
  status: string;
  amountPaise?: number | bigint | null;
};

function makeRow(
  source: TraceSource,
  entityId: string,
  event: string,
  at: Date | null | undefined,
  input: RowInput,
): TraceRow[] {
  if (!at) return [];
  return [
    {
      key: `${source}:${entityId}:${event}`,
      at: at.toISOString(),
      source,
      status: input.status,
      amountPaise:
        input.amountPaise === null || input.amountPaise === undefined
          ? null
          : Number(input.amountPaise),
      currency: input.currency ?? null,
      actor: input.actor ?? null,
      detail: input.detail ?? null,
      entityId,
      sentryHref: sentrySearchHref(entityId),
    },
  ];
}

const join = (parts: (string | null | undefined | false)[]) =>
  parts.filter(Boolean).join(" · ") || null;

class TraceCollector {
  readonly rows: TraceRow[] = [];
  private readonly reports = new Map<TraceSource, TraceSourceReport>();

  private report(source: TraceSource): TraceSourceReport {
    let r = this.reports.get(source);
    if (!r) {
      r = { source, rows: 0, truncated: false, failed: false };
      this.reports.set(source, r);
    }
    return r;
  }

  add(source: TraceSource, rows: TraceRow[], truncated = false) {
    const r = this.report(source);
    r.rows += rows.length;
    r.truncated ||= truncated;
    this.rows.push(...rows);
  }

  /** A nested relation read with `take: cap + 1`: keeps `cap` items and records a cut. */
  addCapped<T>(
    source: TraceSource,
    items: readonly T[],
    cap: number,
    toRows: (kept: T[]) => TraceRow[],
  ): T[] {
    const kept = items.slice(0, cap);
    this.add(source, toRows(kept), items.length > cap);
    return kept;
  }

  /** One read: keeps the first `cap` items, records a cut, and survives a failure. */
  async read<T>(
    source: TraceSource,
    cap: number,
    query: () => Promise<T[]>,
    toRows: (item: T) => TraceRow[],
  ): Promise<T[]> {
    try {
      const items = await query();
      const kept = items.slice(0, cap);
      this.add(source, kept.flatMap(toRows), items.length > cap);
      return kept;
    } catch (err) {
      this.fail(source, err);
      return [];
    }
  }

  fail(source: TraceSource, err: unknown) {
    console.warn(
      `[entity-trace] ${source} read failed:`,
      err instanceof Error ? err.message : String(err),
    );
    this.report(source).failed = true;
  }

  sourceReports(): TraceSourceReport[] {
    return TRACE_SOURCES.map(
      (source) =>
        this.reports.get(source) ?? {
          source,
          rows: 0,
          truncated: false,
          failed: false,
        },
    );
  }
}

const PAYMENT_SELECT = {
  id: true,
  amount: true,
  currency: true,
  paymentStatus: true,
  paymentGateway: true,
  paymentIntent: true,
  gatewayPaymentId: true,
  userId: true,
  appointmentId: true,
  organizationId: true,
  hostOrganizationId: true,
  billableToOrgInvoiceId: true,
  parentPaymentId: true,
  refundOwedPaise: true,
  refundOwedReason: true,
  refundOwedAt: true,
  capturedAt: true,
  lastReconciledAt: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { name: true } },
} as const;

async function readRootPayments(kind: EntityTrace["kind"], id: string) {
  if (kind === "payment") {
    const payment = await prisma.payment.findUnique({
      where: { id },
      select: {
        ...PAYMENT_SELECT,
        childPayments: {
          select: PAYMENT_SELECT,
          orderBy: { createdAt: "desc" },
          take: TRACE_PAYMENT_CAP + 1,
        },
      },
      relationLoadStrategy: "join",
    });
    if (!payment) return null;
    const { childPayments, ...root } = payment;
    return {
      appointmentId: root.appointmentId,
      payments: [root, ...childPayments],
      cap: TRACE_PAYMENT_CAP + 1,
    };
  }
  const appointment = await prisma.appointment.findUnique({
    where: { id },
    select: {
      id: true,
      payment: {
        select: PAYMENT_SELECT,
        orderBy: { createdAt: "desc" },
        take: TRACE_PAYMENT_CAP + 1,
      },
    },
    relationLoadStrategy: "join",
  });
  if (!appointment) return null;
  return {
    appointmentId: appointment.id,
    payments: appointment.payment,
    cap: TRACE_PAYMENT_CAP,
  };
}

type RootPayment = NonNullable<
  Awaited<ReturnType<typeof readRootPayments>>
>["payments"][number];

function paymentRows(p: RootPayment): TraceRow[] {
  const money = { amountPaise: p.amount, currency: p.currency };
  return [
    ...makeRow("payment", p.id, "created", p.createdAt, {
      status: "Created",
      ...money,
      actor: p.user.name,
      detail: join([
        p.paymentGateway,
        `order ${p.paymentIntent}`,
        p.parentPaymentId && `side charge of ${p.parentPaymentId}`,
      ]),
    }),
    ...makeRow("payment", p.id, "captured", p.capturedAt, {
      status: "Captured",
      ...money,
      detail: p.gatewayPaymentId,
    }),
    ...makeRow("payment", p.id, "refund-owed", p.refundOwedAt, {
      status: "Refund owed",
      amountPaise: p.refundOwedPaise,
      currency: p.currency,
      detail: p.refundOwedReason,
    }),
    ...makeRow("payment", p.id, "reconciled", p.lastReconciledAt, {
      status: "Reconciled with gateway",
    }),
    ...makeRow("payment", p.id, "deleted", p.deletedAt, { status: "Deleted" }),
    ...makeRow("payment", p.id, "status", p.updatedAt, {
      status: `Now ${p.paymentStatus}`,
      detail: "Last write to the payment row",
    }),
  ];
}

export interface TraceViewer {
  userId: string;
  role: string;
  /** System events are an admin surface; staff traces leave them out. */
  seesSystemEvents: boolean;
}

export async function readEntityTrace(args: {
  kind: EntityTrace["kind"];
  id: string;
  viewer: TraceViewer;
}): Promise<EntityTrace | null> {
  const root = await readRootPayments(args.kind, args.id);
  if (!root) return null;
  const t = new TraceCollector();
  const payments = t.addCapped("payment", root.payments, root.cap, (kept) =>
    kept.flatMap(paymentRows),
  );
  const P = payments.map((p) => p.id);
  const A = root.appointmentId;
  const take = TRACE_ROW_CAP + 1;
  const hasPayments = P.length > 0;

  if (hasPayments) {
    await t.read(
      "leg",
      TRACE_ROW_CAP,
      () =>
        prisma.paymentLeg.findMany({
          where: { paymentId: { in: P } },
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true,
            source: true,
            amountPaise: true,
            sourceRef: true,
            createdAt: true,
          },
        }),
      (l) =>
        makeRow("leg", l.id, "created", l.createdAt, {
          status: `Funding leg ${l.source}`,
          amountPaise: l.amountPaise,
          currency: "INR",
          detail: l.sourceRef,
        }),
    );
  }

  const refunds = hasPayments
    ? await t.read(
        "refund",
        TRACE_ROW_CAP,
        () =>
          prisma.refund.findMany({
            where: { paymentId: { in: P } },
            orderBy: { createdAt: "desc" },
            take,
            select: {
              id: true,
              amountPaise: true,
              currency: true,
              status: true,
              reason: true,
              refundId: true,
              failureReason: true,
              failedAt: true,
              cascadedAt: true,
              deletedAt: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
        (r) => {
          const money = { amountPaise: r.amountPaise, currency: r.currency };
          return [
            ...makeRow("refund", r.id, "created", r.createdAt, {
              status: "Refund created",
              ...money,
              detail: join([`gateway ${r.refundId}`, r.reason]),
            }),
            ...makeRow("refund", r.id, "failed", r.failedAt, {
              status: "Refund failed",
              ...money,
              detail: r.failureReason,
            }),
            ...makeRow("refund", r.id, "cascaded", r.cascadedAt, {
              status: "Refund cascade applied",
              detail: "Earnings and documents adjusted",
            }),
            ...makeRow("refund", r.id, "deleted", r.deletedAt, {
              status: "Refund deleted",
            }),
            ...makeRow("refund", r.id, "status", r.updatedAt, {
              status: `Refund now ${r.status}`,
              ...money,
            }),
          ];
        },
      )
    : [];

  const disputes = hasPayments
    ? await t.read(
        "dispute",
        TRACE_ROW_CAP,
        () =>
          prisma.dispute.findMany({
            where: { paymentId: { in: P } },
            orderBy: { createdAt: "desc" },
            take,
            select: {
              id: true,
              amountPaise: true,
              currency: true,
              status: true,
              reason: true,
              disputeId: true,
              dueBy: true,
              evidenceSubmittedAt: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
        (d) => {
          const money = { amountPaise: d.amountPaise, currency: d.currency };
          return [
            ...makeRow("dispute", d.id, "opened", d.createdAt, {
              status: "Dispute opened",
              ...money,
              detail: join([
                d.reason,
                `gateway ${d.disputeId}`,
                d.dueBy &&
                  `respond by ${formatOperatorInstant(d.dueBy, "date")}`,
              ]),
            }),
            ...makeRow("dispute", d.id, "evidence", d.evidenceSubmittedAt, {
              status: "Evidence submitted",
            }),
            ...makeRow("dispute", d.id, "status", d.updatedAt, {
              status: `Dispute now ${d.status}`,
              ...money,
            }),
          ];
        },
      )
    : [];

  if (hasPayments) {
    await t.read(
      "ledger",
      TRACE_ROW_CAP,
      () =>
        prisma.ledgerTransaction.findMany({
          where: { paymentId: { in: P } },
          orderBy: { postedAt: "desc" },
          take,
          select: {
            id: true,
            kind: true,
            description: true,
            postedAt: true,
            entries: {
              select: {
                direction: true,
                amountPaise: true,
                account: { select: { kind: true } },
              },
            },
          },
          relationLoadStrategy: "join",
        }),
      (txn) => {
        const debits = txn.entries.filter((e) => e.direction === "DEBIT");
        const credits = txn.entries.filter((e) => e.direction === "CREDIT");
        const kinds = (list: typeof txn.entries) =>
          [...new Set(list.map((e) => e.account.kind))].join(", ");
        return makeRow("ledger", txn.id, "posted", txn.postedAt, {
          status: `Ledger ${txn.kind}`,
          amountPaise: debits.reduce((s, e) => s + Number(e.amountPaise), 0),
          currency: "INR",
          detail: join([
            `${txn.entries.length} entries`,
            debits.length > 0 && `DR ${kinds(debits)}`,
            credits.length > 0 && `CR ${kinds(credits)}`,
            txn.description,
          ]),
        });
      },
    );
  }

  const holdRows = (
    holds: {
      id: string;
      reason: string;
      sourceRef: string;
      placedAt: Date;
      releasedAt: Date | null;
      note: string | null;
    }[],
  ) =>
    holds.flatMap((h) => [
      ...makeRow("hold", h.id, "placed", h.placedAt, {
        status: `Hold placed (${h.reason})`,
        detail: join([h.sourceRef, h.note]),
      }),
      ...makeRow("hold", h.id, "released", h.releasedAt, {
        status: "Hold released",
      }),
    ]);
  const HOLD_SELECT = {
    select: {
      id: true,
      reason: true,
      sourceRef: true,
      placedAt: true,
      releasedAt: true,
      note: true,
    },
    orderBy: { placedAt: "desc" },
    take: TRACE_ROW_CAP + 1,
  } as const;

  const earnings = hasPayments
    ? await t.read(
        "earnings",
        TRACE_ROW_CAP,
        () =>
          prisma.consultantEarnings.findMany({
            where: { paymentId: { in: P } },
            orderBy: { createdAt: "desc" },
            take,
            select: {
              id: true,
              payoutId: true,
              releasedFromPayoutId: true,
              role: true,
              status: true,
              consultantSharePaise: true,
              platformFeePaise: true,
              refundedShareAmount: true,
              currency: true,
              holdUntil: true,
              paidAt: true,
              createdAt: true,
              updatedAt: true,
              consultantProfile: {
                select: { user: { select: { name: true } } },
              },
              holds: HOLD_SELECT,
            },
            relationLoadStrategy: "join",
          }),
        (e) => {
          const money = {
            amountPaise: e.consultantSharePaise,
            currency: e.currency,
          };
          t.addCapped("hold", e.holds, TRACE_ROW_CAP, holdRows);
          return [
            ...makeRow("earnings", e.id, "created", e.createdAt, {
              status: "Earnings recorded",
              ...money,
              detail: join([
                `${e.role} share for ${e.consultantProfile.user.name}`,
                `platform fee ${formatCurrencyAmount(Number(e.platformFeePaise), e.currency)}`,
              ]),
            }),
            ...makeRow("earnings", e.id, "paid", e.paidAt, {
              status: "Earnings paid",
              ...money,
              detail: e.payoutId && `payout ${e.payoutId}`,
            }),
            ...makeRow("earnings", e.id, "status", e.updatedAt, {
              status: `Earnings now ${e.status}`,
              ...money,
              detail: join([
                e.holdUntil &&
                  `held until ${formatOperatorInstant(e.holdUntil, "date")}`,
                Number(e.refundedShareAmount) > 0 &&
                  `refunded share ${formatCurrencyAmount(Number(e.refundedShareAmount), e.currency)}`,
              ]),
            }),
          ];
        },
      )
    : [];

  const orgTagged = payments.some(
    (p) => p.hostOrganizationId || p.organizationId,
  );
  const orgEarnings = orgTagged
    ? await t.read(
        "earnings",
        TRACE_ROW_CAP,
        () =>
          prisma.organizationEarnings.findMany({
            where: { paymentId: { in: P } },
            orderBy: { createdAt: "desc" },
            take,
            select: {
              id: true,
              orgPayoutId: true,
              role: true,
              status: true,
              orgSharePaise: true,
              currency: true,
              createdAt: true,
              updatedAt: true,
              organization: { select: { name: true } },
              holds: HOLD_SELECT,
            },
            relationLoadStrategy: "join",
          }),
        (e) => {
          const money = { amountPaise: e.orgSharePaise, currency: e.currency };
          t.addCapped("hold", e.holds, TRACE_ROW_CAP, holdRows);
          return [
            ...makeRow("earnings", e.id, "created", e.createdAt, {
              status: "Organisation earnings recorded",
              ...money,
              detail: `${e.role} share for ${e.organization.name}`,
            }),
            ...makeRow("earnings", e.id, "status", e.updatedAt, {
              status: `Organisation earnings now ${e.status}`,
              ...money,
            }),
          ];
        },
      )
    : [];

  const payoutIds = [
    ...new Set(
      earnings.flatMap((e) =>
        [e.payoutId, e.releasedFromPayoutId].filter(
          (id): id is string => id !== null,
        ),
      ),
    ),
  ];
  if (payoutIds.length > 0) {
    await t.read(
      "payout",
      TRACE_ROW_CAP,
      () =>
        prisma.consultantPayout.findMany({
          where: { id: { in: payoutIds } },
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true,
            amount: true,
            netAmount: true,
            currency: true,
            status: true,
            kind: true,
            failureReason: true,
            gatewayUtr: true,
            clawbackAmountPaise: true,
            clawbackInitiatedAt: true,
            approvedAt: true,
            processedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      (p) => {
        const money = {
          amountPaise: p.netAmount ?? p.amount,
          currency: p.currency,
        };
        return [
          ...makeRow("payout", p.id, "created", p.createdAt, {
            status: "Payout created",
            ...money,
            detail: join([
              p.kind === "INSTANT" ? "instant payout" : "weekly batch",
              "covers this booking's earnings among others",
            ]),
          }),
          ...makeRow("payout", p.id, "approved", p.approvedAt, {
            status: "Payout approved",
          }),
          ...makeRow("payout", p.id, "processed", p.processedAt, {
            status: "Payout processed",
            ...money,
            detail: p.gatewayUtr && `UTR ${p.gatewayUtr}`,
          }),
          ...makeRow("payout", p.id, "clawback", p.clawbackInitiatedAt, {
            status: "Payout clawback",
            amountPaise: p.clawbackAmountPaise,
            currency: p.currency,
          }),
          ...makeRow("payout", p.id, "status", p.updatedAt, {
            status: `Payout now ${p.status}`,
            ...money,
            detail: p.failureReason,
          }),
        ];
      },
    );
  }

  const orgPayoutIds = [
    ...new Set(
      orgEarnings
        .map((e) => e.orgPayoutId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (orgPayoutIds.length > 0) {
    await t.read(
      "payout",
      TRACE_ROW_CAP,
      () =>
        prisma.organizationPayout.findMany({
          where: { id: { in: orgPayoutIds } },
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true,
            netPayoutPaise: true,
            currency: true,
            status: true,
            failureReason: true,
            gatewayUtr: true,
            approvedAt: true,
            processedAt: true,
            failedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      (p) => {
        const money = { amountPaise: p.netPayoutPaise, currency: p.currency };
        return [
          ...makeRow("payout", p.id, "created", p.createdAt, {
            status: "Organisation payout created",
            ...money,
          }),
          ...makeRow("payout", p.id, "approved", p.approvedAt, {
            status: "Organisation payout approved",
          }),
          ...makeRow("payout", p.id, "processed", p.processedAt, {
            status: "Organisation payout processed",
            ...money,
            detail: p.gatewayUtr && `UTR ${p.gatewayUtr}`,
          }),
          ...makeRow("payout", p.id, "failed", p.failedAt, {
            status: "Organisation payout failed",
            detail: p.failureReason,
          }),
          ...makeRow("payout", p.id, "status", p.updatedAt, {
            status: `Organisation payout now ${p.status}`,
            ...money,
          }),
        ];
      },
    );
  }

  if (hasPayments) {
    await t.read(
      "invoice",
      TRACE_ROW_CAP,
      () =>
        prisma.consumerInvoice.findMany({
          where: { paymentId: { in: P } },
          orderBy: { issuedAt: "desc" },
          take,
          select: {
            id: true,
            invoiceNumber: true,
            totalPaise: true,
            currency: true,
            issuedAt: true,
            creditNotes: {
              select: {
                id: true,
                creditNoteNumber: true,
                totalPaise: true,
                reason: true,
                refundId: true,
                issuedAt: true,
              },
              orderBy: { issuedAt: "desc" },
              take: TRACE_ROW_CAP + 1,
            },
          },
          relationLoadStrategy: "join",
        }),
      (inv) => {
        t.addCapped("creditNote", inv.creditNotes, TRACE_ROW_CAP, (kept) =>
          kept.flatMap((cn) =>
            makeRow("creditNote", cn.id, "issued", cn.issuedAt, {
              status: `Credit note ${cn.creditNoteNumber}`,
              amountPaise: cn.totalPaise,
              currency: inv.currency,
              detail: join([cn.reason, cn.refundId && `refund ${cn.refundId}`]),
            }),
          ),
        );
        return makeRow("invoice", inv.id, "issued", inv.issuedAt, {
          status: `Invoice ${inv.invoiceNumber}`,
          amountPaise: inv.totalPaise,
          currency: inv.currency,
        });
      },
    );
  }

  const billedOn = [
    ...new Set(
      payments
        .map((p) => p.billableToOrgInvoiceId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (billedOn.length > 0) {
    await t.read(
      "invoice",
      TRACE_ROW_CAP,
      () =>
        prisma.organizationInvoice.findMany({
          where: { id: { in: billedOn } },
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true,
            invoiceNumber: true,
            status: true,
            totalPaise: true,
            displayCurrency: true,
            issuedAt: true,
            paidAt: true,
            createdAt: true,
          },
        }),
      (inv) => {
        const money = {
          amountPaise: inv.totalPaise,
          currency: inv.displayCurrency,
        };
        return [
          ...makeRow(
            "invoice",
            inv.id,
            "issued",
            inv.issuedAt ?? inv.createdAt,
            {
              status: `Organisation invoice ${inv.invoiceNumber} (now ${inv.status})`,
              ...money,
              detail: "The payment was billed on this invoice",
            },
          ),
          ...makeRow("invoice", inv.id, "paid", inv.paidAt, {
            status: "Organisation invoice paid",
            ...money,
          }),
        ];
      },
    );
  }

  const refundIds = refunds.map((r) => r.id);
  const disputeIds = disputes.map((d) => d.id);
  if (orgTagged && (refundIds.length > 0 || disputeIds.length > 0)) {
    await t.read(
      "creditNote",
      TRACE_ROW_CAP,
      () =>
        prisma.creditNote.findMany({
          where: {
            OR: [
              { refundId: { in: refundIds } },
              { disputeId: { in: disputeIds } },
            ],
          },
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true,
            creditNoteNumber: true,
            status: true,
            totalPaise: true,
            reason: true,
            issuedAt: true,
            createdAt: true,
          },
        }),
      (cn) =>
        makeRow("creditNote", cn.id, "issued", cn.issuedAt ?? cn.createdAt, {
          status: `Organisation credit note ${cn.creditNoteNumber} (now ${cn.status})`,
          amountPaise: cn.totalPaise,
          currency: "INR",
          detail: cn.reason,
        }),
    );
  }

  const occurrenceIds: string[] = [];
  if (A) {
    try {
      const timeline = await getBookingTimeline(A, { kind: "all" });
      const entries = timeline?.entries ?? [];
      const kept = entries.slice(0, TRACE_ROW_CAP);
      for (const entry of entries) {
        if (entry.entity === "OCCURRENCE") occurrenceIds.push(entry.entityId);
      }
      t.add(
        "booking",
        kept.flatMap((entry) =>
          makeRow(
            "booking",
            entry.entityId,
            `${entry.kind}:${entry.id}`,
            new Date(entry.createdAt),
            {
              status: `${entry.entity} ${entry.from ? `${entry.from} → ` : ""}${entry.to}`,
              actor: entry.actor?.name ?? null,
              detail: entry.reason,
            },
          ),
        ),
        entries.length > TRACE_ROW_CAP || Boolean(timeline?.truncated),
      );
    } catch (err) {
      t.fail("booking", err);
    }
  }

  const caseArms = [
    ...(A ? [{ appointmentId: A }] : []),
    ...(A
      ? [
          {
            subjects: {
              some: { subjectType: "APPOINTMENT" as const, subjectId: A },
            },
          },
        ]
      : []),
    ...(hasPayments
      ? [
          {
            subjects: {
              some: { subjectType: "PAYMENT" as const, subjectId: { in: P } },
            },
          },
          { recommendations: { some: { paymentId: { in: P } } } },
        ]
      : []),
  ];
  const cases =
    caseArms.length > 0
      ? await t.read(
          "support",
          CASE_CAP,
          () =>
            prisma.supportCase.findMany({
              where: { deletedAt: null, OR: caseArms },
              orderBy: { createdAt: "desc" },
              take: CASE_CAP + 1,
              select: {
                id: true,
                referenceNumber: true,
                title: true,
                createdAt: true,
                requester: { select: { name: true } },
                events: {
                  select: {
                    id: true,
                    kind: true,
                    fromValue: true,
                    toValue: true,
                    createdAt: true,
                    actor: { select: { name: true } },
                  },
                  orderBy: { createdAt: "desc" },
                  take: CASE_EVENT_CAP + 1,
                },
                recommendations: {
                  where: { paymentId: { in: P } },
                  select: {
                    id: true,
                    amountPaise: true,
                    approved: true,
                    createdAt: true,
                    decidedAt: true,
                    voidedAt: true,
                    proposedBy: { select: { name: true } },
                    decidedBy: { select: { name: true } },
                  },
                  take: TRACE_ROW_CAP + 1,
                },
              },
              relationLoadStrategy: "join",
            }),
          (c) => {
            t.addCapped("support", c.events, CASE_EVENT_CAP, (events) =>
              events.flatMap((ev) =>
                makeRow("support", c.id, `event:${ev.id}`, ev.createdAt, {
                  status: `Case ${c.referenceNumber}: ${ev.kind}`,
                  actor: ev.actor?.name ?? null,
                  detail:
                    ev.fromValue || ev.toValue
                      ? `${ev.fromValue ?? "—"} → ${ev.toValue ?? "—"}`
                      : null,
                }),
              ),
            );
            t.addCapped("support", c.recommendations, TRACE_ROW_CAP, (recs) =>
              recs.flatMap((rec) => [
                ...makeRow("support", rec.id, "proposed", rec.createdAt, {
                  status: "Refund recommended",
                  amountPaise: rec.amountPaise,
                  currency: "INR",
                  actor: rec.proposedBy.name,
                  detail: `case ${c.referenceNumber}`,
                }),
                ...makeRow("support", rec.id, "decided", rec.decidedAt, {
                  status: rec.approved
                    ? "Recommendation approved"
                    : "Recommendation declined",
                  actor: rec.decidedBy?.name ?? null,
                }),
                ...makeRow("support", rec.id, "voided", rec.voidedAt, {
                  status: "Recommendation voided",
                }),
              ]),
            );
            return makeRow("support", c.id, "opened", c.createdAt, {
              status: `Case ${c.referenceNumber} opened`,
              actor: c.requester.name,
              detail: c.title,
            });
          },
        )
      : [];

  const caseIds = cases.map((c) => c.id);
  const recommendationIds = cases.flatMap((c) =>
    c.recommendations.slice(0, TRACE_ROW_CAP).map((r) => r.id),
  );
  const targets: { targetKind: string; ids: (string | null)[] }[] = [
    { targetKind: "Payment", ids: P },
    { targetKind: "Appointment", ids: [A] },
    { targetKind: "AppointmentOccurrence", ids: occurrenceIds },
    { targetKind: "Dispute", ids: disputeIds },
    { targetKind: "ConsultantPayout", ids: payoutIds },
    { targetKind: "OrganizationPayout", ids: orgPayoutIds },
    { targetKind: "SupportCase", ids: caseIds },
    { targetKind: "SupportFinancialRecommendation", ids: recommendationIds },
  ];
  const opsArms = targets
    .map(({ targetKind, ids }) => ({
      targetKind,
      targetId: { in: ids.filter((id): id is string => Boolean(id)) },
    }))
    .filter((arm) => arm.targetId.in.length > 0);
  if (opsArms.length > 0) {
    // Staff read only their own audit rows, as on the Audit log.
    const ownOnly =
      args.viewer.role === "ADMIN" ? {} : { actorUserId: args.viewer.userId };
    await t.read(
      "opsAction",
      TRACE_ROW_CAP,
      () =>
        prisma.opsActionLog.findMany({
          where: { ...ownOnly, OR: opsArms },
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true,
            action: true,
            targetKind: true,
            targetId: true,
            reason: true,
            actorRole: true,
            createdAt: true,
            actor: { select: { name: true } },
          },
          relationLoadStrategy: "join",
        }),
      (o) =>
        makeRow("opsAction", o.targetId, `ops:${o.id}`, o.createdAt, {
          status: `Console: ${o.action}`,
          actor: o.actor?.name ?? o.actorRole,
          detail: join([`${o.targetKind}`, o.reason]),
        }),
    );
  }

  if (args.viewer.seesSystemEvents) {
    const correlationIds = [
      ...P,
      ...P.map((id) => `partial-credit:${id}`),
      ...payments.map((p) => p.paymentIntent),
      ...(A
        ? [
            `capture-cannot-seat:${A}`,
            `capture-unseated-seat:${A}`,
            `double-booking-blocked:${A}`,
          ]
        : []),
      ...caseIds.map((id) => `support-case:${id}`),
    ];
    if (correlationIds.length > 0) {
      await t.read(
        "systemEvent",
        TRACE_ROW_CAP,
        () =>
          prisma.systemEvent.findMany({
            where: { correlationId: { in: correlationIds } },
            orderBy: { createdAt: "desc" },
            take,
            select: {
              id: true,
              category: true,
              severity: true,
              message: true,
              correlationId: true,
              createdAt: true,
            },
          }),
        (ev) =>
          makeRow(
            "systemEvent",
            ev.correlationId ?? ev.id,
            `event:${ev.id}`,
            ev.createdAt,
            {
              status: `${ev.category} ${ev.severity}`,
              detail: ev.message.slice(0, 200),
            },
          ),
      );
    }
  }

  const userId = payments[0]?.userId ?? null;
  return {
    kind: args.kind,
    id: args.id,
    paymentIds: P,
    appointmentId: A,
    userId,
    sentryHref: sentrySearchHref(args.id),
    rows: mergeTimeline(t.rows),
    sources: t.sourceReports(),
  };
}

/** A user id resolves to their recent payments and bookings, one statement. */
export async function readTraceCandidates(
  userId: string,
): Promise<TraceCandidates | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      Payment: {
        orderBy: { createdAt: "desc" },
        take: TRACE_PAYMENT_CAP,
        select: {
          id: true,
          amount: true,
          currency: true,
          paymentStatus: true,
          createdAt: true,
        },
      },
      appointmentParticipations: {
        orderBy: { createdAt: "desc" },
        take: TRACE_PAYMENT_CAP,
        select: {
          role: true,
          appointment: {
            select: { id: true, appointmentType: true, createdAt: true },
          },
        },
      },
    },
    relationLoadStrategy: "join",
  });
  if (!user) return null;
  return {
    userId: user.id,
    name: user.name,
    payments: user.Payment.map((p) => ({
      id: p.id,
      amountPaise: Number(p.amount),
      currency: p.currency,
      status: p.paymentStatus,
      createdAt: p.createdAt.toISOString(),
    })),
    appointments: user.appointmentParticipations.map((a) => ({
      id: a.appointment.id,
      type: a.appointment.appointmentType,
      role: a.role,
      createdAt: a.appointment.createdAt.toISOString(),
    })),
  };
}
