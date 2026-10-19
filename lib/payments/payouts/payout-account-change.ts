/**
 * The bank-change guard on payout destinations: a new default account waits
 * out a cooling-off before mint pays it, the payee is emailed a freeze link,
 * and a freeze the payee placed carries over to whatever account becomes default.
 */

import { sendSecurityNoticeEmail } from "@/lib/email/senders/security";
import type { PrismaLike } from "@/lib/prisma";
import { getAppUrl } from "@/lib/url";
import { EarningStatus } from "@prisma/client";
import { PAYOUT_ACCOUNT_COOLING_OFF_MS } from "./payout-requirements";

/** Earnings the payee is still owed: a new destination for them needs the cooling-off. */
const ACCRUED_EARNING_STATUSES: EarningStatus[] = [
  EarningStatus.PENDING,
  EarningStatus.PENDING_TRUST,
  EarningStatus.HELD,
  EarningStatus.READY,
];

interface DefaultSwitchStamp {
  payoutsAllowedAfter?: Date;
  payoutsFrozenAt?: Date;
}

/**
 * Stamps for `accountId` becoming the consultant's default. Only a payee's first
 * account, added before any money accrued, skips cooling-off: nothing is at risk yet.
 */
export async function consultantDefaultSwitchStamp(
  db: PrismaLike,
  consultantProfileId: string,
  accountId: string | null,
  now: Date = new Date(),
): Promise<DefaultSwitchStamp> {
  const others = await db.payoutAccount.findMany({
    where: {
      consultantProfileId,
      ...(accountId ? { id: { not: accountId } } : {}),
    },
    select: { payoutsFrozenAt: true },
  });
  const firstEver =
    others.length === 0 &&
    (await db.consultantPayout.count({ where: { consultantProfileId } })) ===
      0 &&
    (await db.consultantEarnings.count({
      where: { consultantProfileId, status: { in: ACCRUED_EARNING_STATUSES } },
    })) === 0;
  const frozenAt = others.find((o) => o.payoutsFrozenAt)?.payoutsFrozenAt;
  return {
    ...(firstEver
      ? {}
      : {
          payoutsAllowedAfter: new Date(
            now.getTime() + PAYOUT_ACCOUNT_COOLING_OFF_MS,
          ),
        }),
    ...(frozenAt ? { payoutsFrozenAt: frozenAt } : {}),
  };
}

/** True when an org adding its first payout account already has money accruing. */
export async function orgHasAccruedEarnings(
  db: PrismaLike,
  organizationId: string,
): Promise<boolean> {
  const accrued = await db.organizationEarnings.count({
    where: { organizationId, status: { in: ACCRUED_EARNING_STATUSES } },
  });
  return accrued > 0;
}

/** The email link opens a confirm page; only its same-origin POST freezes. */
export function consultantPayoutFreezeUrl(): string {
  return `${getAppUrl()}/dashboard/payouts/freeze`;
}

export function orgPayoutFreezeUrl(organizationId: string): string {
  return `${getAppUrl()}/dashboard/payouts/freeze?org=${encodeURIComponent(organizationId)}`;
}

/** The one change notice per payee recipient; the sender never throws. */
export async function emailPayoutAccountChanged(
  userIds: string[],
  freezeUrl: string,
): Promise<void> {
  const occurredAt = new Date();
  for (const userId of userIds) {
    await sendSecurityNoticeEmail({
      userId,
      event: { kind: "payout-account-changed", freezeUrl },
      occurredAt,
    });
  }
}
