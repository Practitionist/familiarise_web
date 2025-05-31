"use client";

import React from "react";
import { ProcessStep } from "../HowProcessWorksSection";

export default function SubscriptionFlow() {
  return (
    <div className="space-y-6">
      <ProcessStep
        number={1}
        title="Choose Subscription Plan"
        description="Select from monthly subscription plans with different benefits"
      />
      <ProcessStep
        number={2}
        title="Submit Subscription Request"
        description="Provide your preferred schedule and learning goals"
      />
      <ProcessStep
        number={3}
        title="Schedule Multiple Sessions"
        description="Get access to multiple appointments throughout your subscription period"
      />
      <ProcessStep
        number={4}
        title="One-time Payment"
        description="Make a single payment to activate your subscription"
      />
      <ProcessStep
        number={5}
        title="Access All Benefits"
        description="Enjoy regular sessions and additional subscription benefits"
        isLast={true}
      />
    </div>
  );
}
