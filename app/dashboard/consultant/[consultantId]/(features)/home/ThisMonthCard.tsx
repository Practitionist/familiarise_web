"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Copy, Share2 } from "lucide-react";

import { Section } from "@/components/dashboard/Section";
import { Stat, StatRow } from "@/components/dashboard/Stat";
import { Button } from "@/components/ui/button";
import { formatCurrencyAmount } from "@/utils/formatting";
import { useExpertShareHref } from "@/hooks/useExpertShareHref";
import { SocialShareDialog } from "../reviews/SocialShareDialog";

/** Round numbers worth a line of recognition; the next one ahead is shown. */
const MILESTONES = [1, 10, 25, 50, 100, 250, 500, 1000];

/** #1827 adapted — one motivating line, no milestone engine. */
export function milestoneLine(delivered: number): string | null {
  const reached = MILESTONES.findLast((m) => delivered >= m);
  const next = MILESTONES.find((m) => delivered < m);
  if (!reached) return next ? "Your first delivered session is ahead." : null;
  const done = `${reached} ${reached === 1 ? "session" : "sessions"} delivered`;
  return next ? `${done} · ${next - delivered} to ${next}` : done;
}

function formatTrackHint(
  score: number | null | undefined,
  count: number | undefined,
  singularNoun: string,
  pluralNoun: string,
  fallbackText: string,
): string {
  if (typeof score === "number" && (count ?? 0) > 0) {
    const noun = count === 1 ? singularNoun : pluralNoun;
    return `From ${count} ${noun}`;
  }
  return fallbackText;
}

export function ThisMonthCard({
  consultantId,
  sessionsThisMonth,
  sessionsDelivered,
  availablePaise,
  publishedRatingOneToOne,
  publishedRatingGroup,
  ratedClientsOneToOne,
  ratedEventsGroup,
}: Readonly<{
  consultantId: string;
  sessionsThisMonth: number | null;
  sessionsDelivered: number | null;
  availablePaise: number;
  publishedRatingOneToOne?: number | null;
  publishedRatingGroup?: number | null;
  ratedClientsOneToOne?: number;
  ratedEventsGroup?: number;
}>) {
  const base = `/dashboard/consultant/${consultantId}`;
  const shareHref = useExpertShareHref(consultantId);
  const [shareOpen, setShareOpen] = useState(false);

  const milestone =
    sessionsDelivered === null ? null : milestoneLine(sessionsDelivered);
  const reachedMilestone =
    sessionsDelivered === null
      ? undefined
      : MILESTONES.findLast((m) => sessionsDelivered >= m);

  const fullShareUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${shareHref}`
      : shareHref;
  const sessionWord =
    reachedMilestone === 1 ? "delivered session" : "delivered sessions";
  const milestonePostText = reachedMilestone
    ? `I just crossed ${reachedMilestone} ${sessionWord} mentoring on Familiarise! Book a 1:1 session or join an upcoming cohort with me: ${fullShareUrl}`
    : "";

  const oneToOneScore =
    typeof publishedRatingOneToOne === "number"
      ? publishedRatingOneToOne.toFixed(1)
      : "—";
  const oneToOneHint = formatTrackHint(
    publishedRatingOneToOne,
    ratedClientsOneToOne,
    "learner",
    "learners",
    "1:1 consultations & plans",
  );

  const groupScore =
    typeof publishedRatingGroup === "number"
      ? publishedRatingGroup.toFixed(1)
      : "—";
  const groupHint = formatTrackHint(
    publishedRatingGroup,
    ratedEventsGroup,
    "event",
    "events",
    "Webinars & classes",
  );

  return (
    <Section title="This month" variant="card">
      <StatRow columns={4}>
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
          label="1:1 rating"
          value={oneToOneScore}
          hint={oneToOneHint}
          href={`${base}/reviews`}
        />
        <Stat
          label="Group rating"
          value={groupScore}
          hint={groupHint}
          href={`${base}/reviews`}
        />
      </StatRow>
      {milestone && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">{milestone}</p>
          {reachedMilestone && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setShareOpen(true)}
              className="gap-1.5"
            >
              <Share2 className="h-3.5 w-3.5" aria-hidden />
              Share milestone
            </Button>
          )}
        </div>
      )}

      <SocialShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        title="Share your milestone"
        description="When a buyer first discovers and purchases from you via your shared link (?via=), their relationship with you stays on the reduced personal-link platform fee rate instead of the Marketplace rate."
        postText={milestonePostText}
        shareUrl={fullShareUrl}
        textareaAriaLabel="Milestone social post"
        copyLabel="Copy post & link"
        copiedLabel="Copied post"
      />
    </Section>
  );
}

/** The last Home block: people book from the public page, so make it one click to share. */
export function ShareProfilePrompt({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const [copied, setCopied] = useState(false);
  const href = `/explore/experts/${consultantId}`;
  const shareHref = useExpertShareHref(consultantId);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${shareHref}`,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Section
      title="Share your page"
      description="When a buyer first discovers and purchases from you through your shared link (?via=), their bookings with you use the personal-link platform fee rate instead of the Marketplace rate. Add your link to your bio, emails, and posts."
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
