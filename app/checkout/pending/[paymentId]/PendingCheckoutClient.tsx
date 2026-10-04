"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { payPagePath } from "@/lib/payments/pay-link-href";
import type { PendingCheckout } from "@/lib/data/pending-checkout";
import { formatCurrencyAmount } from "@/utils/formatting";

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

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const money = (paise: number) =>
    formatCurrencyAmount(paise, pending.currency);
  const lapsed =
    pending.status === "EXPIRED" ||
    pending.status === "FAILED" ||
    (expiresAtMs !== null && now !== null && now >= expiresAtMs);
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
      const data: { error?: string } | null = await response
        .json()
        .catch(() => null);
      setError(data?.error ?? "Could not cancel the booking. Try again.");
    } catch {
      setError("Could not cancel the booking. Try again.");
    } finally {
      setCancelling(false);
    }
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
