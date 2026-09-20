/**
 * @jest-environment node
 */

/**
 * #1675 / #1586 P1-J13 — a terminal money state is shown in plain words with
 * a next step, never dropped. U1: only the pay-link lapse (the
 * APPROVED_PENDING_PAYMENT → EXPIRED edge) becomes a Home row, and that row
 * carries the "Request again" link. U2: a FAILED refund gets the support line,
 * a SUCCEEDED one does not. X-1: the payments route still answers 403 for a
 * foreign consulteeId now that the read lives in lib/data. X-4: the Needs-you
 * band is absent for an empty payload and present with one DUE row.
 */

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: jest.fn(),
  isPrivileged: jest.fn(() => false),
  forbiddenResponse: jest.fn(
    (message: string) =>
      new Response(JSON.stringify({ error: message }), { status: 403 }),
  ),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consulteeProfile: { findUnique: jest.fn() },
    membership: { findMany: jest.fn() },
  },
}));
jest.mock("../../lib/data/consultee-payments", () => ({
  __esModule: true,
  readConsulteePayments: jest.fn(),
}));

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { requireApiAuth } from "@/lib/auth-helpers";
import { readConsulteePayments } from "@/lib/data/consultee-payments";
import { GET as getPayments } from "@/app/api/dashboard/consultee/[consulteeId]/payments/route";
import {
  toLapsedPayLinks,
  type ExpiredRequestRow,
} from "@/lib/dashboard/lapsed-pay-links";
import { LapsedPayLinkRow } from "@/app/dashboard/consultee/[consulteeId]/(features)/home/LapsedPayLinkRow";
import { FailedRefundNote } from "@/app/dashboard/consultee/[consulteeId]/(features)/payments/FailedRefundNote";
import { NeedsYouBand } from "@/app/dashboard/consultee/[consulteeId]/(features)/payments/NeedsYouBand";

const NOW = new Date("2026-09-20T12:00:00Z");
const expiredRow = (
  id: string,
  fromStatus: string,
  createdAt: Date,
): ExpiredRequestRow => ({
  id,
  type: "consultation",
  title: "Career chat",
  consultantName: "Asha Rao",
  consultantProfileId: "cp-1",
  history: [{ fromStatus, toStatus: "EXPIRED", createdAt }],
});

describe("U1 — lapsed pay-link row", () => {
  it("keeps the pay-link lapse and drops the other EXPIRED edges", () => {
    const lapsedAt = new Date("2026-09-18T09:30:00Z");
    const rows = [
      expiredRow("lapsed", "APPROVED_PENDING_PAYMENT", lapsedAt),
      // The expert never answered — same terminal status, different story.
      expiredRow("unanswered", "PENDING", lapsedAt),
      // A lapse older than the 7 d window.
      expiredRow("old", "APPROVED_PENDING_PAYMENT", new Date("2026-09-01")),
    ];
    const links = toLapsedPayLinks(rows, NOW);
    expect(links.map((l) => l.id)).toEqual(["lapsed"]);
    expect(links[0].requestAgainHref).toBe("/explore/experts/cp-1");

    const html = renderToStaticMarkup(<LapsedPayLinkRow link={links[0]} />);
    expect(html).toContain("Your payment link for Asha Rao expired on");
    expect(html).toContain(
      "Ask Asha Rao for a new link, or book another time.",
    );
    expect(html).toContain('href="/explore/experts/cp-1"');
    expect(html).toContain("Request again");
  });
});

describe("U2 — failed refund line", () => {
  const props = {
    amountText: "₹1,200.00",
    supportHref: "/dashboard/x/support",
  };

  it("FAILED renders the line and the support link", () => {
    const html = renderToStaticMarkup(
      <FailedRefundNote status="FAILED" {...props} />,
    );
    expect(html).toContain("We couldn&#x27;t return ₹1,200.00");
    expect(html).toContain("3 working days");
    expect(html).toContain('href="/dashboard/x/support"');
    expect(html).toContain("Contact support");
  });

  it("SUCCEEDED renders nothing", () => {
    expect(
      renderToStaticMarkup(<FailedRefundNote status="SUCCEEDED" {...props} />),
    ).toBe("");
  });
});

describe("X-1 — the payments route keeps its ownership guard", () => {
  it("answers 403 for a foreign consulteeId without reading anything", async () => {
    (requireApiAuth as jest.Mock).mockResolvedValue({
      session: {
        user: { id: "user-1", role: "USER", consulteeProfileId: "mine" },
      },
    });
    const res = await getPayments(new Request("http://localhost/api"), {
      params: Promise.resolve({ consulteeId: "someone-else" }),
    });
    expect(res.status).toBe(403);
    expect(readConsulteePayments).not.toHaveBeenCalled();
  });
});

describe("X-4 — the Needs-you band", () => {
  // The band reads the Home widget's `pending-payments` query; seeding that
  // cache entry stands in for the route the widget's fetcher would call.
  const renderBand = (payload: {
    pendingPayments: unknown[];
    lapsedPayLinks: unknown[];
  }) => {
    const client = new QueryClient();
    client.setQueryData(["pending-payments", "c-1"], payload);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <NeedsYouBand consulteeId="c-1" />
      </QueryClientProvider>,
    );
    // Drop the cache's gc timers so jest exits without --forceExit.
    client.clear();
    return html;
  };

  it("is absent when nothing needs the consultee", () => {
    expect(renderBand({ pendingPayments: [], lapsedPayLinks: [] })).toBe("");
  });

  it("shows the DUE row under a 'Needs you' heading", () => {
    const html = renderBand({
      pendingPayments: [
        {
          id: "cons-1",
          type: "consultation",
          title: "Career chat",
          consultantName: "Asha Rao",
          amount: 150_000,
          currency: "INR",
          paymentUrl: "https://rzp.io/l/abc",
          approvedAt: "2026-09-19T09:00:00Z",
          expiresAt: "2099-01-01T00:00:00Z",
          isExpiringSoon: false,
          source: "approval_pending",
          appointmentId: "appt-1",
        },
      ],
      lapsedPayLinks: [],
    });
    expect(html).toContain("Needs you");
    expect(html).toContain("Career chat");
    expect(html).toContain('href="https://rzp.io/l/abc"');
  });
});
