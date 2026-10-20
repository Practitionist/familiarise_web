/**
 * #777 §C — WALLET low-balance cron. NOTIFY-ONLY floor.
 *
 * Candidates: WALLET BillingAccounts with a configured minBalancePaise whose
 * live walletBalance has dipped below it, that haven't fired in the last 24h.
 * `autoTopUpLastFiredAt` doubles as the notify cooldown — one alert per
 * account per day, claimed via a conditional updateMany so two cron replicas
 * (or a same-day re-run) can't double-notify.
 *
 * There is NO money movement here and NO WalletTopUp row is created: it
 * detects, tells finance, and stamps the cooldown.
 *
 * Schedule: the ticker's daily window from 23:30 UTC, on a slot after dunning.
 */

import prisma from "@/lib/prisma";
import {
  notifyOrgWalletLow,
  rosterForOrg,
  VISIBILITY_ROLES,
} from "@/lib/novu/org-workflows";
import { sendOrgWalletLowEmail } from "@/lib/email";
import { getAppUrl } from "@/lib/url";
import { withCronLock } from "@/lib/cron/with-cron-lock";

const COOLDOWN_MS = 24 * 60 * 60 * 1000;

interface WalletLowStats {
  scanned: number;
  notified: number;
}

export async function runWalletLowBalance(opts: {
  limit?: number;
}): Promise<WalletLowStats> {
  return withCronLock("wallet-low-balance", { failMode: "open" }, () =>
    walletLowBalance(opts),
  );
}

/** `limit` caps the cooldown claims; an account above its floor is skipped in memory. */
async function walletLowBalance(opts: {
  limit?: number;
}): Promise<WalletLowStats> {
  const stats: WalletLowStats = { scanned: 0, notified: 0 };
  const now = new Date();
  const cooldownCutoff = new Date(now.getTime() - COOLDOWN_MS);

  // walletBalance < minBalancePaise can't be expressed as a column compare in
  // the Prisma filter, so we narrow on the cooldown + non-null floor here and
  // do the balance comparison in JS below.
  const candidates = await prisma.billingAccount.findMany({
    where: {
      fundingSource: "WALLET",
      minBalancePaise: { not: null },
      OR: [
        { autoTopUpLastFiredAt: null },
        { autoTopUpLastFiredAt: { lt: cooldownCutoff } },
      ],
    },
    select: {
      id: true,
      ownerOrgId: true,
      walletBalance: true,
      minBalancePaise: true,
      currency: true,
      autoTopUpLastFiredAt: true,
      organization: { select: { name: true } },
    },
  });

  for (const ba of candidates) {
    if (opts.limit !== undefined && stats.scanned >= opts.limit) break;
    const balance = ba.walletBalance ?? 0;
    const minimum = ba.minBalancePaise ?? 0;
    if (balance >= minimum) continue;
    stats.scanned += 1;

    // Claim the row by stamping the cooldown only if the value we read still
    // holds — the same gate doubles as the per-account 24h rate-limit. Loser
    // (concurrent replica / re-run) sees count 0 and skips the notify.
    const claim = await prisma.billingAccount.updateMany({
      where: { id: ba.id, autoTopUpLastFiredAt: ba.autoTopUpLastFiredAt },
      data: { autoTopUpLastFiredAt: now },
    });
    if (claim.count === 0) continue;

    stats.notified += 1;
    await notifyOrgWalletLow(ba.ownerOrgId, {
      orgName: ba.organization?.name ?? "",
      balancePaise: balance,
      minimumPaise: minimum,
      currency: ba.currency,
      topUpUrl: `${getAppUrl()}/dashboard/organization/${ba.ownerOrgId}/billing`,
    }).catch((err) =>
      console.error("[wallet-low-balance] notify failed:", err),
    );
    // #1653 — the email twin, to the roster the bell resolves. The roster
    // lookup is the one call here that can throw, and the loop must outlive it.
    const roster = await rosterForOrg(ba.ownerOrgId, VISIBILITY_ROLES).catch(
      (err): string[] => {
        console.error("[wallet-low-balance] roster lookup failed:", err);
        return [];
      },
    );
    await sendOrgWalletLowEmail({
      recipientUserIds: roster,
      organizationId: ba.ownerOrgId,
      orgName: ba.organization?.name ?? "",
      balancePaise: balance,
      minimumPaise: minimum,
      currency: ba.currency,
      topUpUrl: `${getAppUrl()}/dashboard/organization/${ba.ownerOrgId}/billing`,
    });
  }

  return stats;
}
