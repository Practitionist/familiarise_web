"use client";

import React from "react";
import { Card, CardContent } from "components/ui/card";
import { Button } from "components/ui/button";
import { Input } from "components/ui/input";
import { Label } from "components/ui/label";
import { Textarea } from "components/ui/textarea";
import { Badge } from "components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "components/ui/select";
import {
  FeedbackStatus,
  SupportPriority,
  SupportTicketStatus,
  SupportIssueType,
} from "@prisma/client";
import { useFeedbackSupport } from "./useFeedbackSupport";
import {
  MessageSquare,
  HelpCircle,
  Star,
  Send,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronRight,
  Sparkles,
  Link2,
} from "lucide-react";
import { ISSUE_TYPE_LABELS, ISSUE_TYPE_CATEGORIES } from "@/utils/supportTicketUrl";

interface FeedbackSupportTabProps {
  consulteeId: string;
}

const PRIORITY_OPTIONS: { value: SupportPriority; label: string; color: string }[] = [
  { value: "LOW", label: "Low", color: "text-green-600" },
  { value: "MEDIUM", label: "Medium", color: "text-amber-600" },
  { value: "HIGH", label: "High", color: "text-orange-600" },
  { value: "URGENT", label: "Urgent", color: "text-red-600" },
];

export default function FeedbackSupportTab({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  consulteeId,
}: FeedbackSupportTabProps) {
  const {
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
  } = useFeedbackSupport();

  const getStatusColor = (status: FeedbackStatus | SupportTicketStatus) => {
    switch (status) {
      case "PENDING":
      case "OPEN":
        return "bg-blue-50 text-blue-700 border-blue-200";
      case "IN_PROGRESS":
        return "bg-amber-50 text-amber-700 border-amber-200";
      case "RESOLVED":
        return "bg-green-50 text-green-700 border-green-200";
      case "CLOSED":
        return "bg-zinc-100 text-zinc-600 border-zinc-200";
      default:
        return "bg-zinc-100 text-zinc-600 border-zinc-200";
    }
  };

  const getStatusIcon = (status: FeedbackStatus | SupportTicketStatus) => {
    switch (status) {
      case "PENDING":
      case "OPEN":
        return <AlertCircle className="h-3.5 w-3.5" />;
      case "IN_PROGRESS":
        return <Clock className="h-3.5 w-3.5" />;
      case "RESOLVED":
      case "CLOSED":
        return <CheckCircle2 className="h-3.5 w-3.5" />;
      default:
        return <AlertCircle className="h-3.5 w-3.5" />;
    }
  };

  const getPriorityColor = (priority: SupportPriority) => {
    switch (priority) {
      case "LOW":
        return "bg-green-50 text-green-700 border-green-200";
      case "MEDIUM":
        return "bg-amber-50 text-amber-700 border-amber-200";
      case "HIGH":
        return "bg-orange-50 text-orange-700 border-orange-200";
      case "URGENT":
        return "bg-red-50 text-red-700 border-red-200";
      default:
        return "bg-zinc-100 text-zinc-600 border-zinc-200";
    }
  };

  const formatIssueType = (issueType: SupportIssueType | null) => {
    if (!issueType) return null;
    return ISSUE_TYPE_LABELS[issueType] || issueType.replace(/_/g, " ");
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-zinc-900 to-zinc-800 p-8">
        <div className="absolute inset-0 bg-grid-white/5 [mask-image:linear-gradient(0deg,transparent,black)]" />
        <div className="relative">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-white/10">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <h2 className="text-2xl font-semibold text-white">Feedback & Support</h2>
          </div>
          <p className="text-zinc-400 max-w-lg">
            Share your experience or get help with any issues. We&apos;re here to assist you.
          </p>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-2 p-1 rounded-xl bg-zinc-100 dark:bg-zinc-800 w-fit">
        <button
          onClick={() => setActiveTab("feedback")}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${
            activeTab === "feedback"
              ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm"
              : "text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white"
          }`}
        >
          <MessageSquare className="h-4 w-4" />
          Feedback
        </button>
        <button
          onClick={() => setActiveTab("support")}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${
            activeTab === "support"
              ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm"
              : "text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white"
          }`}
        >
          <HelpCircle className="h-4 w-4" />
          Support
        </button>
      </div>

      {activeTab === "feedback" ? (
        <div className="grid gap-8 lg:grid-cols-5">
          {/* Feedback Form */}
          <Card className="lg:col-span-2 border-0 shadow-sm bg-white dark:bg-zinc-900">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-6">
                <div className="p-1.5 rounded-md bg-violet-100 dark:bg-violet-900/30">
                  <Star className="h-4 w-4 text-violet-600 dark:text-violet-400" />
                </div>
                <h3 className="font-semibold text-zinc-900 dark:text-white">Submit Feedback</h3>
              </div>

              <div className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="feedback-title" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Title <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="feedback-title"
                    value={feedbackForm.title}
                    onChange={(e) =>
                      setFeedbackForm((prev) => ({ ...prev, title: e.target.value }))
                    }
                    placeholder="Brief summary of your feedback"
                    className="h-11 border-zinc-200 dark:border-zinc-700 focus:ring-2 focus:ring-violet-500/20"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="feedback-description" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Description <span className="text-red-500">*</span>
                  </Label>
                  <Textarea
                    id="feedback-description"
                    value={feedbackForm.description}
                    onChange={(e) =>
                      setFeedbackForm((prev) => ({ ...prev, description: e.target.value }))
                    }
                    placeholder="Tell us more about your experience..."
                    className="min-h-[120px] border-zinc-200 dark:border-zinc-700 focus:ring-2 focus:ring-violet-500/20 resize-none"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="feedback-rating" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Rating (Optional)
                  </Label>
                  <div className="flex gap-1">
                    {[1, 2, 3, 4, 5].map((rating) => (
                      <button
                        key={rating}
                        type="button"
                        onClick={() => setFeedbackForm((prev) => ({ ...prev, rating }))}
                        className={`p-2 rounded-lg transition-all ${
                          feedbackForm.rating && feedbackForm.rating >= rating
                            ? "text-amber-500"
                            : "text-zinc-300 dark:text-zinc-600 hover:text-amber-400"
                        }`}
                      >
                        <Star className={`h-6 w-6 ${feedbackForm.rating && feedbackForm.rating >= rating ? "fill-current" : ""}`} />
                      </button>
                    ))}
                  </div>
                </div>

                <Button
                  onClick={handleFeedbackSubmit}
                  disabled={isLoading || !feedbackForm.title || !feedbackForm.description}
                  className="w-full h-11 bg-violet-600 hover:bg-violet-700 text-white"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4 mr-2" />
                      Submit Feedback
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Feedback History */}
          <Card className="lg:col-span-3 border-0 shadow-sm bg-white dark:bg-zinc-900">
            <CardContent className="p-6">
              <h3 className="font-semibold text-zinc-900 dark:text-white mb-4">Your Feedback History</h3>

              <div className="space-y-3">
                {feedbacks.map((feedback) => (
                  <div
                    key={feedback.id}
                    className="p-4 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800 transition-all hover:shadow-sm"
                  >
                    <div className="flex justify-between items-start gap-4 mb-2">
                      <h4 className="font-medium text-zinc-900 dark:text-white">{feedback.title}</h4>
                      <Badge variant="outline" className={`${getStatusColor(feedback.status as FeedbackStatus)} flex items-center gap-1.5 shrink-0`}>
                        {getStatusIcon(feedback.status as FeedbackStatus)}
                        {feedback.status}
                      </Badge>
                    </div>
                    <p className="text-sm text-zinc-600 dark:text-zinc-400 line-clamp-2">{feedback.description}</p>
                    {feedback.rating && (
                      <div className="flex items-center gap-1 mt-2">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <Star
                            key={i}
                            className={`h-3.5 w-3.5 ${i < feedback.rating! ? "text-amber-500 fill-amber-500" : "text-zinc-300"}`}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {feedbacks.length === 0 && (
                  <div className="text-center py-12">
                    <div className="mx-auto w-12 h-12 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center mb-3">
                      <MessageSquare className="h-6 w-6 text-zinc-400" />
                    </div>
                    <p className="text-zinc-500 dark:text-zinc-400">No feedback submitted yet</p>
                    <p className="text-sm text-zinc-400 dark:text-zinc-500 mt-1">Share your thoughts with us!</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="grid gap-8 lg:grid-cols-5">
          {/* Support Ticket Form */}
          <Card className="lg:col-span-2 border-0 shadow-sm bg-white dark:bg-zinc-900">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-6">
                <div className="p-1.5 rounded-md bg-blue-100 dark:bg-blue-900/30">
                  <HelpCircle className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                </div>
                <h3 className="font-semibold text-zinc-900 dark:text-white">Create Support Ticket</h3>
              </div>

              <div className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="ticket-issueType" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    What&apos;s this about? <span className="text-red-500">*</span>
                  </Label>
                  <Select
                    value={ticketForm.issueType}
                    onValueChange={(value) =>
                      setTicketForm((prev) => ({ ...prev, issueType: value as SupportIssueType }))
                    }
                  >
                    <SelectTrigger className="h-11 border-zinc-200 dark:border-zinc-700">
                      <SelectValue placeholder="Select issue type" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(ISSUE_TYPE_CATEGORIES).map(([category, types], idx) => (
                        <React.Fragment key={category}>
                          {idx > 0 && <div className="my-1" />}
                          <div className="py-1 px-2 text-xs font-medium text-zinc-500 uppercase tracking-wide">
                            {category}
                          </div>
                          {types.map((issueType) => (
                            <SelectItem key={issueType} value={issueType}>
                              <span>{ISSUE_TYPE_LABELS[issueType]}</span>
                            </SelectItem>
                          ))}
                        </React.Fragment>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ticket-title" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Subject <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="ticket-title"
                    value={ticketForm.title}
                    onChange={(e) =>
                      setTicketForm((prev) => ({ ...prev, title: e.target.value }))
                    }
                    placeholder="Brief summary of your issue"
                    className="h-11 border-zinc-200 dark:border-zinc-700 focus:ring-2 focus:ring-blue-500/20"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ticket-description" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Description <span className="text-red-500">*</span>
                  </Label>
                  <Textarea
                    id="ticket-description"
                    value={ticketForm.description}
                    onChange={(e) =>
                      setTicketForm((prev) => ({ ...prev, description: e.target.value }))
                    }
                    placeholder="Please provide as much detail as possible..."
                    className="min-h-[120px] border-zinc-200 dark:border-zinc-700 focus:ring-2 focus:ring-blue-500/20 resize-none"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ticket-priority" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Priority
                  </Label>
                  <Select
                    value={ticketForm.priority}
                    onValueChange={(value) =>
                      setTicketForm((prev) => ({ ...prev, priority: value as SupportPriority }))
                    }
                  >
                    <SelectTrigger className="h-11 border-zinc-200 dark:border-zinc-700">
                      <SelectValue placeholder="Select priority" />
                    </SelectTrigger>
                    <SelectContent>
                      {PRIORITY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          <span className={option.color}>{option.label}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Button
                  onClick={handleTicketSubmit}
                  disabled={isLoading || !ticketForm.title || !ticketForm.description || !ticketForm.issueType}
                  className="w-full h-11 bg-blue-600 hover:bg-blue-700 text-white"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4 mr-2" />
                      Create Ticket
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Support Ticket List */}
          <Card className="lg:col-span-3 border-0 shadow-sm bg-white dark:bg-zinc-900">
            <CardContent className="p-6">
              <h3 className="font-semibold text-zinc-900 dark:text-white mb-4">Your Support Tickets</h3>

              <div className="space-y-3">
                {tickets.map((ticket) => (
                  <div
                    key={ticket.id}
                    className="p-4 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800 transition-all hover:shadow-sm"
                  >
                    <div className="flex justify-between items-start gap-4 mb-2">
                      <div className="flex-1 min-w-0">
                        <h4 className="font-medium text-zinc-900 dark:text-white truncate">{ticket.title}</h4>
                        <div className="flex items-center gap-2 flex-wrap">
                          {ticket.issueType && (
                            <span className="text-xs text-zinc-500 dark:text-zinc-400">
                              {formatIssueType(ticket.issueType)}
                            </span>
                          )}
                          {/* Context indicator for linked tickets */}
                          {(ticket.consultationId || ticket.subscriptionId || ticket.paymentId) && (
                            <span className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
                              <Link2 className="h-3 w-3" />
                              {ticket.paymentId && !ticket.consultationId && !ticket.subscriptionId
                                ? "Linked to payment"
                                : "Linked to appointment"}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <Badge variant="outline" className={`${getPriorityColor(ticket.priority as SupportPriority)} text-xs`}>
                          {ticket.priority}
                        </Badge>
                        <Badge variant="outline" className={`${getStatusColor(ticket.status as SupportTicketStatus)} flex items-center gap-1 text-xs`}>
                          {getStatusIcon(ticket.status as SupportTicketStatus)}
                          {ticket.status.replace("_", " ")}
                        </Badge>
                      </div>
                    </div>
                    <p className="text-sm text-zinc-600 dark:text-zinc-400 line-clamp-2 mb-3">{ticket.description}</p>

                    {/* Responses */}
                    {ticket.responses && ticket.responses.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-700 space-y-2">
                        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Responses</p>
                        {ticket.responses.map((response: any) => (
                          <div
                            key={response.id}
                            className="p-3 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700"
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                                {response.user?.name || "Support Team"}
                              </span>
                              <span className="text-xs text-zinc-400">
                                {new Date(response.createdAt).toLocaleDateString()}
                              </span>
                            </div>
                            <p className="text-sm text-zinc-600 dark:text-zinc-400">
                              {response.message}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Response Form */}
                    {selectedTicket === ticket.id ? (
                      <div className="mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-700 space-y-3">
                        <Textarea
                          value={responseForm.message}
                          onChange={(e) => setResponseForm({ message: e.target.value })}
                          placeholder="Type your reply..."
                          className="min-h-[80px] border-zinc-200 dark:border-zinc-700 resize-none"
                        />
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setSelectedTicket(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => handleResponseSubmit(ticket.id)}
                            disabled={isLoading || !responseForm.message}
                            className="bg-blue-600 hover:bg-blue-700 text-white"
                          >
                            {isLoading ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              "Send"
                            )}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedTicket(ticket.id)}
                        className="mt-2 text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/20 p-0 h-auto"
                      >
                        Reply to this ticket
                        <ChevronRight className="h-4 w-4 ml-1" />
                      </Button>
                    )}
                  </div>
                ))}
                {tickets.length === 0 && (
                  <div className="text-center py-12">
                    <div className="mx-auto w-12 h-12 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center mb-3">
                      <HelpCircle className="h-6 w-6 text-zinc-400" />
                    </div>
                    <p className="text-zinc-500 dark:text-zinc-400">No support tickets yet</p>
                    <p className="text-sm text-zinc-400 dark:text-zinc-500 mt-1">Create one if you need assistance</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
