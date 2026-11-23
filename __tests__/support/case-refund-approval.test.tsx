import * as React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockToast = jest.fn();
const mockPost = jest.fn();
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("../../lib/auth/reauth-client", () => ({
  fetchWithReauth: (...args: unknown[]) => mockPost(...args),
}));

import { StaffCaseResolution } from "../../components/support/resolution/StaffCaseResolution";
import type { CaseResolution } from "../../components/support/resolution/resolution-data";
import { supportKeys } from "../../lib/support/support-keys";

const LONG_AGO = "2026-01-01T00:00:00.000Z";
const recommendation: CaseResolution["recommendations"][number] = {
  id: "rec_1",
  paymentId: "pay_1",
  amountPaise: 300_000,
  reason: "Session not delivered",
  approved: null,
  decidedAt: null,
  releaseSeat: false,
  sessionsRemoved: null,
  voidedAt: null,
  voidedById: null,
  refund: null,
  pendingApprovalExpiresAt: null,
};
const base: CaseResolution = {
  decisions: [],
  recommendations: [recommendation],
  holds: [],
  evidenceRequests: [],
  recipients: [],
  canManage: true,
  canExecuteMoney: true,
  canManageHolds: true,
  canVoidRecommendations: true,
  refundLimitPaise: null,
  ownershipScope: "PERSONAL",
  updatedAt: "2026-10-20T12:00:00.000Z",
  caseKind: "INCIDENT",
  isAppeal: false,
  legalHoldAt: null,
  isAdmin: false,
  planRefund: null,
};

let preview = {
  refundablePaise: 300_000,
  amountPaise: 300_000,
  rail: "GATEWAY",
  blockedReason: null as string | null,
  note: null as string | null,
  committedPaise: 0,
};
const originalFetch = global.fetch;
const originalUuid = Object.getOwnPropertyDescriptor(
  global.crypto,
  "randomUUID",
);

beforeEach(() => {
  preview = {
    refundablePaise: 300_000,
    amountPaise: 300_000,
    rail: "GATEWAY",
    blockedReason: null,
    note: null,
    committedPaise: 0,
  };
  Object.defineProperty(global.crypto, "randomUUID", {
    configurable: true,
    value: () => "00000000-0000-4000-8000-000000000001",
  });
  global.fetch = jest.fn().mockImplementation(async (input: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ data: input.includes("/preview") ? preview : base }),
  }));
  mockToast.mockClear();
  mockPost.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: { ok: true } }),
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalUuid)
    Object.defineProperty(global.crypto, "randomUUID", originalUuid);
  else Reflect.deleteProperty(global.crypto, "randomUUID");
});

function renderPanel(resolution: CaseResolution, paymentId?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(supportKeys.resolution("case_1"), resolution);
  client.setQueryData(supportKeys.workspace("case_1"), {
    updatedAt: resolution.updatedAt,
  });
  render(
    <QueryClientProvider client={client}>
      <StaffCaseResolution
        caseId="case_1"
        paymentId={paymentId}
        basePath="/dashboard/admin"
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Financial review"));
  return client;
}

function sentBody() {
  const init = mockPost.mock.calls[0][1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

const awaitingApproval = {
  ...base,
  recommendations: [
    { ...recommendation, pendingApprovalExpiresAt: "2026-10-21T12:00:00.000Z" },
  ],
};

it("reads the second-admin wait from the resolution, not local state", async () => {
  const client = renderPanel(awaitingApproval);
  const pending = await screen.findByRole("status");
  expect(pending).toHaveTextContent("Waiting for another admin’s approval");
  expect(
    screen.getByRole("link", { name: "View money approvals" }),
  ).toHaveAttribute("href", "/dashboard/admin/money/approvals");
  expect(
    screen.queryByRole("button", { name: "Review refund" }),
  ).not.toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalledWith(
    expect.stringContaining("/ops-proposals"),
  );
  client.clear();
});

it("hides Review and Decline from staff while an approval is open, without the admin link", async () => {
  const client = renderPanel({
    ...awaitingApproval,
    canVoidRecommendations: false,
    refundLimitPaise: 500_000,
  });
  await screen.findByRole("status");
  expect(
    screen.queryByRole("button", { name: "Review refund" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Decline" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "View money approvals" }),
  ).not.toBeInTheDocument();
  client.clear();
});

it("shows a chargeback block from the preview and refuses to confirm", async () => {
  preview.blockedReason = "A gateway chargeback is active";
  const client = renderPanel(base);
  fireEvent.click(screen.getByRole("button", { name: "Review refund" }));
  const dialog = await screen.findByRole("alertdialog", {
    name: "Review refund",
  });
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "This refund can’t be sent. A gateway chargeback is active.",
  );
  fireEvent.change(screen.getByLabelText("Refund review reason"), {
    target: { value: "Session not delivered" },
  });
  expect(
    screen.getByRole("button", { name: "Confirm refund review" }),
  ).toBeDisabled();
  client.clear();
});

it("explains a 100% discount booking's ₹0 ending and lets it be confirmed", async () => {
  preview = {
    ...preview,
    refundablePaise: 0,
    amountPaise: 0,
    rail: "CREDITS",
    note: "This booking was free with a discount code; ending it returns no money but reverses the expert's earnings.",
  };
  const client = renderPanel(base);
  fireEvent.click(screen.getByRole("button", { name: "Review refund" }));
  const dialog = await screen.findByRole("alertdialog", {
    name: "Review refund",
  });
  expect(dialog).toHaveTextContent(/free with a discount code/);
  expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Refund review reason"), {
    target: { value: "Session not delivered" },
  });
  expect(
    screen.getByRole("button", { name: "Confirm refund review" }),
  ).toBeEnabled();
  client.clear();
});

it("tells staff their per-payment limit and blocks a review past it", async () => {
  preview.committedPaise = 300_000;
  const client = renderPanel({ ...base, refundLimitPaise: 500_000 }, "pay_1");
  expect(
    screen.getByText(/You can send up to ₹5,000(\.00)? per payment/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/an admin sends anything larger/),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review refund" }));
  await screen.findByRole("alertdialog", { name: "Review refund" });
  expect(screen.getByText(/past your ₹5,000(\.00)? limit/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Refund review reason"), {
    target: { value: "Session not delivered" },
  });
  expect(
    screen.getByRole("button", { name: "Confirm refund review" }),
  ).toBeDisabled();
  client.clear();
});

it("retries a FAILED refund through a fresh preview", async () => {
  const client = renderPanel({
    ...base,
    recommendations: [
      {
        ...recommendation,
        approved: true,
        decidedAt: LONG_AGO,
        refund: { id: "ref_1", status: "FAILED" },
      },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry refund" }));
  await screen.findByRole("alertdialog", { name: "Review refund" });
  expect(global.fetch).toHaveBeenCalledWith(
    "/api/support/cases/case_1/recommendations/rec_1/preview",
  );
  fireEvent.change(screen.getByLabelText("Refund review reason"), {
    target: { value: "Gateway timeout, retrying" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm refund review" }),
  );
  await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
  expect(sentBody()).toMatchObject({
    action: "REVIEW_REFUND",
    recommendationId: "rec_1",
    approve: true,
    expectedRefundablePaise: 300_000,
  });
  client.clear();
});

it("offers Void only on approved refunds that are not live, behind a reasoned confirm", async () => {
  const client = renderPanel({
    ...base,
    recommendations: [
      {
        ...recommendation,
        id: "rec_cancelled",
        approved: true,
        decidedAt: LONG_AGO,
        refund: { id: "ref_2", status: "CANCELLED" },
      },
      {
        ...recommendation,
        id: "rec_sent",
        approved: true,
        decidedAt: LONG_AGO,
        refund: { id: "ref_3", status: "SUCCEEDED" },
      },
    ],
  });
  const voids = screen.getAllByRole("button", { name: "Void" });
  expect(voids).toHaveLength(1);
  expect(
    screen.queryByRole("button", { name: "Retry refund" }),
  ).not.toBeInTheDocument();
  fireEvent.click(voids[0]);
  await screen.findByRole("alertdialog", {
    name: "Void this approved refund?",
  });
  const confirm = screen.getByRole("button", { name: "Void refund" });
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Reason for voiding"), {
    target: { value: "Customer accepted a rebooking" },
  });
  fireEvent.click(confirm);
  await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
  expect(sentBody()).toMatchObject({
    action: "VOID_RECOMMENDATION",
    recommendationId: "rec_cancelled",
    reason: "Customer accepted a rebooking",
  });
  client.clear();
});

it("hides Void from staff without the admin permission", () => {
  const client = renderPanel({
    ...base,
    canVoidRecommendations: false,
    recommendations: [
      {
        ...recommendation,
        approved: true,
        decidedAt: LONG_AGO,
        refund: { id: "ref_1", status: "FAILED" },
      },
    ],
  });
  expect(
    screen.queryByRole("button", { name: "Void" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry refund" })).toBeVisible();
  client.clear();
});

it("keeps the seat unless staff explicitly release it, and says the booking is not cancelled", async () => {
  const client = renderPanel(base, "pay_1");
  const seat = screen.getByLabelText("Also release the customer's seat");
  expect(seat).not.toBeChecked();
  expect(seat).toHaveAccessibleDescription(
    /loses access to the sessions and recordings.*does not cancel the booking or its sessions; use Cancel booking in the booking's Ops panel/,
  );
  fireEvent.change(screen.getByLabelText("Recommended refund in rupees"), {
    target: { value: "1500" },
  });
  fireEvent.change(
    screen.getByLabelText("Reason for the refund recommendation"),
    { target: { value: "Partial delivery" } },
  );
  fireEvent.click(seat);
  fireEvent.click(screen.getByRole("button", { name: "Recommend refund" }));
  await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
  expect(sentBody()).toMatchObject({
    action: "RECOMMEND_REFUND",
    paymentId: "pay_1",
    amountPaise: 150_000,
    releaseSeat: true,
  });
  client.clear();
});

it("keeps a hold reason out of the refund recommendation and explains an empty hold", () => {
  const client = renderPanel(
    {
      ...base,
      holds: [
        {
          id: "evt_hold",
          paymentId: "pay_1",
          reason: "Chargeback opened",
          createdAt: LONG_AGO,
          releasedAt: null,
          earningsHeld: 0,
        },
      ],
    },
    "pay_1",
  );
  expect(screen.getByText("No unpaid earnings to hold")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Hold payout" }));
  fireEvent.change(screen.getByLabelText("Reason: Hold payout"), {
    target: { value: "Second chargeback" },
  });
  expect(
    screen.getByLabelText("Reason for the refund recommendation"),
  ).toHaveValue("");
  client.clear();
});

describe("a plan payment's refund priced in sessions", () => {
  // ₹15,600 for 78 sessions; 9 refunded nowhere yet; 60 not held.
  const planCase: CaseResolution = {
    ...base,
    recommendations: [],
    planRefund: {
      paymentId: "pay_1",
      amountPaise: 1_560_000,
      refundablePaise: 1_560_000,
      sessionsTotal: 78,
      sessionsRefunded: 0,
      removable: 60,
    },
  };

  it("shows the per-session math and sends the session count with its share", async () => {
    renderPanel(planCase, "pay_1");
    fireEvent.change(await screen.findByLabelText("Plan sessions to refund"), {
      target: { value: "9" },
    });
    expect(
      screen.getByText(
        /9 of 78 sessions × about ₹200(\.00)? each = ₹1,800(\.00)?/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/69 stay on it/)).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Recommended refund in rupees"),
    ).not.toBeInTheDocument();
    fireEvent.change(
      screen.getByLabelText("Reason for the refund recommendation"),
      { target: { value: "The expert missed nine sessions" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Recommend refund" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(sentBody()).toMatchObject({
      action: "RECOMMEND_REFUND",
      paymentId: "pay_1",
      amountPaise: 180_000,
      sessions: 9,
    });
  });

  it("refuses more sessions than the plan has unheld", async () => {
    renderPanel(planCase, "pay_1");
    fireEvent.change(await screen.findByLabelText("Plan sessions to refund"), {
      target: { value: "61" },
    });
    expect(
      screen.getByText(
        /Enter 1 to 60: only sessions not yet booked or delivered/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Recommend refund" }),
    ).toBeDisabled();
  });

  it("says nothing is left by count, and locks the box, when no session is removable", async () => {
    renderPanel(
      {
        ...planCase,
        planRefund: {
          paymentId: "pay_1",
          amountPaise: 1_560_000,
          refundablePaise: 1_560_000,
          sessionsTotal: 78,
          sessionsRefunded: 18,
          removable: 0,
        },
      },
      "pay_1",
    );
    expect(
      await screen.findByLabelText("Plan sessions to refund"),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "Nothing is left to refund by session count on this plan.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Enter 1 to 0/)).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Recommended refund in rupees"),
    ).toBeInTheDocument();
  });

  it("keeps the money-only form for a payment that is not a plan", async () => {
    renderPanel(base, "pay_1");
    expect(
      await screen.findByLabelText("Recommended refund in rupees"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Plan sessions to refund"),
    ).not.toBeInTheDocument();
  });
});
