import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  canExecuteMoney: false,
  ownershipScope: "ORG_OPERATIONS",
  updatedAt: STALE,
};

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
        <StaffCaseResolution caseId="case_1" basePath="/dashboard/admin" />
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Record organization handover" }),
    );
    fireEvent.change(
      screen.getByLabelText("Reason: Record organization handover"),
      { target: { value: "Billing team owns this" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Record handover" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({
      action: "HANDOVER",
      reason: "Billing team owns this",
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
        <StaffCaseResolution caseId="case_1" basePath="/dashboard/admin" />
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Record organization handover" }),
    );
    fireEvent.change(
      screen.getByLabelText("Reason: Record organization handover"),
      { target: { value: "Billing team owns this" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Record handover" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(sentBody().expectedUpdatedAt).toBe(FRESH);
    qc.clear();
  });

  it("records a decision only after a confirmation that previews it", async () => {
    const qc = client();
    qc.setQueryData(supportKeys.resolution("case_1"), resolution);
    qc.setQueryData(supportKeys.workspace("case_1"), { updatedAt: FRESH });
    render(
      <QueryClientProvider client={qc}>
        <StaffCaseResolution caseId="case_1" basePath="/dashboard/admin" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("Decision"));
    fireEvent.change(screen.getByLabelText("Decision outcome"), {
      target: { value: "SERVICE_REMEDY" },
    });
    fireEvent.change(screen.getByLabelText("Explanation for the customer"), {
      target: { value: "We will rebook your session at no cost." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
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
