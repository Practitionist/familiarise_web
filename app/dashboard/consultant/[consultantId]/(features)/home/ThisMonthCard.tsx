"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Copy, ExternalLink, Share2 } from "lucide-react";

import { Section } from "@/components/dashboard/Section";
import { Stat, StatRow } from "@/components/dashboard/Stat";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrencyAmount } from "@/utils/formatting";
import { useExpertShareHref } from "@/hooks/useExpertShareHref";

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

export function ThisMonthCard({
  consultantId,
  sessionsThisMonth,
  sessionsDelivered,
  availablePaise,
  averageRating,
  totalReviews,
  publishedRatingOneToOne,
  publishedRatingGroup,
  ratedClientsOneToOne,
  ratedEventsGroup,
}: Readonly<{
  consultantId: string;
  sessionsThisMonth: number | null;
  sessionsDelivered: number | null;
  availablePaise: number;
  averageRating: number;
  totalReviews: number;
  publishedRatingOneToOne?: number | null;
  publishedRatingGroup?: number | null;
  ratedClientsOneToOne?: number;
  ratedEventsGroup?: number;
}>) {
  const base = `/dashboard/consultant/${consultantId}`;
  const shareHref = useExpertShareHref(consultantId);
  const [shareOpen, setShareOpen] = useState(false);
  const [copiedPost, setCopiedPost] = useState(false);

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
  const milestonePostText = reachedMilestone
    ? `I just crossed ${reachedMilestone} ${reachedMilestone === 1 ? "delivered session" : "delivered sessions"} mentoring on Familiarise! Book a 1:1 session or join an upcoming cohort with me: ${fullShareUrl}`
    : "";

  const copyMilestonePost = async () => {
    try {
      await navigator.clipboard.writeText(milestonePostText);
      setCopiedPost(true);
      setTimeout(() => setCopiedPost(false), 2000);
    } catch {
      setCopiedPost(false);
    }
  };

  const oneToOneScore =
    publishedRatingOneToOne !== undefined
      ? publishedRatingOneToOne !== null
        ? publishedRatingOneToOne.toFixed(1)
        : "—"
      : totalReviews > 0
        ? averageRating.toFixed(1)
        : "—";
  const oneToOneHint =
    publishedRatingOneToOne !== undefined
      ? publishedRatingOneToOne !== null && (ratedClientsOneToOne ?? 0) > 0
        ? `From ${ratedClientsOneToOne} ${ratedClientsOneToOne === 1 ? "learner" : "learners"}`
        : "1:1 consultations & plans"
      : totalReviews > 0
        ? `${totalReviews} ${totalReviews === 1 ? "review" : "reviews"}`
        : "No 1:1 reviews yet";

  const groupScore =
    publishedRatingGroup !== undefined && publishedRatingGroup !== null
      ? publishedRatingGroup.toFixed(1)
      : "—";
  const groupHint =
    publishedRatingGroup !== undefined &&
    publishedRatingGroup !== null &&
    (ratedEventsGroup ?? 0) > 0
      ? `From ${ratedEventsGroup} ${ratedEventsGroup === 1 ? "event" : "events"}`
      : "Webinars & classes";

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

      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share your milestone</DialogTitle>
            <DialogDescription>
              Bookings from your personal link pay half the platform fee (10% vs
              20% — you keep 90%) and lock that rate for repeat learners.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              readOnly
              value={milestonePostText}
              rows={4}
              aria-label="Milestone social post"
              className="text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => void copyMilestonePost()}
              >
                {copiedPost ? (
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                )}
                {copiedPost ? "Copied post" : "Copy post & link"}
              </Button>
              <Button type="button" size="sm" variant="outline" asChild>
                <a
                  href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(milestonePostText)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Share on X
                  <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                </a>
              </Button>
              <Button type="button" size="sm" variant="outline" asChild>
                <a
                  href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(fullShareUrl)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Share on LinkedIn
                  <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                </a>
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShareOpen(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
      description="Bookings from your personal link pay half the platform fee (10% vs 20% — you keep 90%) and lock that lower rate for repeat bookings. Add your link to your bio, emails, and posts."
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
