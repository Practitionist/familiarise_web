/**
 * An organisation member's own sessions are printed in India time, and say so:
 * a member in another zone must not read the unlabelled clock as their own.
 */

import * as React from "react";
import { render, screen } from "@testing-library/react";

jest.mock("../../hooks/scheduling/useLazyJoinMeeting", () => ({
  useLazyJoinMeeting: () => jest.fn(),
}));

import {
  MyAppointmentsClient,
  type MyAppointmentItem,
} from "@/app/dashboard/organization/[orgId]/appointments/MyAppointmentsClient";

const item = {
  id: "appt-1",
  appointmentType: "CONSULTATION",
  createdAt: "2026-11-10T06:00:00.000Z",
  occurrences: [
    {
      id: "occ-1",
      // Tue 24 Nov 02:00 in Tokyo is Mon 23 Nov 22:30 in India.
      startsAt: "2026-11-23T17:00:00.000Z",
      endsAt: "2026-11-23T18:00:00.000Z",
      isTentative: false,
      completionStatus: "SCHEDULED",
    },
  ],
  consultation: {
    status: "APPROVED",
    consultationPlan: {
      title: "Career chat",
      consultantProfile: {
        user: { id: "u-h", name: "Hannah", email: "hannah@example.test" },
      },
    },
    requestedBy: {
      user: { id: "u-a", name: "Aiko", email: "aiko@example.test" },
    },
  },
  subscription: null,
  webinar: null,
  class: null,
} as MyAppointmentItem;

it("labels the session time as IST", () => {
  render(
    <MyAppointmentsClient
      orgId="org-1"
      viewerId="u-a"
      items={[item]}
      total={1}
      page={1}
      perPage={20}
    />,
  );
  expect(screen.getByText(/10:30 pm IST/)).toBeInTheDocument();
});
