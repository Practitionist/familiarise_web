/**
 * Each row of the expert's own reliability record names the plan and the
 * session it is about, from what the strikes reader returns.
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { ReliabilityCard } from "@/app/dashboard/consultant/[consultantId]/(features)/settings/booking/ReliabilityCard";
import { readOwnStrikes } from "@/lib/booking/expert-reliability";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";

const NOW = new Date("2026-11-19T00:00:00Z");

const db = {
  systemEvent: {
    findMany: jest.fn(async () => [
      {
        createdAt: new Date("2026-11-14T09:00:00Z"),
        context: {
          strike: "EXPERT_CANCEL",
          appointmentId: "appt-1",
          occurrenceIds: ["occ-1"],
        },
      },
      {
        createdAt: new Date("2026-11-02T09:00:00Z"),
        context: { strike: "CONSULTANT_NO_SHOW", appointmentId: "appt-2" },
      },
    ]),
  },
  platformIncident: { findMany: jest.fn(async () => []) },
  appointmentOccurrence: {
    findMany: jest.fn(async () => [
      {
        id: "occ-1",
        startsAt: new Date("2026-11-20T10:30:00Z"),
        appointment: {
          id: "appt-1",
          appointmentType: "WEBINAR",
          consultation: null,
          subscription: null,
          webinar: { webinarPlan: { title: "Pricing for founders" } },
          class: null,
          trial: null,
        },
      },
    ]),
  },
} as never;

it("names the plan and the session date on a row whose strike carries them", async () => {
  const body = { data: await readOwnStrikes("cp-1", { now: NOW, db }) };
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => JSON.parse(JSON.stringify(body)),
  })) as unknown as typeof fetch;

  render(
    <QueryClientProvider client={new QueryClient()}>
      <DisplayZoneProvider zone="Asia/Kolkata">
        <ReliabilityCard consultantId="cp-1" />
      </DisplayZoneProvider>
    </QueryClientProvider>,
  );

  const rows = await screen.findAllByRole("listitem");
  expect(rows.map((r) => r.textContent)).toEqual([
    "You cancelled a confirmed bookingPricing for founders · session on 20 Nov 2026, 4:00 PM14 Nov 2026",
    "You did not join a session2 Nov 2026",
  ]);
});
