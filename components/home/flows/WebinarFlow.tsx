"use client";

import React from "react";
import { ProcessStep } from "../HowProcessWorksSection";

export default function WebinarFlow() {
  return (
    <div className="space-y-6">
      <ProcessStep
        number={1}
        title="Select Webinar"
        description="Choose from upcoming webinars on various topics"
      />
      <ProcessStep
        number={2}
        title="Check Availability"
        description="View scheduled dates and remaining spots"
      />
      <ProcessStep
        number={3}
        title="Book Your Spot"
        description="Reserve your place in the webinar"
      />
      <ProcessStep
        number={4}
        title="Complete Payment"
        description="Secure your spot by completing the payment"
      />
      <ProcessStep
        number={5}
        title="Join Webinar"
        description="Get access to the webinar at the scheduled time"
        isLast={true}
      />
    </div>
  );
}
