/** @jest-environment node */

const mockConsultation = { findMany: jest.fn(), count: jest.fn() };
const mockSubscription = { findMany: jest.fn(), count: jest.fn() };
const mockTrial = { findMany: jest.fn(), count: jest.fn() };
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: {
      findMany: (...args: unknown[]) => mockConsultation.findMany(...args),
      count: (...args: unknown[]) => mockConsultation.count(...args),
    },
    subscription: {
      findMany: (...args: unknown[]) => mockSubscription.findMany(...args),
      count: (...args: unknown[]) => mockSubscription.count(...args),
    },
    trial: {
      findMany: (...args: unknown[]) => mockTrial.findMany(...args),
      count: (...args: unknown[]) => mockTrial.count(...args),
    },
  },
}));

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readRequestsInbox } from "@/lib/data/requests-inbox";
import { deriveBookingPresentation } from "@/lib/dashboard/money-state";
import {
  InboxRow,
  rowActions,
} from "@/components/dashboard/shared/requests/InboxRow";
import type { InboxRowInput } from "@/lib/dashboard/requests-inbox-state";
import { formatInViewerZone } from "@/lib/time/viewer-zone";
import {
  CP,
  NOW,
  awaitingConsultation,
  hoursAgo,
  hoursAhead,
  serve,
} from "../fixtures/requests-inbox";

function actions(row: InboxRowInput, now = NOW) {
  return rowActions(
    row,
    deriveBookingPresentation(row.presentation, "CONSULTANT", {
      viewerZone: "UTC",
      now,
    }),
    now,
  );
}

function render(row: InboxRowInput, now = NOW) {
  return renderToStaticMarkup(
    <InboxRow
      row={row}
      viewer={{ zone: "Asia/Kolkata", own: true }}
      selectable={false}
      selected={false}
      busy={false}
      now={now}
      onSelect={() => undefined}
      onAction={() => undefined}
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const model of [mockConsultation, mockSubscription, mockTrial]) {
    model.findMany.mockResolvedValue([]);
    model.count.mockResolvedValue(0);
  }
});

// Only a 1:1 awaits payment after approval; a plan is paid at checkout.
describe.each(["consultation"] as const)("%s reminder eligibility", (kind) => {
  const base = awaitingConsultation;
  const appointment = base.appointment;
  const payment = appointment.payment[0];

  async function readOne(request: Parameters<typeof serve>[0][number]) {
    const served = serve([request]);
    const model = mockConsultation;
    model.findMany.mockImplementation(served.findMany);
    model.count.mockImplementation(served.count);
    const { rows } = await readRequestsInbox({
      consultantProfileId: CP,
      type: kind,
      sort: "priority",
      page: 1,
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  it("prints the hold's time in the viewer's profile zone, not the runtime's", async () => {
    const row = await readOne(base);
    const hold = row.presentation.holdExpiresAt as Date;
    const html = renderToStaticMarkup(
      <InboxRow
        row={row}
        viewer={{ zone: "America/Los_Angeles", own: true }}
        selectable={false}
        selected={false}
        busy={false}
        now={NOW}
        onSelect={() => undefined}
        onAction={() => undefined}
      />,
    );
    expect(html).toContain(
      formatInViewerZone(hold, "America/Los_Angeles", "EEE d MMM HH:mm"),
    );
  });

  it("offers a live reminder without exposing the recipient email or payment link", async () => {
    const row = await readOne(base);
    expect(row.reminderExpiresAt).toEqual(hoursAhead(6));
    expect(actions(row).primary).toEqual({ kind: "remind" });
    expect(render(row)).toContain(">Remind<");
    expect(JSON.stringify(row)).not.toContain(base.requestedBy.user.email);
    expect(JSON.stringify(row)).not.toContain(base.pendingPaymentUrl);
  });

  it.each([
    ["missing appointment (QA seed shape)", { ...base, appointment: null }],
    [
      "missing payment",
      { ...base, appointment: { ...appointment, payment: [] } },
    ],
    ["missing link", { ...base, pendingPaymentUrl: null }],
    [
      "missing recipient email",
      {
        ...base,
        requestedBy: {
          ...base.requestedBy,
          user: { ...base.requestedBy.user, email: null },
        },
      },
    ],
    [
      "missing expiry",
      {
        ...base,
        appointment: {
          ...appointment,
          payment: [{ ...payment, expiresAt: null }],
        },
      },
    ],
    [
      "expired order",
      {
        ...base,
        appointment: {
          ...appointment,
          payment: [{ ...payment, expiresAt: hoursAgo(1) }],
        },
      },
    ],
    [
      "non-pending order",
      {
        ...base,
        appointment: {
          ...appointment,
          payment: [{ ...payment, paymentStatus: "FAILED" }],
        },
      },
    ],
    [
      "soft-deleted only pending order",
      {
        ...base,
        appointment: {
          ...appointment,
          payment: [{ ...payment, deletedAt: hoursAgo(1) }],
        },
      },
    ],
    [
      "soft-deleted appointment",
      { ...base, appointment: { ...appointment, deletedAt: hoursAgo(1) } },
    ],
  ])("hides Remind for %s", async (_label, request) => {
    const row = await readOne(request);
    expect(row.reminderExpiresAt).toBeNull();
    expect(actions(row).primary).toBeNull();
    expect(render(row)).not.toContain(">Remind<");
  });

  it("does not fall back to an older live order when the newest pending order expired", async () => {
    const row = await readOne({
      ...base,
      appointment: {
        ...appointment,
        payment: [
          payment,
          {
            ...payment,
            id: "newer",
            createdAt: hoursAgo(1),
            expiresAt: hoursAgo(0.5),
          },
        ],
      },
    });
    expect(row.reminderExpiresAt).toBeNull();
    expect(actions(row).primary).toBeNull();
  });

  it("removes Remind at expiry while the page remains open, including a JSON date", async () => {
    const row = await readOne(base);
    const serialized = {
      ...row,
      reminderExpiresAt: hoursAhead(6).toISOString(),
    };
    expect(actions(serialized).primary).toEqual({ kind: "remind" });
    expect(actions(serialized, hoursAhead(6)).primary).toBeNull();
    expect(render(serialized, hoursAhead(6))).not.toContain(">Remind<");
  });
});
