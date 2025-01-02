"use client";

import React from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

interface PolicyTabProps {
  consulteeId: string;
}

export default function PolicyTab({ consulteeId }: Readonly<PolicyTabProps>) {
  return (
    <div className="min-h-[calc(100vh-200px)] space-y-6 overflow-y-auto">
      <h2 className="text-3xl font-bold mb-6">Policies & Guidelines</h2>

      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Cancellation Policy</CardTitle>
          <CardDescription>
            Important information about cancellations and refunds
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-semibold mb-2">24-Hour Notice Required</h3>
            <p className="text-gray-600">
              We require a minimum of 24 hours notice for all cancellations.
              This allows us to accommodate other consultees who may be waiting
              for appointments.
            </p>
          </div>
          <div>
            <h3 className="font-semibold mb-2">Refund Policy</h3>
            <ul className="list-disc pl-6 space-y-2 text-gray-600">
              <li>Full refund for cancellations made 24+ hours in advance</li>
              <li>50% refund for cancellations made 12-24 hours in advance</li>
              <li>
                No refund for cancellations made less than 12 hours before the
                session
              </li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Rescheduling Guidelines</CardTitle>
          <CardDescription>
            Information about rescheduling your sessions
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-semibold mb-2">Rescheduling Process</h3>
            <ul className="list-disc pl-6 space-y-2 text-gray-600">
              <li>
                Free rescheduling available up to 24 hours before the session
              </li>
              <li>One free reschedule per booking</li>
              <li>Additional rescheduling may incur a fee</li>
              <li>All rescheduling subject to consultant availability</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Session Guidelines</CardTitle>
          <CardDescription>
            Best practices for a productive session
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-semibold mb-2">Before Your Session</h3>
            <ul className="list-disc pl-6 space-y-2 text-gray-600">
              <li>Join the session 5 minutes early to test your audio/video</li>
              <li>Ensure you have a stable internet connection</li>
              <li>Prepare any questions or topics you want to discuss</li>
              <li>Find a quiet, well-lit space for your session</li>
            </ul>
          </div>
          <div>
            <h3 className="font-semibold mb-2">During Your Session</h3>
            <ul className="list-disc pl-6 space-y-2 text-gray-600">
              <li>Keep your microphone muted when not speaking</li>
              <li>Use the chat feature for technical issues</li>
              <li>Stay engaged and take notes if needed</li>
              <li>Respect the scheduled time limits</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Privacy Policy</CardTitle>
          <CardDescription>
            How we handle and protect your information
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-semibold mb-2">Data Protection</h3>
            <p className="text-gray-600">
              We take your privacy seriously and implement strict measures to
              protect your personal information. All session recordings and
              communications are encrypted and stored securely.
            </p>
          </div>
          <div>
            <h3 className="font-semibold mb-2">Information Usage</h3>
            <p className="text-gray-600">
              Your information is used solely for improving your consultation
              experience and will never be shared with third parties without
              your explicit consent.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
