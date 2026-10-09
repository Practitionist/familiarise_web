"use client";

import { useState } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Flag, MessageSquareQuote, Share2, Star } from "lucide-react";
import { z } from "zod";

import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { DashboardContent } from "@/components/dashboard/PageScaffold";
import { Stat, StatRow } from "@/components/dashboard/Stat";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useExpertShareHref } from "@/hooks/useExpertShareHref";
import { useListParams } from "@/hooks/useListParams";
import type { OwnReviewRow, OwnReviewsPage } from "@/lib/reviews-inbox";
import { requireJsonResponse } from "@/lib/fetch-helpers";
import { cn } from "@/utils/tailwind";
import { SocialShareDialog } from "./SocialShareDialog";

function formatShareReviewerName(rawName: string | null | undefined): string {
  const trimmed = rawName?.trim();
  if (!trimmed || trimmed.includes("@")) return "a verified learner";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "a verified learner";
  if (parts.length === 1) return parts[0];
  const lastInitial = parts.at(-1)?.[0] ?? "";
  return `${parts[0]} ${lastInitial}.`;
}

const reviewsKey = (consultantId: string) => ["own-reviews", consultantId];

const OWN_REPORTS_KEY = ["own-reports"];
const reportReceiptSchema = z.object({ reportReference: z.string() });
const reportOutcomeSchema = z.enum([
  "PENDING_REVIEW",
  "NO_ACTION_TAKEN",
  "CONTENT_REMOVED",
  "EXCLUDED_FROM_AGGREGATE",
  "POLICY_ACTION_TAKEN",
]);
const OUTCOME_LABEL: Record<z.infer<typeof reportOutcomeSchema>, string> = {
  PENDING_REVIEW: "Under review",
  NO_ACTION_TAKEN: "Decided: no action needed",
  CONTENT_REMOVED: "Decided: content removed",
  EXCLUDED_FROM_AGGREGATE: "Decided: not counted in rating",
  POLICY_ACTION_TAKEN: "Decided: action taken",
};
const ownReportsSchema = z.object({
  reports: z.array(
    z.object({
      reportId: z.string(),
      reference: z.string(),
      createdAt: z.string(),
      outcome: reportOutcomeSchema,
    }),
  ),
});

/** The reviews this expert reported, newest first, with how each was decided. */
function YourReports() {
  const query = useQuery({
    queryKey: OWN_REPORTS_KEY,
    queryFn: async () =>
      ownReportsSchema.parse(
        await requireJsonResponse(
          await fetch("/api/user/reports?limit=20"),
          "Couldn't load your reports",
        ),
      ).reports,
  });
  if (query.isLoading) return <Skeleton className="h-24 rounded-xl" />;
  if (query.isError) {
    return (
      <ErrorState
        title="Couldn't load your reports"
        onRetry={() => void query.refetch()}
      />
    );
  }
  const reports = query.data ?? [];
  if (reports.length === 0) {
    return (
      <EmptyState
        icon={Flag}
        title="No reports yet"
        description="Reviews you report appear here with their outcome."
      />
    );
  }
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {reports.map((r) => (
        <li
          key={r.reportId}
          className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
        >
          <span className="font-medium text-foreground">{r.reference}</span>
          <span className="text-muted-foreground">
            {new Date(r.createdAt).toLocaleDateString()}
          </span>
          <StatusBadge
            label={OUTCOME_LABEL[r.outcome]}
            tone={r.outcome === "PENDING_REVIEW" ? "info" : "neutral"}
            size="sm"
          />
        </li>
      ))}
    </ul>
  );
}

async function fetchReviews(query: URLSearchParams): Promise<OwnReviewsPage> {
  const res = await fetch(`/api/consultant/reviews?${query.toString()}`, {
    cache: "no-store",
  });
  const body = (await requireJsonResponse(
    res,
    "Couldn't load your reviews",
  )) as { data: OwnReviewsPage };
  return body.data;
}

const RATING_OPTIONS = [5, 4, 3, 2, 1].map((n) => ({
  value: String(n),
  label: `${n}★`,
}));

const TRACK_OPTIONS = [
  { value: null, label: "All tracks" },
  { value: "ONE_TO_ONE", label: "1:1" },
  { value: "GROUP", label: "Group" },
] as const;

const REPORT_REASONS = [
  { value: "SPAM_OR_FAKE", label: "Spam or unverified claim" },
  { value: "HARASSMENT_OR_ABUSE", label: "Harassment or abusive language" },
  { value: "OFF_TOPIC", label: "Irrelevant or off-topic" },
  { value: "OTHER", label: "Other policy concern" },
] as const;

function Stars({ rating }: Readonly<{ rating: number }>) {
  return (
    <span
      className="inline-flex items-center gap-0.5"
      role="img"
      aria-label={`${rating} out of 5`}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          aria-hidden
          className={cn(
            "h-3.5 w-3.5",
            n <= rating
              ? "fill-foreground text-foreground"
              : "text-muted-foreground",
          )}
        />
      ))}
    </span>
  );
}

const onDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

function ScoreRow({
  summary,
}: Readonly<{ summary: NonNullable<OwnReviewsPage["summary"]> }>) {
  const score = (value: number | null) =>
    value === null ? "—" : value.toFixed(1);
  return (
    <StatRow columns={3}>
      <Stat
        label="1:1 rating"
        value={score(summary.publishedRatingOneToOne)}
        hint={
          summary.publishedRatingOneToOne === null
            ? "Shown once enough learners have rated you"
            : `From ${summary.ratedClientsOneToOne} learners`
        }
      />
      <Stat
        label="Group sessions rating"
        value={score(summary.publishedRatingGroup)}
        hint={
          summary.publishedRatingGroup === null
            ? "Shown once enough group sessions are rated"
            : `From ${summary.ratedEventsGroup} events`
        }
      />
      <Stat
        label="Needs reply"
        value={summary.needsReply}
        hint="Reviews without an answer from you"
      />
    </StatRow>
  );
}

function ReplyEditor({
  initial,
  saving,
  onSave,
  onCancel,
}: Readonly<{
  initial: string;
  saving: boolean;
  onSave: (body: string) => void;
  onCancel: () => void;
}>) {
  const [body, setBody] = useState(initial);
  return (
    <div className="mt-3 space-y-2">
      <Textarea
        aria-label="Your reply"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="Thank them, answer a concern, or add context. Replies are public."
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={saving || body.trim().length === 0}
          onClick={() => onSave(body.trim())}
        >
          {saving ? "Saving…" : "Post reply"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ReviewCard({
  review,
  consultantId,
  shareHref,
}: Readonly<{
  review: OwnReviewRow;
  consultantId: string;
  shareHref: string;
}>) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState<string>(
    REPORT_REASONS[0].value,
  );
  const [reportDetails, setReportDetails] = useState("");
  const [shareOpen, setShareOpen] = useState(false);

  const replyUrl = `/api/user/reviews/${review.id}/reply`;
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: reviewsKey(consultantId) });

  const save = useMutation({
    mutationFn: async (body: string) =>
      requireJsonResponse(
        await fetch(replyUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        }),
        "Couldn't post your reply",
      ),
    onSuccess: () => {
      setEditing(false);
      toast({ title: "Reply posted" });
      void refresh();
    },
    onError: (error: Error) =>
      toast({
        title: "Couldn't post your reply",
        description: error.message,
        variant: "destructive",
      }),
  });

  const reportMutation = useMutation({
    mutationFn: async () =>
      requireJsonResponse(
        await fetch("/api/report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "REVIEW",
            reviewId: review.id,
            reason: reportReason,
            description: reportDetails.trim() || undefined,
          }),
        }),
        "Couldn't submit report",
      ),
    onSuccess: (data) => {
      setReportOpen(false);
      setReportReason(REPORT_REASONS[0].value);
      setReportDetails("");
      const reference = reportReceiptSchema.safeParse(data);
      toast({
        title: reference.success
          ? `Report ${reference.data.reportReference} received`
          : "Report received",
        description: "We will tell you here and by email when it is decided.",
      });
      void queryClient.invalidateQueries({ queryKey: OWN_REPORTS_KEY });
    },
    onError: (error: Error) =>
      toast({
        title: "Couldn't submit report",
        description: error.message,
        variant: "destructive",
      }),
  });

  const remove = async () => {
    await requireJsonResponse(
      await fetch(replyUrl, { method: "DELETE" }),
      "Couldn't delete your reply",
    );
    toast({ title: "Reply deleted" });
    await refresh();
  };

  const isEdited = review.editCount > 0;
  const fullShareUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${shareHref}`
      : shareHref;
  const displayReviewer = formatShareReviewerName(review.reviewer?.name);
  const shareText = review.body
    ? `"${review.body}" — ${displayReviewer} (${review.rating}★)\n\nBook a session with me on Familiarise: ${fullShareUrl}`
    : `${review.rating}★ review from ${displayReviewer} on Familiarise!\n\nBook a session with me: ${fullShareUrl}`;

  return (
    <li className="px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Stars rating={review.rating} />
        <span className="text-sm font-medium text-foreground">
          {review.reviewer?.name ?? "Anonymous learner"}
        </span>
        {review.track && (
          <StatusBadge
            label={review.track === "GROUP" ? "Group session" : "1:1"}
            tone="neutral"
            size="sm"
          />
        )}
        {isEdited && <StatusBadge label="Edited" tone="neutral" size="sm" />}
        <span className="text-xs text-muted-foreground">
          {onDay(review.createdAt)}
        </span>
      </div>
      {review.offeringTitle && (
        <p className="mt-1 text-xs text-muted-foreground">
          {review.offeringTitle}
        </p>
      )}
      {review.body && (
        <p className="mt-2 whitespace-pre-line text-sm text-foreground">
          {review.body}
        </p>
      )}

      {review.reply && !editing && (
        <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-xs font-medium text-muted-foreground">
            Your reply
            {review.reply.repliedAt
              ? ` · ${onDay(review.reply.repliedAt)}`
              : ""}
          </p>
          <p className="mt-1 whitespace-pre-line text-sm text-foreground">
            {review.reply.body}
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
      {review.replyRemovedByModeration && (
        <p className="mt-3 text-sm text-muted-foreground">
          Your reply was removed by our moderation team. Contact support to
          reply again.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!review.reply && !review.replyRemovedByModeration && !editing && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Reply
          </Button>
        )}
        {!review.isOrgSponsored && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setShareOpen(true)}
            className="gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <Share2 className="h-3.5 w-3.5" aria-hidden />
            Share review
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setReportOpen(true)}
          className="gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <Flag className="h-3.5 w-3.5" aria-hidden />
          Report review
        </Button>
      </div>

      {editing && (
        <ReplyEditor
          initial={review.reply?.body ?? ""}
          saving={save.isPending}
          onSave={(body) => save.mutate(body)}
          onCancel={() => setEditing(false)}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete your reply?"
        description="It disappears from your public page. The review stays, and you can reply again."
        confirmLabel="Delete reply"
        tone="destructive"
        onConfirm={remove}
      />

      {!review.isOrgSponsored && (
        <SocialShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          title="Share this review"
          description="Includes your signed personal link (?via=) so buyers who first book through it use your personal-link platform fee rate."
          postText={shareText}
          shareUrl={fullShareUrl}
          textareaAriaLabel="Review share post"
          copyLabel="Copy quote & link"
          copiedLabel="Copied"
        />
      )}

      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Report this review</DialogTitle>
            <DialogDescription>
              Flag a review that violates community guidelines.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label
                htmlFor={`report-reason-${review.id}`}
                className="text-xs font-medium text-foreground"
              >
                Reason
              </label>
              <Select value={reportReason} onValueChange={setReportReason}>
                <SelectTrigger id={`report-reason-${review.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REPORT_REASONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor={`report-details-${review.id}`}
                className="text-xs font-medium text-foreground"
              >
                Additional context (optional)
              </label>
              <Textarea
                id={`report-details-${review.id}`}
                value={reportDetails}
                onChange={(e) => setReportDetails(e.target.value)}
                rows={3}
                placeholder="Share details for our moderation team..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setReportOpen(false)}
              disabled={reportMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => reportMutation.mutate()}
              disabled={reportMutation.isPending}
            >
              {reportMutation.isPending ? "Submitting…" : "Submit report"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

function ReviewList({
  consultantId,
  needsReply,
  rating,
  track,
  shareHref,
}: Readonly<{
  consultantId: string;
  needsReply: boolean;
  rating: string | null;
  track: string | null;
  shareHref: string;
}>) {
  const query = useInfiniteQuery({
    queryKey: [...reviewsKey(consultantId), { needsReply, rating, track }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set("cursor", pageParam);
      if (needsReply) params.set("needsReply", "1");
      if (rating) params.set("rating", rating);
      if (track) params.set("track", track);
      return fetchReviews(params);
    },
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });

  const emptyPlaceholder =
    query.isPlaceholderData &&
    !query.data?.pages.some((p) => p.rows.length > 0);
  // An empty placeholder is the previous filter's, not this one's empty state.
  if (query.isLoading || emptyPlaceholder) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        title="Couldn't load your reviews"
        onRetry={() => void query.refetch()}
      />
    );
  }
  const rows = query.data?.pages.flatMap((p) => p.rows) ?? [];
  if (rows.length === 0) {
    // A filtered-empty list is not the never-reviewed state.
    if ((rating || track) && !needsReply) {
      return (
        <EmptyState
          icon={MessageSquareQuote}
          title={rating ? `No ${rating}★ reviews` : "No matching reviews"}
          description="Try another rating or track, or clear the filters."
        />
      );
    }
    return (
      <EmptyState
        icon={MessageSquareQuote}
        title={needsReply ? "You're all caught up" : "No reviews yet"}
        description={
          needsReply
            ? "Every review has an answer from you."
            : "Learners can review a session once it has been held."
        }
      />
    );
  }
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {rows.map((review) => (
          <ReviewCard
            key={review.id}
            review={review}
            consultantId={consultantId}
            shareHref={shareHref}
          />
        ))}
      </ul>
      {query.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}

/** #1527 Q5 — All · Needs reply, rating + track filters, and the two scores. */
export function ReviewsInbox({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const list = useListParams({ filterKeys: ["rating", "track"] as const });
  const shareHref = useExpertShareHref(consultantId);
  const summary = useQuery({
    queryKey: [...reviewsKey(consultantId), "summary"],
    queryFn: () => fetchReviews(new URLSearchParams({ limit: "1" })),
    select: (page) => page.summary,
  });
  const rating = list.filters.rating;
  const track = list.filters.track;

  return (
    <DashboardContent>
      {summary.data && <ScoreRow summary={summary.data} />}
      <FilterBar
        chips={{
          label: "Rating",
          options: RATING_OPTIONS,
          value: rating,
          onChange: (value) => list.setFilter("rating", value),
          clearable: true,
        }}
        canClear={Boolean(rating || track)}
        onClear={list.clear}
      >
        <fieldset className="inline-flex rounded-lg border-0 bg-muted p-1">
          <legend className="sr-only">Track</legend>
          {TRACK_OPTIONS.map((opt) => {
            const pressed = (track ?? null) === opt.value;
            return (
              <button
                key={opt.label}
                type="button"
                aria-pressed={pressed}
                onClick={() => list.setFilter("track", opt.value)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  pressed
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </fieldset>
      </FilterBar>
      <UrlTabs
        tabs={[
          {
            value: "all",
            label: "All",
            content: (
              <ReviewList
                consultantId={consultantId}
                needsReply={false}
                rating={rating}
                track={track}
                shareHref={shareHref}
              />
            ),
          },
          {
            value: "needs-reply",
            label: "Needs reply",
            content: (
              <ReviewList
                consultantId={consultantId}
                needsReply
                rating={rating}
                track={track}
                shareHref={shareHref}
              />
            ),
          },
          {
            value: "your-reports",
            label: "Your reports",
            content: <YourReports />,
          },
        ]}
      />
    </DashboardContent>
  );
}
