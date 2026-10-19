"use client";

import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { describeSupportError } from "@/lib/support/error-copy";
import React from "react";
import { createConsulteeQueries } from "@/lib/dashboard-queries";

interface FeedbackFormData {
  title: string;
  description: string;
  rating?: number;
  category?: string;
}

const FeedbackList = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    rating: z.number().nullable(),
    status: z.enum([
      "PENDING",
      "ACKNOWLEDGED",
      "IN_PROGRESS",
      "RESOLVED",
      "CLOSED",
    ]),
  }),
);

export function useFeedbackSupport(scopeId: string) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = React.useState(false);
  const consulteeQueries = createConsulteeQueries(scopeId);
  const { data: feedbacksData } = useQuery(consulteeQueries.feedback);
  const feedbacks = FeedbackList.parse(feedbacksData ?? []);

  const invalidateFeedbacks = () =>
    queryClient.invalidateQueries({
      queryKey: consulteeQueries.feedback.queryKey,
    });
  const [feedbackForm, setFeedbackForm] = React.useState<FeedbackFormData>({
    title: "",
    description: "",
  });

  const handleFeedbackSubmit = async () => {
    try {
      setIsLoading(true);
      const response = await fetch("/api/user/feedbacks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(feedbackForm),
      });

      if (!response.ok) {
        // Envelope-aware: prefer the coded copy, fall back to the server's
        // user-safe `error` (the old `errorData.message` field never existed).
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          describeSupportError(payload, "Failed to submit your feedback"),
        );
      }

      toast({
        title: "Feedback submitted",
        description:
          "Thank you for your feedback! Our team will review it shortly.",
      });

      setFeedbackForm({ title: "", description: "" });
      void invalidateFeedbacks();
    } catch (error: unknown) {
      console.error("Failed to submit feedback:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Unable to submit your feedback. Please check your input and try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return {
    isLoading,
    feedbacks,
    feedbackForm,
    setFeedbackForm,
    handleFeedbackSubmit,
  };
}
