"use client";

import React from "react";
import { useToast } from "hooks/use-toast";
import {
  FeedbackStatus,
  SupportPriority,
  SupportTicketStatus,
} from "@prisma/client";

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

export function useFeedbackSupport() {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<"feedback" | "support">(
    "feedback",
  );
  const [feedbacks, setFeedbacks] = React.useState<any[]>([]);
  const [tickets, setTickets] = React.useState<any[]>([]);
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
        const error = await response.json();
        throw new Error(
          error.message || "Failed to fetch your feedback history",
        );
      }
      const data = await response.json();
      setFeedbacks(data);
    } catch (error) {
      toast({
        title: "Error",
        description:
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
        const error = await response.json();
        throw new Error(
          error.message || "Failed to fetch your support tickets",
        );
      }
      const data = await response.json();
      setTickets(data);
    } catch (error) {
      toast({
        title: "Error",
        description:
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
        const error = await response.json();
        throw new Error(error.message || "Failed to submit your feedback");
      }

      toast({
        title: "Success",
        description: "Feedback submitted successfully.",
      });

      setFeedbackForm({ title: "", description: "" });
      loadFeedbacks();
    } catch (error) {
      toast({
        title: "Error",
        description:
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
        const error = await response.json();
        throw new Error(
          error.message || "Failed to create your support ticket",
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
    } catch (error) {
      toast({
        title: "Error",
        description:
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
        const error = await response.json();
        throw new Error(error.message || "Failed to submit your response");
      }

      toast({
        title: "Success",
        description: "Response submitted successfully.",
      });

      setResponseForm({ message: "" });
      loadTickets(); // Reload tickets to show the new response
    } catch (error) {
      toast({
        title: "Error",
        description:
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