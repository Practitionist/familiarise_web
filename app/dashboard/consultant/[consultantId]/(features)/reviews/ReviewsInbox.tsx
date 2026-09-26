"use client";

import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { MessageSquareQuote, Star } from "lucide-react";

import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { DashboardContent } from "@/components/dashboard/PageScaffold";
import { Stat, StatRow } from "@/components/dashboard/Stat";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useListParams } from "@/hooks/useListParams";
import type {
  OwnReviewRow,
  OwnReviewsPage,
} from "@/lib/reviews-inbox";
import { requireJsonResponse } from "@/lib/fetch-helpers";
import { cn } from "@/utils/tailwind";

const reviewsKey = (consultantId: string) => ["own-reviews", consultantId];

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

/** #1300 — two published scores, 1:1 and group, never one blended number. */
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
            ? "Shown once enough clients have rated you"
            : `From ${summary.ratedClientsOneToOne} clients`
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
}: Readonly<{ review: OwnReviewRow; consultantId: string }>) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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

  const remove = async () => {
    await requireJsonResponse(
      await fetch(replyUrl, { method: "DELETE" }),
      "Couldn't delete your reply",
    );
    toast({ title: "Reply deleted" });
    await refresh();
  };

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
        <span className="text-xs text-muted-foreground">
          {onDay(review.createdAt)}
          {review.editedAt ? " · edited" : ""}
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
      {!review.reply && !review.replyRemovedByModeration && !editing && (
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          onClick={() => setEditing(true)}
        >
          Reply
        </Button>
      )}
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
    </li>
  );
}

function ReviewList({
  consultantId,
  needsReply,
  rating,
}: Readonly<{
  consultantId: string;
  needsReply: boolean;
  rating: string | null;
}>) {
  const query = useInfiniteQuery({
    queryKey: [...reviewsKey(consultantId), { needsReply, rating }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set("cursor", pageParam);
      if (needsReply) params.set("needsReply", "1");
      if (rating) params.set("rating", rating);
      return fetchReviews(params);
    },
    getNextPageParam: (last) => last.nextCursor,
  });

  if (query.isLoading) {
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

/** #1527 Q5 — All · Needs reply, a rating filter, and the two scores. */
export function ReviewsInbox({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const list = useListParams({ filterKeys: ["rating"] as const });
  const summary = useQuery({
    queryKey: [...reviewsKey(consultantId), "summary"],
    queryFn: () => fetchReviews(new URLSearchParams({ limit: "1" })),
    select: (page) => page.summary,
  });
  const rating = list.filters.rating;

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
        onClear={list.clear}
      />
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
              />
            ),
          },
        ]}
      />
    </DashboardContent>
  );
}
