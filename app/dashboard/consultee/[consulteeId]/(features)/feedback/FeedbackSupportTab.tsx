"use client";

import React from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";

interface FeedbackSupportTabProps {
  consulteeId: string;
}

export default function FeedbackSupportTab({
  consulteeId,
}: Readonly<FeedbackSupportTabProps>) {
  const handleFeedbackSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // TODO: Implement feedback submission with consulteeId
    console.log("Submitting feedback for consultee:", consulteeId);
  };

  const handleSupportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // TODO: Implement support ticket submission with consulteeId
    console.log("Submitting support ticket for consultee:", consulteeId);
  };

  return (
    <div className="min-h-[calc(100vh-200px)] space-y-6 overflow-y-auto">
      <h2 className="text-3xl font-bold mb-6">Feedback & Support</h2>

      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Provide Feedback</CardTitle>
          <CardDescription>
            We value your opinion and would love to hear from you
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleFeedbackSubmit}>
          <CardContent>
            <Textarea
              placeholder="Type your feedback here..."
              className="min-h-[150px] bg-gray-200"
              required
            />
          </CardContent>
          <CardFooter>
            <Button type="submit" className="bg-black text-white">
              Submit Feedback
            </Button>
          </CardFooter>
        </form>
      </Card>

      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Contact Support</CardTitle>
          <CardDescription>
            Need help? Our support team is here for you
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSupportSubmit} className="space-y-4">
          <CardContent>
            <div className="space-y-4">
              <Input placeholder="Subject" required />
              <Textarea
                placeholder="Describe your issue..."
                className="min-h-[150px] bg-gray-200"
                required
              />
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" className="bg-black text-white">
              Submit Support Ticket
            </Button>
          </CardFooter>
        </form>
      </Card>

      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Support Information</CardTitle>
        </CardHeader>
        <CardContent>
          <p>Email: support@example.com</p>
          <p>Phone: +1 (123) 456-7890</p>
          <p>Hours: Monday - Friday, 9 AM - 5 PM EST</p>
        </CardContent>
      </Card>
    </div>
  );
}
