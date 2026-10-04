"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessageFromBody } from "@/lib/fetch-helpers";
import { payPagePath } from "@/lib/payments/pay-link-href";
import type { PendingCheckout } from "@/lib/data/pending-checkout";
import { formatCurrencyAmount } from "@/utils/formatting";

// The expiry sweep may lag the hold's clock; re-ask the server a bounded number of times.
const STATUS_CHECK_INTERVAL_MS = 15_000;
const MAX_STATUS_CHECKS = 8;

function remainingLabel(msLeft: number): string {
  const totalSeconds = Math.max(0, Math.floor(msLeft / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

function Row({
  label,
  value,
  strong,
}: Readonly<{ label: string; value: string; strong?: boolean }>) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={strong ? "font-semibold text-foreground" : "text-foreground"}
      >
        {value}
      </span>
    </div>
  );
}

export function PendingCheckoutClient({
  pending,
}: Readonly<{ pending: PendingCheckout }>) {
  const router = useRouter();
  const expiresAtMs = pending.expiresAt
    ? new Date(pending.expiresAt).getTime()
    : null;
  const [now, setNow] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState(0);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const money = (paise: number) =>
    formatCurrencyAmount(paise, pending.currency);
  const lapsed = pending.status === "EXPIRED" || pending.status === "FAILED";
  // The timer only says the window ended; the server decides what happened.
  const checking =
    !lapsed && expiresAtMs !== null && now !== null && now >= expiresAtMs;
  const checksExhausted = checks >= MAX_STATUS_CHECKS;
  useEffect(() => {
    if (!checking || checksExhausted) return;
    const timer = setTimeout(
      () => {
        router.refresh();
        setChecks((n) => n + 1);
      },
      checks === 0 ? 0 : STATUS_CHECK_INTERVAL_MS,
    );
    return () => clearTimeout(timer);
  }, [checking, checks, checksExhausted, router]);

  const detailsHref = pending.consulteeProfileId
    ? `/dashboard/consultee/${pending.consulteeProfileId}/payments`
    : "/dashboard";

  async function cancelBooking() {
    if (!pending.appointmentId) return;
    setCancelling(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/bookings/${pending.appointmentId}/abandon`,
        { method: "POST" },
      );
      if (response.ok || response.status === 409) {
        router.push(detailsHref);
        router.refresh();
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      setError(
        errorMessageFromBody(body, "Could not cancel the booking. Try again."),
      );
    } catch {
      setError("Could not cancel the booking. Try again.");
    } finally {
      setCancelling(false);
    }
  }

  if (checking) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16">
        <Card>
          <CardHeader>
            <CardTitle>Checking your payment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <p className="text-sm text-muted-foreground">
              The payment window for {pending.planTitle} has ended.{" "}
              {checksExhausted
                ? "We could not confirm the result yet. Your payments page will show it once it settles."
                : "We are checking whether your payment landed."}
            </p>
            <Button asChild variant="outline" className="w-full">
              <Link href={detailsHref}>Go to your payments</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (lapsed) {
    const failed = pending.status === "FAILED";
    return (
      <main className="mx-auto max-w-xl px-4 py-16">
        <Card>
          <CardHeader>
            <CardTitle>
              {failed ? "Payment did not go through" : "Payment window closed"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <p className="text-sm text-muted-foreground">
              {failed
                ? `The payment for ${pending.planTitle} did not go through, and you have not been charged for it.`
                : `The payment window for ${pending.planTitle} has closed, so the hold on your booking was released.`}{" "}
              You can book again whenever you are ready.
            </p>
            <Button asChild className="w-full">
              <Link href="/explore">Book again</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>{pending.planTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2 rounded-xl border border-border bg-muted/50 p-4 text-sm">
            <Row label="Price" value={money(pending.basePaise)} />
            {pending.discountPaise > 0 && (
              <Row
                label={
                  pending.discountCode
                    ? `Discount (${pending.discountCode})`
                    : "Discount"
                }
                value={`−${money(pending.discountPaise)}`}
              />
            )}
            <Row label="GST" value={money(pending.taxPaise)} />
            {pending.creditsPaise > 0 && (
              <Row label="Credits" value={`−${money(pending.creditsPaise)}`} />
            )}
            <div className="border-t border-border pt-2">
              <Row label="Total" value={money(pending.totalPaise)} strong />
            </div>
          </div>
          {expiresAtMs !== null && now !== null && (
            <p className="text-center text-sm text-muted-foreground">
              Your hold expires in{" "}
              <span className="font-mono tabular-nums text-foreground">
                {remainingLabel(expiresAtMs - now)}
              </span>
            </p>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-2">
            <Button asChild className="w-full">
              <Link href={payPagePath(pending.paymentId)}>
                Complete payment
              </Link>
            </Button>
            {pending.appointmentId && (
              <Button
                variant="outline"
                className="w-full"
                disabled={cancelling}
                onClick={cancelBooking}
              >
                {cancelling ? "Cancelling…" : "Cancel"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
