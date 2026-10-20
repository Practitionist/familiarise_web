"use client";

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lightbulb, Plus } from "lucide-react";
import { z } from "zod";
import { useSession } from "@/lib/auth-client";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { throwSupportError } from "@/lib/support/error-copy";

const FeedbackList = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    status: z.enum([
      "PENDING",
      "ACKNOWLEDGED",
      "IN_PROGRESS",
      "RESOLVED",
      "CLOSED",
    ]),
  }),
);
const STATUS_LABELS = {
  PENDING: "Received",
  ACKNOWLEDGED: "Acknowledged",
  IN_PROGRESS: "In progress",
  RESOLVED: "Completed",
  CLOSED: "Closed",
};

/** Product suggestions have their own history and form, separate from support conversations and session ratings. */
export function ProductFeedbackPage() {
  const { data: session } = useSession();
  const [compose, setCompose] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const qc = useQueryClient();
  const { toast } = useToast();
  const queryKey = ["product-feedback", session?.user.id];
  const query = useQuery({
    queryKey,
    refetchOnMount: "always",
    enabled: Boolean(session?.user.id),
    queryFn: async () => {
      const response = await fetch("/api/user/feedbacks");
      if (!response.ok) await throwSupportError(response, "feedback load");
      return FeedbackList.parse(await response.json());
    },
  });
  const submit = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/user/feedbacks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
        }),
      });
      if (!response.ok)
        await throwSupportError(response, "feedback submission");
    },
    onSuccess: () => {
      setTitle("");
      setDescription("");
      setCompose(false);
      void qc.invalidateQueries({ queryKey });
      toast({
        title: "Product feedback received",
        description: "Our team will review your suggestion.",
      });
    },
    onError: (error: unknown) =>
      toast({
        title: "Feedback was not submitted",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
  });
  let feedbackHistory: ReactNode;
  if (query.isLoading) {
    feedbackHistory = <Skeleton className="h-32 w-full" />;
  } else if (query.isError) {
    feedbackHistory = (
      <ErrorState
        title="Couldn't load your product feedback"
        onRetry={() => void query.refetch()}
      />
    );
  } else if (query.data?.length === 0) {
    feedbackHistory = (
      <EmptyState
        icon={Lightbulb}
        title="No product feedback yet"
        description="Your suggestions and their review status will appear here."
      />
    );
  } else {
    feedbackHistory = (
      <ul className="divide-y divide-border">
        {query.data?.map((feedback) => (
          <li className="space-y-2 py-4" key={feedback.id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h2 className="text-sm font-medium">{feedback.title}</h2>
              <StatusBadge
                label={STATUS_LABELS[feedback.status]}
                tone="neutral"
                size="sm"
              />
            </div>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {feedback.description}
            </p>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <>
      <PageHeader
        title="Product feedback"
        description="Ideas and suggestions to improve Familiarise. For help with a booking or account, open Support requests."
        actions={
          !compose ? (
            <Button onClick={() => setCompose(true)}>
              <Plus className="mr-2 h-4 w-4" aria-hidden />
              Suggest an improvement
            </Button>
          ) : undefined
        }
      />
      {compose && (
        <form
          className="mb-6 max-w-2xl space-y-4 rounded-lg border border-border p-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!submit.isPending && title.trim() && description.trim())
              submit.mutate();
          }}
        >
          <h2 className="text-base font-semibold">Suggest an improvement</h2>
          <div className="space-y-2">
            <Label htmlFor="product-feedback-title">Title</Label>
            <Input
              id="product-feedback-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              required
              disabled={submit.isPending}
              placeholder="What could work better?"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="product-feedback-description">Details</Label>
            <Textarea
              id="product-feedback-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={2000}
              required
              disabled={submit.isPending}
              placeholder="Describe your idea and how it would help."
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                submit.isPending || !title.trim() || !description.trim()
              }
            >
              {submit.isPending ? "Submitting…" : "Submit feedback"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={submit.isPending}
              onClick={() => setCompose(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {feedbackHistory}
    </>
  );
}
