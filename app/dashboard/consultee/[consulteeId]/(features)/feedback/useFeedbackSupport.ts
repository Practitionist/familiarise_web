"use client";

import {
  Feedback,
  SupportPriority,
  SupportTicket,
  SupportResponse as PrismaSupportResponse,
  UserRole,
} from "@prisma/client";
import { useToast } from "@/hooks/use-toast";
import React from "react";

interface FeedbackFormData {
  title: string;
  description: string;
  rating?: number;
  category?: string;
}

interface SupportTicketFormData {
  title: string;
  description: string;
  priority: SupportPriority;
  category?: string;
}

interface SupportResponseFormData {
  message: string;
}

interface EnrichedSupportTicketResponse extends PrismaSupportResponse {
  user: {
    name: string | null;
    role: UserRole | null;
  } | null;
}

interface SupportTicketWithResponses extends SupportTicket {
  responses: EnrichedSupportTicketResponse[];
}

export function useFeedbackSupport() {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<"feedback" | "support">(
    "feedback",
  );
  const [feedbacks, setFeedbacks] = React.useState<Feedback[]>([]);
  const [tickets, setTickets] = React.useState<SupportTicketWithResponses[]>(
    [],
  );
  const [selectedTicket, setSelectedTicket] = React.useState<string | null>(
    null,
  );

  const [feedbackForm, setFeedbackForm] = React.useState<FeedbackFormData>({
    title: "",
    description: "",
  });

  const [ticketForm, setTicketForm] = React.useState<SupportTicketFormData>({
    title: "",
    description: "",
    priority: SupportPriority.MEDIUM,
  });

  const [responseForm, setResponseForm] =
    React.useState<SupportResponseFormData>({
      message: "",
    });

  const loadFeedbacks = React.useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await fetch(`/api/user/feedbacks`);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.message || "Failed to fetch your feedback history",
        );
      }
      const data = await response.json();
      setFeedbacks(data);
    } catch (error: any) {
      console.error("Failed to load feedbacks:", error);
      toast({
        title: "Error",
        description:
          error.message ||
          "Unable to load your feedback history. Please try refreshing the page.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  const loadTickets = React.useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await fetch(`/api/user/support-tickets`);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.message || "Failed to fetch your support tickets",
        );
      }
      const data = await response.json();
      setTickets(data);
    } catch (error: any) {
      console.error("Failed to load support tickets:", error);
      toast({
        title: "Error",
        description:
          error.message ||
          "Unable to load your support tickets. Please try refreshing the page.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  React.useEffect(() => {
    loadFeedbacks();
    loadTickets();
  }, [loadFeedbacks, loadTickets]);

  const handleFeedbackSubmit = async () => {
    try {
      setIsLoading(true);
      const response = await fetch("/api/user/feedbacks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(feedbackForm),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to submit your feedback");
      }

      toast({
        title: "Success",
        description: "Feedback submitted successfully.",
      });

      setFeedbackForm({ title: "", description: "" });
      loadFeedbacks();
    } catch (error: any) {
      console.error("Failed to submit feedback:", error);
      toast({
        title: "Error",
        description:
          error.message ||
          "Unable to submit your feedback. Please check your input and try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleTicketSubmit = async () => {
    try {
      setIsLoading(true);
      const response = await fetch("/api/user/support-tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ticketForm),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.message || "Failed to create your support ticket",
        );
      }

      toast({
        title: "Success",
        description: "Support ticket created successfully.",
      });

      setTicketForm({
        title: "",
        description: "",
        priority: SupportPriority.MEDIUM,
      });
      loadTickets();
    } catch (error: any) {
      console.error("Failed to create support ticket:", error);
      toast({
        title: "Error",
        description:
          error.message ||
          "Unable to create your support ticket. Please check your input and try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleResponseSubmit = async (ticketId: string) => {
    try {
      setIsLoading(true);
      const response = await fetch(
        `/api/user/support-tickets/${ticketId}/responses`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(responseForm),
        },
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to submit your response");
      }

      toast({
        title: "Success",
        description: "Response submitted successfully.",
      });

      setResponseForm({ message: "" });
      loadTickets(); // Reload tickets to show the new response
    } catch (error: any) {
      console.error("Failed to submit response:", error);
      toast({
        title: "Error",
        description:
          error.message ||
          "Unable to submit your response. Please check your message and try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return {
    isLoading,
    activeTab,
    setActiveTab,
    feedbacks,
    tickets,
    selectedTicket,
    setSelectedTicket,
    feedbackForm,
    setFeedbackForm,
    ticketForm,
    setTicketForm,
    responseForm,
    setResponseForm,
    handleFeedbackSubmit,
    handleTicketSubmit,
    handleResponseSubmit,
  };
}
