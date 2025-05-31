"use client";

import React from "react";
import { ProcessStep } from "../HowProcessWorksSection";

export default function ClassFlow() {
  return (
    <div className="space-y-6">
      <ProcessStep
        number={1}
        title="Choose Class Plan"
        description="Browse structured class programs with detailed curricula"
      />
      <ProcessStep
        number={2}
        title="Check Class Schedule"
        description="View class timings and batch availability"
      />
      <ProcessStep
        number={3}
        title="Secure Your Seat"
        description="Book your place in the upcoming batch"
      />
      <ProcessStep
        number={4}
        title="Complete Payment"
        description="Process payment to confirm your enrollment"
      />
      <ProcessStep
        number={5}
        title="Start Learning"
        description="Access class materials and attend scheduled sessions"
        isLast={true}
      />
    </div>
  );
}
