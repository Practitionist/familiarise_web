/**
 * @jest-environment node
 */

/**
 * #1775 PR-A A-4 — the inbox anatomy over the A-1 fixture: four rows land in
 * their buckets, no raw enum text reaches the DOM, the awaiting-payment row
 * offers Remind + Withdraw, the next-cycle row offers Allocate, and only the
 * dialog-free row gets a batch checkbox.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findMany: jest.fn(), count: jest.fn() },
    subscription: { findMany: jest.fn(), count: jest.fn() },
    trial: { findMany: jest.fn(), count: jest.fn() },
    membership: { findMany: jest.fn() },
  },
}));

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import prisma from "@/lib/prisma";
import { readRequestsInbox } from "@/lib/data/requests-inbox";
import { deriveBookingPresentation } from "@/lib/dashboard/money-state";
import type { InboxRowInput } from "@/lib/dashboard/requests-inbox-state";
import { InboxBuckets } from "@/components/dashboard/shared/requests/InboxBuckets";
import {
  InboxRow,
  isDialogFreeApproval,
  rowActions,
} from "@/components/dashboard/shared/requests/InboxRow";
import { CP, NOW, serveInboxFixture } from "../fixtures/requests-inbox";

type MockPrisma = Parameters<typeof serveInboxFixture>[0];
const viewer = { zone: "Asia/Kolkata", own: true };

async function fixtureRows(): Promise<InboxRowInput[]> {
  const read = (type: "consultation" | "subscription" | "trial") =>
    readRequestsInbox({
      consultantProfileId: CP,
      type,
      sort: "priority",
      page: 1,
      now: NOW,
    });
  const [c, s, t] = await Promise.all([
    read("consultation"),
    read("subscription"),
    read("trial"),
  ]);
  return [...c.rows, ...s.rows, ...t.rows];
}

function render(rows: InboxRowInput[]) {
  return renderToStaticMarkup(
    <InboxBuckets
      rows={rows}
      flat={false}
      renderRow={(row) => (
        <InboxRow
          key={row.id}
          row={row}
          viewer={viewer}
          selectable={isDialogFreeApproval(row)}
          selected={false}
          busy={false}
          now={NOW}
          onSelect={() => undefined}
          onAction={() => undefined}
        />
      )}
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  serveInboxFixture(prisma as unknown as MockPrisma);
});

describe("Requests inbox anatomy (A-4)", () => {
  it("renders four rows in their buckets with no enum text in the DOM", async () => {
    const rows = await fixtureRows();
    const html = render(rows);
    expect(html.match(/data-row-id=/g)).toHaveLength(4);
    expect(html).toContain('id="inbox-bucket-answer-today"');
    expect(html).toContain('id="inbox-bucket-waiting-on-them"');
    expect(html).not.toContain('id="inbox-bucket-this-week"');
    // Every booking word is the presentation layer's, never a status enum.
    expect(html).not.toMatch(
      /SUCCEEDED|PENDING|APPROVED_PENDING_PAYMENT|SCHEDULED|AWAITING_PAYMENT/,
    );
    expect(html).toContain("Requested");
    expect(html).toContain("Awaiting payment");
    expect(html).toContain("Schedule the next 2 · 4 of 24 booked");
    expect(html).not.toMatch(/\d+ slots/);
  });

  it("offers one primary action per row: Remind + Withdraw, Allocate, Approve, countdown-only", async () => {
    const rows = await fixtureRows();
    const actionsOf = (id: string) => {
      const row = rows.find((r) => r.id === id)!;
      return rowActions(
        row,
        deriveBookingPresentation(row.presentation, "CONSULTANT", { now: NOW }),
      );
    };
    expect(actionsOf("s-awaiting")).toEqual({
      primary: { kind: "remind" },
      secondary: [{ kind: "withdraw" }],
    });
    expect(actionsOf("s-next")).toEqual({
      primary: { kind: "allocate-next" },
      secondary: [],
    });
    expect(actionsOf("c-pending")).toEqual({
      primary: { kind: "approve", mode: "requested" },
      secondary: [{ kind: "decline" }],
    });
    // A paid trial has no reminder route yet: the countdown alone.
    expect(actionsOf("t-awaiting")).toEqual({ primary: null, secondary: [] });
    const html = render(rows);
    expect(html).toContain(">Remind<");
    expect(html).toContain(">Allocate<");
    expect(html).toContain(">Approve<");
  });

  it("puts the batch checkbox only on the dialog-free row", async () => {
    const rows = await fixtureRows();
    expect(rows.filter(isDialogFreeApproval).map((r) => r.id)).toEqual([
      "c-pending",
    ]);
    const html = render(rows);
    expect(html.match(/role="checkbox"/g)).toHaveLength(1);
  });
});
