"use client";

import React from "react";
import { ProcessStep } from "../HowProcessWorksSection";

export default function ConsultationFlow() {
  return (
    <div className="space-y-6">
      <ProcessStep
        number={1}
        title="Select a Consultation Plan"
        description="Browse and choose from various consultation plans offered by experts"
      />
      <ProcessStep
        number={2}
        title="Create Consultation Request"
        description="Submit your request with preferred time slots and specific requirements"
      />
      <ProcessStep
        number={3}
        title="Schedule Appointment"
        description="Once approved, an appointment is created for your consultation"
      />
      <ProcessStep
        number={4}
        title="Complete Payment"
        description="Secure your booking by completing the payment process"
      />
      <ProcessStep
        number={5}
        title="Join Consultation"
        description="Access your consultation at the scheduled time through our platform"
        isLast={true}
      />
    </div>
  );
}
