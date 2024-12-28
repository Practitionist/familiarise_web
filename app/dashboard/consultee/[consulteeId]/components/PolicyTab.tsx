"use client";

import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function PolicyTab() {
  return (
    <div className="min-h-[calc(100vh-200px)] space-y-6 overflow-y-auto">
      <h2 className="text-3xl font-bold mb-6">Policies</h2>

      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Terms of Service</CardTitle>
        </CardHeader>
        <CardContent>
          <p>
            Our Terms of Service outline the rules and regulations for the use
            of our platform. By accessing this website, we assume you accept
            these terms and conditions in full. Do not continue to use our
            website if you do not accept all of the terms and conditions stated
            on this page.
          </p>
        </CardContent>
      </Card>

      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Privacy Policy</CardTitle>
        </CardHeader>
        <CardContent>
          <p>
            Your privacy is important to us. It is our policy to respect your
            privacy regarding any information we may collect from you across our
            website. We only ask for personal information when we truly need it
            to provide a service to you. We collect it by fair and lawful means,
            with your knowledge and consent.
          </p>
        </CardContent>
      </Card>

      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Refund Policy</CardTitle>
        </CardHeader>
        <CardContent>
          <p>
            We want you to be satisfied with our services. If you are not 100%
            satisfied with your purchase, you can request a full refund of the
            cost of the service within 30 days of the purchase date. To be
            eligible for a return, your item must be unused and in the same
            condition that you received it.
          </p>
        </CardContent>
      </Card>

      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Code of Conduct</CardTitle>
        </CardHeader>
        <CardContent>
          <p>
            We are committed to providing a friendly, safe and welcoming
            environment for all, regardless of gender, sexual orientation,
            disability, ethnicity, religion, or similar personal characteristic.
            Our code of conduct outlines our expectations for participant
            behavior as well as the consequences for unacceptable behavior.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
