"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Section } from "@/components/dashboard/Section";
import { Stat, StatRow } from "@/components/dashboard/Stat";
import { Button } from "@/components/ui/button";
import { formatCurrencyAmount } from "@/utils/formatting";

/** Round numbers worth a line of recognition; the next one ahead is shown. */
const MILESTONES = [1, 10, 25, 50, 100, 250, 500, 1000];

/** #1827 adapted — one motivating line, no milestone engine. */
export function milestoneLine(delivered: number): string | null {
  const reached = MILESTONES.filter((m) => delivered >= m).at(-1);
  const next = MILESTONES.find((m) => delivered < m);
  if (!reached) return next ? "Your first delivered session is ahead." : null;
  const done = `${reached} ${reached === 1 ? "session" : "sessions"} delivered`;
  return next ? `${done} · ${next - delivered} to ${next}` : done;
}

/**
 * #1527 §7.2 — Home's "This month": sessions, the Available balance (the
 * Earnings page's word for it) and the rating, then one milestone line.
 */
export function ThisMonthCard({
  consultantId,
  sessionsThisMonth,
  sessionsDelivered,
  availablePaise,
  averageRating,
  totalReviews,
}: Readonly<{
  consultantId: string;
  sessionsThisMonth: number | null;
  sessionsDelivered: number | null;
  availablePaise: number;
  averageRating: number;
  totalReviews: number;
}>) {
  const base = `/dashboard/consultant/${consultantId}`;
  const milestone =
    sessionsDelivered === null ? null : milestoneLine(sessionsDelivered);
  return (
    <Section title="This month" variant="card">
      <StatRow columns={3}>
        <Stat
          label="Sessions"
          value={sessionsThisMonth ?? "—"}
          hint="Delivered since the 1st"
          href={`${base}/appointments?tab=past`}
        />
        <Stat
          label="Available"
          value={formatCurrencyAmount(availablePaise, "INR")}
          hint="Ready for your next payout"
          href={`${base}/earnings`}
        />
        <Stat
          label="Rating"
          value={totalReviews > 0 ? averageRating.toFixed(1) : "—"}
          hint={
            totalReviews > 0
              ? `${totalReviews} ${totalReviews === 1 ? "review" : "reviews"}`
              : "No reviews yet"
          }
          href={`${base}/reviews`}
        />
      </StatRow>
      {milestone && (
        <p className="mt-3 text-sm text-muted-foreground">{milestone}</p>
      )}
    </Section>
  );
}

/** The last Home block: people book from the public page, so make it one click to share. */
export function ShareProfilePrompt({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const [copied, setCopied] = useState(false);
  const href = `/explore/experts/${consultantId}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${href}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Section
      title="Share your page"
      description="Most bookings start on your public page. Add the link to your bio, emails and posts."
      variant="card"
    >
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => void copy()}>
          {copied ? (
            <Check className="mr-1.5 h-3.5 w-3.5" />
          ) : (
            <Copy className="mr-1.5 h-3.5 w-3.5" />
          )}
          {copied ? "Copied" : "Copy link"}
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link href={href}>Open</Link>
        </Button>
      </div>
    </Section>
  );
}
