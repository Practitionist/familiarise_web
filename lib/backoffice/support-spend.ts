/**
 * Per-operator support spend, read from the ops-log rows the bounded refund
 * and hold doors write. A STAFF viewer gets only their own row; an ADMIN
 * viewer gets every operator. The daily limit is read on the trailing-24-hour
 * basis the doors enforce; the IST calendar day is shown beside it.
 */

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { istDayStart } from "@/lib/compliance/ist-period";
import {
  BOUNDED_REFUND_ACTIONS,
  committedSupportPaiseByPayment,
  movedPaiseOf,
  STAFF_REFUND_ROLLING_WINDOW_MS,
} from "@/lib/support/money-policy";
import {
  STAFF_REFUND_PER_PAYMENT_PAISE,
  STAFF_REFUND_ROLLING_PAISE,
} from "@/lib/support/staff-refund-limits";
import type {
  SupportSpendOperator,
  SupportSpendPayment,
  SupportSpendReport,
} from "./support-spend-types";
import { resolveTargets, targetKey } from "./target-refs";

/** Operators per page; the window read covers only the page's operators. */
export const SUPPORT_SPEND_PAGE_SIZE = 10;

type BoundedRefundAction = (typeof BOUNDED_REFUND_ACTIONS)[number];

const SUPPORT_REFUND_ACTION: BoundedRefundAction = "support.refund.review";
const PLATFORM_CANCEL_ACTION: BoundedRefundAction =
  "appointment.cancel.platform";
const HOLD_APPLY_ACTION = "support.hold.apply";
const HOLD_RELEASE_ACTION = "support.hold.release";
const SUPPORT_SPEND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const SPEND_ACTIONS = [
  ...BOUNDED_REFUND_ACTIONS,
  HOLD_APPLY_ACTION,
  HOLD_RELEASE_ACTION,
];

const RefundReviewAfter = z.object({
  approved: z.literal(true),
  paymentId: z.string(),
});
const PlatformCancelAfter = z.object({
  paymentIds: z.array(z.string()),
  charges: z
    .array(
      z.object({
        paymentId: z.string(),
        newPaise: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});
const HoldAfter = z.object({
  paymentId: z.string(),
  replayed: z.boolean(),
  heldPaise: z.number().int().nonnegative().optional(),
});

interface SpendRow {
  actorUserId: string | null;
  action: string;
  after: Prisma.JsonValue | null;
  createdAt: Date;
}

interface PaymentUsage {
  platformCancelPaise: number;
  holdsApplied: number;
}

type OperatorTally = Omit<SupportSpendOperator, "payments" | "audit"> & {
  usage: Map<string, PaymentUsage>;
};

function usageFor(tally: OperatorTally, paymentId: string): PaymentUsage {
  let usage = tally.usage.get(paymentId);
  if (!usage) {
    usage = { platformCancelPaise: 0, holdsApplied: 0 };
    tally.usage.set(paymentId, usage);
  }
  return usage;
}

function tallyRefund(
  tally: OperatorTally,
  row: SpendRow,
  windows: { istDay: Date; rolling24h: Date },
) {
  const moved = movedPaiseOf(row.after);
  const refunds = tally.refunds;
  if (row.createdAt >= windows.rolling24h) refunds.rolling24hPaise += moved;
  if (row.createdAt >= windows.istDay) refunds.istDayPaise += moved;
  refunds.rolling30dPaise += moved;
  if (moved > 0) refunds.count30d += 1;
  if (row.action === SUPPORT_REFUND_ACTION) {
    const review = RefundReviewAfter.safeParse(row.after);
    if (review.success) usageFor(tally, review.data.paymentId);
    return;
  }
  refunds.platformCancel30dPaise += moved;
  const cancel = PlatformCancelAfter.safeParse(row.after);
  if (!cancel.success || moved === 0) return;
  if (cancel.data.charges) {
    for (const charge of cancel.data.charges)
      if (charge.newPaise > 0)
        usageFor(tally, charge.paymentId).platformCancelPaise +=
          charge.newPaise;
  } else if (cancel.data.paymentIds.length === 1) {
    usageFor(tally, cancel.data.paymentIds[0]).platformCancelPaise += moved;
  } else {
    refunds.platformCancelUnsplit30dPaise += moved;
  }
}

function tallyHold(tally: OperatorTally, row: SpendRow, istDay: Date) {
  const hold = HoldAfter.safeParse(row.after);
  if (!hold.success || hold.data.replayed) return;
  if (row.action === HOLD_RELEASE_ACTION) {
    tally.holds.released30d += 1;
    return;
  }
  tally.holds.applied30d += 1;
  if (row.createdAt >= istDay) tally.holds.appliedIstDay += 1;
  if (hold.data.heldPaise === undefined)
    tally.holds.appliedWithoutAmount30d += 1;
  else tally.holds.heldPaise30d += hold.data.heldPaise;
  usageFor(tally, hold.data.paymentId).holdsApplied += 1;
}

function emptyTally(user: {
  id: string;
  name: string;
  role: string;
}): OperatorTally {
  return {
    userId: user.id,
    name: user.name,
    role: user.role,
    capped: user.role === "STAFF",
    refunds: {
      istDayPaise: 0,
      rolling24hPaise: 0,
      rolling30dPaise: 0,
      count30d: 0,
      platformCancel30dPaise: 0,
      platformCancelUnsplit30dPaise: 0,
    },
    remainingDailyCapPaise: null,
    holds: {
      appliedIstDay: 0,
      applied30d: 0,
      released30d: 0,
      heldPaise30d: 0,
      appliedWithoutAmount30d: 0,
    },
    usage: new Map(),
  };
}

export async function readSupportSpend(args: {
  viewer: { userId: string; role: string };
  now: Date;
  page?: number;
}): Promise<SupportSpendReport> {
  const { viewer, now } = args;
  const page = Math.max(1, Math.floor(args.page ?? 1) || 1);
  const windows = {
    istDay: istDayStart(now),
    rolling24h: new Date(now.getTime() - STAFF_REFUND_ROLLING_WINDOW_MS),
    rolling30d: new Date(now.getTime() - SUPPORT_SPEND_WINDOW_MS),
  };
  const operatorWhere: Prisma.UserWhereInput =
    viewer.role === "ADMIN"
      ? { role: { in: ["ADMIN", "STAFF"] } }
      : { id: viewer.userId, role: "STAFF" };
  const users = await prisma.user.findMany({
    where: operatorWhere,
    select: { id: true, name: true, role: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    skip: (page - 1) * SUPPORT_SPEND_PAGE_SIZE,
    take: SUPPORT_SPEND_PAGE_SIZE,
  });
  const total = await prisma.user.count({ where: operatorWhere });
  const tallies = new Map(users.map((user) => [user.id, emptyTally(user)]));
  const rows: SpendRow[] = tallies.size
    ? await prisma.opsActionLog.findMany({
        where: {
          actorUserId: { in: [...tallies.keys()] },
          action: { in: SPEND_ACTIONS },
          createdAt: { gte: windows.rolling30d },
        },
        select: {
          actorUserId: true,
          action: true,
          after: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      })
    : [];
  for (const row of rows) {
    const tally = row.actorUserId ? tallies.get(row.actorUserId) : undefined;
    if (!tally) continue;
    if (row.action === HOLD_APPLY_ACTION || row.action === HOLD_RELEASE_ACTION)
      tallyHold(tally, row, windows.istDay);
    else tallyRefund(tally, row, windows);
  }
  const paymentIds = [
    ...new Set([...tallies.values()].flatMap((t) => [...t.usage.keys()])),
  ];
  const committed = await committedSupportPaiseByPayment(prisma, paymentIds);
  const targets = await resolveTargets(
    paymentIds.map((id) => ({ kind: "Payment", id })),
  );
  const operators = [...tallies.values()].map(
    ({ usage, ...tally }): SupportSpendOperator => {
      const payments = [...usage].map(
        ([paymentId, use]): SupportSpendPayment => {
          const supportCommittedPaise = committed.get(paymentId) ?? 0;
          return {
            paymentId,
            target: targets.get(targetKey("Payment", paymentId)) ?? null,
            supportCommittedPaise,
            platformCancelPaise: use.platformCancelPaise,
            remainingPerPaymentPaise: tally.capped
              ? Math.max(
                  0,
                  STAFF_REFUND_PER_PAYMENT_PAISE - supportCommittedPaise,
                )
              : null,
            holdsApplied: use.holdsApplied,
          };
        },
      );
      const audit = (action: string) => ({
        actorUserId: tally.userId,
        action,
        since: windows.rolling30d.toISOString(),
      });
      return {
        ...tally,
        audit: {
          supportRefunds: audit(SUPPORT_REFUND_ACTION),
          platformCancels: audit(PLATFORM_CANCEL_ACTION),
          holdsApplied: audit(HOLD_APPLY_ACTION),
        },
        remainingDailyCapPaise: tally.capped
          ? Math.max(
              0,
              STAFF_REFUND_ROLLING_PAISE - tally.refunds.rolling24hPaise,
            )
          : null,
        payments,
      };
    },
  );
  operators.sort(
    (a, b) =>
      b.refunds.rolling30dPaise - a.refunds.rolling30dPaise ||
      a.name.localeCompare(b.name),
  );
  return {
    operators,
    total,
    page,
    pageSize: SUPPORT_SPEND_PAGE_SIZE,
    windows: {
      istDayStart: windows.istDay.toISOString(),
      rolling24hStart: windows.rolling24h.toISOString(),
      rolling30dStart: windows.rolling30d.toISOString(),
    },
    caps: {
      perPaymentPaise: STAFF_REFUND_PER_PAYMENT_PAISE,
      rolling24hPaise: STAFF_REFUND_ROLLING_PAISE,
    },
    fetchedAt: now.toISOString(),
  };
}
