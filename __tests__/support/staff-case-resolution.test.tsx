import * as React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
import { rupeesToPaise } from "../../components/support/resolution/resolution-data";
import {
  invalidateSupportCase,
  supportKeys,
} from "../../lib/support/support-keys";

const STALE = "2026-10-20T12:00:00.000Z";
const FRESH = "2026-10-20T12:05:00.000Z";
const resolution = {
  decisions: [],
  recommendations: [],
  holds: [],
  evidenceRequests: [],
  recipients: [],
  canManage: true,
  canExecuteMoney: true,
  canManageHolds: true,
  canVoidRecommendations: false,
  refundLimitPaise: 500_000,
  ownershipScope: "ORG_OPERATIONS",
  updatedAt: STALE,
  caseKind: "INCIDENT",
  isAppeal: false,
  legalHoldAt: null,
  isAdmin: false,
};

/** Applies a payout hold through its own inline reason. */
function holdPayout() {
  fireEvent.click(screen.getByText("Financial review"));
  fireEvent.click(screen.getByRole("button", { name: "Hold payout" }));
  fireEvent.change(screen.getByLabelText("Reason: Hold payout"), {
    target: { value: "Chargeback opened" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Hold this payout" }));
}

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

function sentBody() {
  const init = mockPost.mock.calls[0][1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: resolution }),
  });
  mockPost.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: { ok: true } }),
  });
  mockToast.mockClear();
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("supportKeys", () => {
  it("invalidates a case's whole subtree and the lists, not other cases", async () => {
    const qc = client();
    const keys = [
      supportKeys.workspace("a"),
      supportKeys.resolution("a"),
      supportKeys.attachments("a", "ev_1"),
      supportKeys.ownCase("a"),
      supportKeys.requestList("u", { page: 1 }),
      supportKeys.inboxStats(),
      supportKeys.thread("appt_1"),
      supportKeys.resolution("b"),
    ];
    for (const key of keys) qc.setQueryData(key, { ok: true });
    await invalidateSupportCase(qc, "a");
    const invalidated = keys.map((key) => qc.getQueryState(key)?.isInvalidated);
    expect(invalidated).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });
});

describe("StaffCaseResolution", () => {
  it("sends the workspace's updatedAt, not the resolution query's stale copy", async () => {
    const qc = client();
    qc.setQueryData(supportKeys.resolution("case_1"), resolution);
    qc.setQueryData(supportKeys.workspace("case_1"), { updatedAt: FRESH });
    render(
      <QueryClientProvider client={qc}>
        <StaffCaseResolution
          caseId="case_1"
          paymentId="pay_1"
          basePath="/dashboard/admin"
        />
      </QueryClientProvider>,
    );
    holdPayout();
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({
      action: "APPLY_HOLD",
      paymentId: "pay_1",
      reason: "Chargeback opened",
      expectedUpdatedAt: FRESH,
    });
    await waitFor(() =>
      expect(
        qc.getQueryState(supportKeys.workspace("case_1"))?.isInvalidated,
      ).toBe(true),
    );
    qc.clear();
  });

  it("refetches an invalidated workspace before reading updatedAt", async () => {
    const qc = client();
    qc.setQueryData(supportKeys.resolution("case_1"), resolution);
    qc.setQueryDefaults(supportKeys.workspace("case_1"), {
      queryFn: async () => ({ updatedAt: FRESH }),
    });
    qc.setQueryData(supportKeys.workspace("case_1"), { updatedAt: STALE });
    await qc.invalidateQueries({ queryKey: supportKeys.workspace("case_1") });
    render(
      <QueryClientProvider client={qc}>
        <StaffCaseResolution
          caseId="case_1"
          paymentId="pay_1"
          basePath="/dashboard/admin"
        />
      </QueryClientProvider>,
    );
    holdPayout();
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(sentBody().expectedUpdatedAt).toBe(FRESH);
    qc.clear();
  });

  it.each<[string, "CREDITS" | "GATEWAY", boolean]>([
    ["forces the seat release for a credit-funded payment", "CREDITS", true],
    ["leaves the seat release to staff on a card payment", "GATEWAY", false],
  ])("%s", async (_case, rail, forced) => {
    const qc = client();
    qc.setQueryData(supportKeys.resolution("case_1"), resolution);
    qc.setQueryData(supportKeys.workspace("case_1"), { updatedAt: FRESH });
    render(
      <QueryClientProvider client={qc}>
        <StaffCaseResolution
          caseId="case_1"
          paymentId="pay_1"
          paymentRail={rail}
          basePath="/dashboard/admin"
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("Financial review"));
    const seat = screen.getByLabelText(
      "Also release the customer's seat",
    ) as HTMLInputElement;
    expect(seat.checked).toBe(forced);
    expect(seat.disabled).toBe(forced);
    expect(
      screen.queryByText(
        "Credits always return the whole booking, so the seat is released.",
      ) !== null,
    ).toBe(forced);
    fireEvent.change(screen.getByLabelText("Recommended refund in rupees"), {
      target: { value: "0" },
    });
    fireEvent.change(
      screen.getByLabelText("Reason for the refund recommendation"),
      { target: { value: "Session not delivered" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Recommend refund" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({
      action: "RECOMMEND_REFUND",
      paymentId: "pay_1",
      releaseSeat: forced,
    });
    qc.clear();
  });

  it("has no organization handover control", () => {
    const qc = client();
    qc.setQueryData(supportKeys.resolution("case_1"), resolution);
    render(
      <QueryClientProvider client={qc}>
        <StaffCaseResolution caseId="case_1" basePath="/dashboard/admin" />
      </QueryClientProvider>,
    );
    expect(screen.queryByText(/handover/i)).not.toBeInTheDocument();
    qc.clear();
  });

  it("records a decision only after a confirmation that previews it", async () => {
    const qc = client();
    qc.setQueryData(supportKeys.resolution("case_1"), resolution);
    qc.setQueryData(supportKeys.workspace("case_1"), { updatedAt: FRESH });
    render(
      <QueryClientProvider client={qc}>
        <StaffCaseResolution
          caseId="case_1"
          paymentId="pay_1"
          basePath="/dashboard/admin"
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("Decision"));
    fireEvent.change(screen.getByLabelText("Decision outcome"), {
      target: { value: "SERVICE_REMEDY" },
    });
    fireEvent.change(screen.getByLabelText("Explanation for the customer"), {
      target: { value: "We will rebook your session at no cost." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Record this decision?",
    });
    expect(dialog).toHaveTextContent("Service remedy");
    expect(dialog).toHaveTextContent("We will rebook your session at no cost.");
    expect(dialog).toHaveTextContent("The customer can appeal until about");
    expect(mockPost).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Record decision and resolve" }),
    );
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({
      action: "DECIDE",
      outcome: "SERVICE_REMEDY",
      explanation: "We will rebook your session at no cost.",
      expectedUpdatedAt: FRESH,
    });
    qc.clear();
  });
});

describe("StaffCaseResolution lifecycle", () => {
  const decided = {
    id: "dec_1",
    outcome: "NO_REMEDY",
    explanation: "Delivered as booked.",
    privateRationale: null,
    createdAt: STALE,
    appealUntil: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    supersedesDecisionId: null,
  };
  function renderWith(overrides: Record<string, unknown>) {
    const qc = client();
    qc.setQueryData(supportKeys.resolution("case_1"), {
      ...resolution,
      ...overrides,
    });
    qc.setQueryData(supportKeys.workspace("case_1"), { updatedAt: FRESH });
    render(
      <QueryClientProvider client={qc}>
        <StaffCaseResolution caseId="case_1" basePath="/dashboard/admin" />
      </QueryClientProvider>,
    );
    return qc;
  }
  const outcomeOptions = () =>
    Array.from(
      (screen.getByLabelText("Decision outcome") as HTMLSelectElement).options,
    ).map((option) => option.value);

  it("offers remedy outcomes on an incident", () => {
    const qc = renderWith({});
    expect(outcomeOptions()).toEqual([
      "NO_REMEDY",
      "SERVICE_REMEDY",
      "REFUND_APPROVED",
      "REFUND_DECLINED",
    ]);
    qc.clear();
  });

  it("offers only upheld or overturned on an appeal", () => {
    const qc = renderWith({ isAppeal: true });
    expect(outcomeOptions()).toEqual(["UPHELD", "OVERTURNED"]);
    qc.clear();
  });

  it("names the removal itself on a first-instance conduct removal", () => {
    const qc = renderWith({ reviewsRemoval: true });
    const select = screen.getByLabelText("Decision outcome");
    expect(
      Array.from((select as HTMLSelectElement).options).map((o) => o.text),
    ).toEqual(["Removal upheld", "Removal overturned"]);
    qc.clear();
    cleanup();
    const appeal = renderWith({ reviewsRemoval: true, isAppeal: true });
    expect(
      screen.getByRole("option", { name: "Original decision upheld" }),
    ).toBeInTheDocument();
    appeal.clear();
  });

  it("hides the decision on a problem record", () => {
    const qc = renderWith({ caseKind: "PROBLEM" });
    expect(screen.queryByLabelText("Decision outcome")).not.toBeInTheDocument();
    expect(screen.getByText(/resolved, not decided/)).toBeInTheDocument();
    qc.clear();
  });

  it("gives staff no second decision once one is recorded", () => {
    const qc = renderWith({ decisions: [decided] });
    expect(screen.queryByLabelText("Decision outcome")).not.toBeInTheDocument();
    expect(screen.getByText(/An admin can supersede it/)).toBeInTheDocument();
    qc.clear();
  });

  it("lets an admin supersede the decision in force", async () => {
    const qc = renderWith({ decisions: [decided], isAdmin: true });
    fireEvent.click(screen.getByText("Supersede decision"));
    fireEvent.change(screen.getByLabelText("Decision outcome"), {
      target: { value: "SERVICE_REMEDY" },
    });
    fireEvent.change(screen.getByLabelText("Explanation for the customer"), {
      target: { value: "Corrected: we will rebook." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    await screen.findByRole("alertdialog", {
      name: "Supersede this decision?",
    });
    fireEvent.click(screen.getByRole("button", { name: "Supersede decision" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({
      action: "DECIDE",
      outcome: "SERVICE_REMEDY",
      supersedesDecisionId: "dec_1",
    });
    qc.clear();
  });

  it("closes supersede with the appeal window", () => {
    const qc = renderWith({
      decisions: [{ ...decided, appealUntil: STALE }],
      isAdmin: true,
    });
    expect(screen.queryByText("Supersede decision")).not.toBeInTheDocument();
    qc.clear();
  });

  it("gives only admins the legal hold toggle, which patches the case", async () => {
    const staffView = renderWith({});
    expect(
      screen.queryByRole("button", { name: "Place legal hold" }),
    ).not.toBeInTheDocument();
    staffView.clear();
    cleanup();
    const qc = renderWith({ isAdmin: true });
    fireEvent.click(screen.getByRole("button", { name: "Place legal hold" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const [url, init] = mockPost.mock.calls[0] as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe("/api/support/cases/case_1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({
      legalHold: true,
      expectedUpdatedAt: FRESH,
    });
    qc.clear();
  });
});

describe("rupeesToPaise", () => {
  it("converts exactly and refuses what it would have to round", () => {
    expect(rupeesToPaise("100.5")).toBe(10050);
    expect(rupeesToPaise(" 0 ")).toBe(0);
    expect(rupeesToPaise("100.005")).toBeNull();
    expect(rupeesToPaise("1e3")).toBeNull();
    expect(rupeesToPaise("")).toBeNull();
    expect(rupeesToPaise("-5")).toBeNull();
  });
});
