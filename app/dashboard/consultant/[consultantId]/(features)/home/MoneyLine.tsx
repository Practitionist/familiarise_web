import { Section } from "@/components/dashboard/Section";

import { ArrowLink } from "./ArrowLink";

/** One line of money, and a second only when there is something true to add. */
export function MoneyLine({
  consultantId,
  moneyLine,
  sessionsThisMonth,
  ratingParts,
}: Readonly<{
  consultantId: string;
  moneyLine: string;
  sessionsThisMonth: number;
  ratingParts: readonly string[];
}>) {
  const base = `/dashboard/consultant/${consultantId}`;
  const facts = [
    ...(sessionsThisMonth > 0
      ? [
          `${sessionsThisMonth} ${sessionsThisMonth === 1 ? "session" : "sessions"} this month`,
        ]
      : []),
    ...ratingParts,
  ];
  return (
    <Section title="Money">
      <p className="flex flex-wrap items-center gap-x-2 text-sm text-foreground">
        <span>{moneyLine} ·</span>
        <ArrowLink href={`${base}/earnings`}>Earnings</ArrowLink>
      </p>
      {facts.length > 0 && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          <span>{facts.join(" · ")}</span>
          {ratingParts.length > 0 && (
            <ArrowLink href={`${base}/reviews`}>Reviews</ArrowLink>
          )}
        </p>
      )}
    </Section>
  );
}
