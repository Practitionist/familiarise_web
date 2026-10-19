/**
 * The bank-change guard on payout destinations: a new default account waits
 * out a cooling-off before mint pays it, the payee is emailed a freeze link,
 * and a freeze the payee placed carries over to whatever account becomes default.
 */

import { sendSecurityNoticeEmail } from "@/lib/email/senders/security";
import type { PrismaLike } from "@/lib/prisma";
import { getAppUrl } from "@/lib/url";
import { PAYOUT_ACCOUNT_COOLING_OFF_MS } from "./payout-requirements";

interface DefaultSwitchStamp {
  payoutsAllowedAfter?: Date;
  payoutsFrozenAt?: Date;
}

/**
 * Stamps for `accountId` becoming the consultant's default. The payee's first
 * account is exempt from cooling-off: there is no earlier destination to protect.
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
    (await db.consultantPayout.count({ where: { consultantProfileId } })) === 0;
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

export function consultantPayoutFreezeUrl(): string {
  return `${getAppUrl()}/api/consultant/payout-accounts/freeze`;
}

export function orgPayoutFreezeUrl(organizationId: string): string {
  return `${getAppUrl()}/api/organizations/${encodeURIComponent(organizationId)}/payout-account/freeze`;
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
