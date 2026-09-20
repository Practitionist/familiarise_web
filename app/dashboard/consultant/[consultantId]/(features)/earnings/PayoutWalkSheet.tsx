"use client";

import { formatInTimeZone } from "date-fns-tz";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { formatCurrencyAmount } from "@/utils/formatting";
import {
  PAYOUT_ZONE,
  derivePayoutPresentation,
  moneyWalk,
  type PayoutRowInput,
} from "@/lib/dashboard/earnings-state";

/**
 * #1675 PR-Y — the money walk behind one payout: your share → TDS at the
 * stamped rate (s.194-O) → what reached the bank, with the UTR and the date.
 * `ConsultantPayout` was never read by a consultant route before this page, so
 * the withholding was invisible to the person it was withheld from.
 */

type WalkPayout = PayoutRowInput & { tdsFinancialYear?: string | null };

const inr = (paise: number) => formatCurrencyAmount(paise, "INR");
// Number(...).toString() drops trailing zeros ("0.10" → "0.1", "20.00" → "20").
const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

export function PayoutWalkBody({ payout }: Readonly<{ payout: WalkPayout }>) {
  const walk = moneyWalk(payout);
  const at = payout.processedAt ?? payout.createdAt;
  return (
    <dl className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <dt className="text-muted-foreground">Your share</dt>
        <dd className="font-medium text-foreground">{inr(walk.share)}</dd>
      </div>
      <div className="flex items-center justify-between">
        <dt className="text-muted-foreground">
          TDS @ {pct(walk.tdsRateBps)} (s.194-O)
          {payout.tdsFinancialYear ? ` · FY ${payout.tdsFinancialYear}` : ""}
        </dt>
        <dd className="font-medium text-foreground">−{inr(walk.tds)}</dd>
      </div>
      <div className="flex items-center justify-between border-t border-border pt-3">
        <dt className="font-medium text-foreground">Paid to you</dt>
        <dd className="text-base font-semibold text-foreground">
          {inr(walk.net)}
        </dd>
      </div>
      <div className="flex items-center justify-between">
        <dt className="text-muted-foreground">UTR</dt>
        <dd className="font-mono text-xs text-foreground">
          {payout.gatewayUtr ?? "—"}
        </dd>
      </div>
      <div className="flex items-center justify-between">
        <dt className="text-muted-foreground">Date</dt>
        <dd className="text-foreground">
          {formatInTimeZone(at, PAYOUT_ZONE, "d MMM yyyy")}
        </dd>
      </div>
    </dl>
  );
}

export function PayoutWalkSheet({ payout }: Readonly<{ payout: WalkPayout }>) {
  const pres = derivePayoutPresentation(payout);
  return (
    <Sheet>
      <SheetTrigger className="text-xs font-medium text-foreground underline underline-offset-4 hover:text-muted-foreground">
        Breakdown
      </SheetTrigger>
      <SheetContent className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Payout breakdown</SheetTitle>
          <SheetDescription>
            {pres.label} · {pres.line}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-6">
          <PayoutWalkBody payout={payout} />
        </div>
        <p className="mt-6 text-xs text-muted-foreground">
          TDS is withheld under Section 194-O and deposited against your PAN, so
          it appears in your annual tax statement for that financial year.
        </p>
      </SheetContent>
    </Sheet>
  );
}
