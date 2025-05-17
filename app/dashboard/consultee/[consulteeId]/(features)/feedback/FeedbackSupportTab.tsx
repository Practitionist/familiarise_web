"use client";

import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "components/ui/card";
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
} from "@prisma/client";
import { useFeedbackSupport } from "./useFeedbackSupport";

interface FeedbackSupportTabProps {
  consulteeId: string;
}

export default function FeedbackSupportTab({
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
        return "bg-yellow-100 text-yellow-800";
      case "IN_PROGRESS":
        return "bg-blue-100 text-blue-800";
      case "RESOLVED":
        return "bg-green-100 text-green-800";
      case "CLOSED":
        return "bg-gray-100 text-gray-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const getPriorityColor = (priority: SupportPriority) => {
    switch (priority) {
      case "LOW":
        return "bg-green-100 text-green-800";
      case "MEDIUM":
        return "bg-yellow-100 text-yellow-800";
      case "HIGH":
        return "bg-orange-100 text-orange-800";
      case "URGENT":
        return "bg-red-100 text-red-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl p-8 shadow-sm border border-gray-100 mb-6">
        <h2 className="text-3xl font-bold text-gray-900">Feedback & Support</h2>
        <p className="mt-2 text-gray-600">
          Submit feedback or get support for any issues
        </p>
      </div>

      <div className="flex space-x-4 mb-6">
        <Button
          onClick={() => setActiveTab("feedback")}
          variant={activeTab === "feedback" ? "default" : "outline"}
        >
          Feedback
        </Button>
        <Button
          onClick={() => setActiveTab("support")}
          variant={activeTab === "support" ? "default" : "outline"}
        >
          Support
        </Button>
      </div>

      {activeTab === "feedback" ? (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Submit Feedback</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={feedbackForm.title}
                  onChange={(e) =>
                    setFeedbackForm((prev) => ({
                      ...prev,
                      title: e.target.value,
                    }))
                  }
                  placeholder="Feedback title"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={feedbackForm.description}
                  onChange={(e) =>
                    setFeedbackForm((prev) => ({
                      ...prev,
                      description: e.target.value,
                    }))
                  }
                  placeholder="Describe your feedback"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="rating">Rating (Optional)</Label>
                <Select
                  value={feedbackForm.rating?.toString()}
                  onValueChange={(value) =>
                    setFeedbackForm((prev) => ({
                      ...prev,
                      rating: parseInt(value),
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a rating" />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5].map((rating) => (
                      <SelectItem key={rating} value={rating.toString()}>
                        {rating} Star{rating !== 1 ? "s" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={handleFeedbackSubmit}
                disabled={
                  isLoading || !feedbackForm.title || !feedbackForm.description
                }
              >
                {isLoading ? "Submitting..." : "Submit Feedback"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Your Feedbacks</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {feedbacks.map((feedback) => (
                  <div
                    key={feedback.id}
                    className="p-4 border rounded-lg space-y-2"
                  >
                    <div className="flex justify-between items-start">
                      <h3 className="font-semibold">{feedback.title}</h3>
                      <Badge
                        className={getStatusColor(
                          feedback.status as FeedbackStatus,
                        )}
                      >
                        {feedback.status}
                      </Badge>
                    </div>
                    <p className="text-gray-600">{feedback.description}</p>
                    {feedback.rating && (
                      <div className="text-sm text-gray-500">
                        Rating: {feedback.rating} star
                        {feedback.rating !== 1 ? "s" : ""}
                      </div>
                    )}
                  </div>
                ))}
                {feedbacks.length === 0 && (
                  <p className="text-gray-500 text-center py-4">
                    No feedbacks submitted yet
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Create Support Ticket</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={ticketForm.title}
                  onChange={(e) =>
                    setTicketForm((prev) => ({
                      ...prev,
                      title: e.target.value,
                    }))
                  }
                  placeholder="Ticket title"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={ticketForm.description}
                  onChange={(e) =>
                    setTicketForm((prev) => ({
                      ...prev,
                      description: e.target.value,
                    }))
                  }
                  placeholder="Describe your issue"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="priority">Priority</Label>
                <Select
                  value={ticketForm.priority}
                  onValueChange={(value) =>
                    setTicketForm((prev) => ({
                      ...prev,
                      priority: value as SupportPriority,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select priority" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(SupportPriority).map((priority) => (
                      <SelectItem key={priority} value={priority}>
                        {priority.charAt(0) + priority.slice(1).toLowerCase()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={handleTicketSubmit}
                disabled={
                  isLoading || !ticketForm.title || !ticketForm.description
                }
              >
                {isLoading ? "Creating..." : "Create Ticket"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Your Support Tickets</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {tickets.map((ticket) => (
                  <div
                    key={ticket.id}
                    className="p-4 border rounded-lg space-y-4"
                  >
                    <div className="flex justify-between items-start">
                      <h3 className="font-semibold">{ticket.title}</h3>
                      <div className="flex gap-2">
                        <Badge
                          className={getPriorityColor(
                            ticket.priority as SupportPriority,
                          )}
                        >
                          {ticket.priority}
                        </Badge>
                        <Badge
                          className={getStatusColor(
                            ticket.status as SupportTicketStatus,
                          )}
                        >
                          {ticket.status}
                        </Badge>
                      </div>
                    </div>
                    <p className="text-gray-600">{ticket.description}</p>

                    {/* Responses */}
                    <div className="pl-4 border-l-2 border-gray-200 space-y-3">
                      {ticket.responses?.map((response: any) => (
                        <div
                          key={response.id}
                          className="bg-gray-50 p-3 rounded"
                        >
                          <p className="text-sm text-gray-600">
                            {response.message}
                          </p>
                          <p className="text-xs text-gray-400 mt-1">
                            {new Date(response.createdAt).toLocaleString()}
                          </p>
                        </div>
                      ))}
                    </div>

                    {/* Response Form */}
                    {selectedTicket === ticket.id && (
                      <div className="space-y-2">
                        <Textarea
                          value={responseForm.message}
                          onChange={(e) =>
                            setResponseForm({ message: e.target.value })
                          }
                          placeholder="Type your response..."
                        />
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            onClick={() => setSelectedTicket(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            onClick={() => handleResponseSubmit(ticket.id)}
                            disabled={isLoading || !responseForm.message}
                          >
                            Send Response
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Show Response Button */}
                    {selectedTicket !== ticket.id && (
                      <Button
                        variant="outline"
                        onClick={() => setSelectedTicket(ticket.id)}
                      >
                        Add Response
                      </Button>
                    )}
                  </div>
                ))}
                {tickets.length === 0 && (
                  <p className="text-gray-500 text-center py-4">
                    No support tickets created yet
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
