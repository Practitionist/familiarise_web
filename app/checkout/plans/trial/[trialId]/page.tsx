import { AlertCircle, CalendarClock, Clock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";

import { TrialPayButton } from "./TrialPayButton";

/**
 * Branded checkout page for a paid trial.
 *
 * NOT YET LINKED. `TrialSession.pendingPaymentUrl` still points at the Razorpay
 * hosted pay-link, which is what the approval email and every dashboard
 * affordance open. This page exists so switching to our own surface later is a
 * one-line change (point pendingPaymentUrl here) rather than a fresh build.
 *
 * It deliberately does NOT create a payment intent. Unlike the four
 * direct-purchase checkout families, a trial's intent already exists — it was
 * minted when the consultant accepted. Re-creating one here would double-charge
 * and would trip the duplicate-payment guard in createApprovalPaymentIntent.
 * This page's job is to authorise the viewer, prove the trial is still payable,
 * and hand off to the gateway.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Complete your trial booking | Familiarise",
  robots: { index: false, follow: false },
};

export default async function TrialCheckoutPage({
  params,
}: {
  params: Promise<{ trialId: string }>;
}) {
  const { trialId } = await params;
  const session = await getSession(true);

  if (!session?.user?.id) notFound();

  const trial = await prisma.trialSession.findUnique({
    where: { id: trialId },
    select: {
      id: true,
      status: true,
      paymentDueAt: true,
      pendingPaymentUrl: true,
      consulteeProfile: { select: { userId: true } },
      subscriptionPlan: {
        select: {
          title: true,
          trialPriceInPaise: true,
          trialDurationMinutes: true,
          priceCurrency: true,
          consultantProfile: {
            select: { user: { select: { name: true } } },
          },
        },
      },
      appointment: {
        select: {
          slotsOfAppointment: {
            select: { startsAt: true },
            orderBy: { startsAt: "asc" },
            take: 1,
          },
        },
      },
    },
  });

  // 404 rather than 403 for someone else's trial — an existence oracle on a
  // guessable id would leak who is trialling whom.
  if (!trial || trial.consulteeProfile.userId !== session.user.id) notFound();

  const startsAt = trial.appointment?.slotsOfAppointment[0]?.startsAt ?? null;
  const isPayable =
    trial.status === "AWAITING_PAYMENT" &&
    Boolean(trial.pendingPaymentUrl) &&
    (!trial.paymentDueAt || trial.paymentDueAt > new Date());

  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>
            {isPayable ? "Complete your trial booking" : "Trial unavailable"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <p className="text-lg font-semibold text-foreground">
              {trial.subscriptionPlan.title} — trial
            </p>
            <p className="text-sm text-muted-foreground">
              with{" "}
              {trial.subscriptionPlan.consultantProfile?.user?.name ??
                "your expert"}
            </p>
          </div>

          <div className="space-y-2 rounded-xl border border-border bg-muted/50 p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Amount</span>
              <span className="font-semibold text-foreground">
                {new Intl.NumberFormat("en-IN", {
                  style: "currency",
                  currency: trial.subscriptionPlan.priceCurrency,
                  maximumFractionDigits: 0,
                }).format(Number(trial.subscriptionPlan.trialPriceInPaise) / 100)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                Duration
              </span>
              <span className="text-foreground">
                {trial.subscriptionPlan.trialDurationMinutes} minutes
              </span>
            </div>
            {startsAt && (
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <CalendarClock className="h-3.5 w-3.5" />
                  Session
                </span>
                <span className="text-foreground">
                  {startsAt.toLocaleString("en-IN", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              </div>
            )}
          </div>

          {isPayable ? (
            <>
              <TrialPayButton paymentUrl={trial.pendingPaymentUrl!} />
              {trial.paymentDueAt && (
                <p className="text-center text-xs text-muted-foreground">
                  Your slot is held until{" "}
                  {trial.paymentDueAt.toLocaleString("en-IN", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                  . After that it is released to other learners.
                </p>
              )}
            </>
          ) : (
            <div className="space-y-4">
              <div className="flex gap-3 rounded-xl border border-border bg-muted/50 p-4">
                <AlertCircle className="h-5 w-5 shrink-0 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {trial.status === "SCHEDULED"
                    ? "This trial is already paid for and confirmed."
                    : "This trial is no longer awaiting payment — it may have been cancelled, or the payment window may have closed. You can request a new trial with this expert."}
                </p>
              </div>
              <Button asChild variant="outline" className="w-full">
                <Link href="/dashboard">Go to dashboard</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
