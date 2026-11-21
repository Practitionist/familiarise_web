/**
 * A released seat's page is a dead end only for the seat: it points back to
 * Appointments and on to the events a learner can book instead.
 */

import * as React from "react";
import { render, screen } from "@testing-library/react";

import { NoLongerRegistered } from "../../app/dashboard/consultee/[consulteeId]/(features)/appointments/[appointmentId]/NoLongerRegistered";

it("offers Appointments and a way to find another event", () => {
  render(<NoLongerRegistered consulteeId="cp_1" />);
  expect(
    screen.getByRole("heading", {
      name: "You are no longer registered for this event",
    }),
  ).toBeInTheDocument();
  expect(
    screen
      .getByRole("link", { name: "Go to Appointments" })
      .getAttribute("href"),
  ).toBe("/dashboard/consultee/cp_1/appointments?tab=cancelled");
  expect(
    screen.getByRole("link", { name: "Browse events" }).getAttribute("href"),
  ).toBe("/explore/programs");
});
