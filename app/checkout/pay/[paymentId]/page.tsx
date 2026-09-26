import { AlertCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSession } from "@/lib/auth-server";
import { resolvePayPage } from "@/lib/payments/pay-page";
import { formatCurrencyAmount } from "@/utils/formatting";

import { ViewerLocalTime } from "../../plans/trial/[trialId]/ViewerLocalTime";
import { PayExistingOrder } from "./PayExistingOrder";

/**
 * #1775 P-1 — the pay page for an order that already exists (an approval
 * pay-link or a paid trial). The Razorpay "link" is the order id, so this page
 * is where every Pay button and the pay-link email land.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Complete your payment | Familiarise",
  robots: { index: false, follow: false },
};

export default async function PayExistingOrderPage({
  params,
}: Readonly<{
  params: Promise<{ paymentId: string }>;
}>) {
  const { paymentId } = await params;
  const session = await getSession(true);
  if (!session?.user?.id) notFound();

  const state = await resolvePayPage(paymentId, session.user.id);
  if (state.kind === "not_found") notFound();
  if (state.kind === "paid" || state.kind === "redirect") redirect(state.href);

  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>
            {state.kind === "open"
              ? "Complete your payment"
              : "Payment unavailable"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {state.kind === "open" ? (
            <>
              {state.summary.description && (
                <p className="text-sm text-muted-foreground">
                  {state.summary.description}
                </p>
              )}
              <div className="space-y-2 rounded-xl border border-border bg-muted/50 p-4 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Price</span>
                  <span className="text-foreground">
                    {formatCurrencyAmount(
                      state.summary.originalAmount,
                      state.summary.currency,
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">GST</span>
                  <span className="text-foreground">
                    {formatCurrencyAmount(
                      state.summary.taxAmount,
                      state.summary.currency,
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t border-border pt-2">
                  <span className="text-muted-foreground">Total</span>
                  <span className="font-semibold text-foreground">
                    {formatCurrencyAmount(
                      state.summary.amount,
                      state.summary.currency,
                    )}
                  </span>
                </div>
              </div>
              <PayExistingOrder
                order={state.order}
                doneHref={state.doneHref}
                description={state.summary.description ?? "Booking payment"}
              />
              {state.summary.expiresAt && (
                <p className="text-center text-xs text-muted-foreground">
                  This payment link is open until{" "}
                  <ViewerLocalTime
                    value={state.summary.expiresAt.toISOString()}
                  />
                  .
                </p>
              )}
            </>
          ) : (
            <div className="space-y-4">
              <div className="flex gap-3 rounded-xl border border-border bg-muted/50 p-4">
                <AlertCircle className="h-5 w-5 shrink-0 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  This booking can no longer be paid for here. It may have been
                  cancelled, or its payment window may have closed. You can
                  request it again from the expert&apos;s page.
                </p>
              </div>
              <Button asChild variant="outline" className="w-full">
                <Link href={state.doneHref}>Go to your booking</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
