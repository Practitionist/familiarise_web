"use client"

import React from 'react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

export default function FeedbackSupportTab() {
  return (
    <div className="min-h-[calc(100vh-200px)] space-y-6 overflow-y-auto">
      <h2 className="text-3xl font-bold mb-6">Feedback & Support</h2>
      
      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Provide Feedback</CardTitle>
          <CardDescription>We value your opinion and would love to hear from you</CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea placeholder="Type your feedback here..." className="min-h-[150px] bg-gray-200" />
        </CardContent>
        <CardFooter>
          <Button className="bg-black text-white">Submit Feedback</Button>
        </CardFooter>
      </Card>

      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Contact Support</CardTitle>
          <CardDescription>Need help? Our support team is here for you</CardDescription>
        </CardHeader>
        <CardContent>
          <p>Email: support@example.com</p>
          <p>Phone: +1 (123) 456-7890</p>
          <p>Hours: Monday - Friday, 9 AM - 5 PM EST</p>
        </CardContent>
        <CardFooter>
          <Button className="bg-black text-white">Open Support Ticket</Button>
        </CardFooter>
      </Card>
    </div>
  );
}