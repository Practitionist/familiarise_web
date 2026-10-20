import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockToast = jest.fn();
const mockPost = jest.fn();
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("../../lib/auth/reauth-client", () => ({
  fetchWithReauth: (...args: unknown[]) => mockPost(...args),
}));

import { CaseResolutionPanel } from "../../components/support/CaseResolutionPanel";

const resolution = {
  decisions: [],
  recommendations: [
    {
      id: "rec_1",
      paymentId: "pay_1",
      amountPaise: 5_000_000,
      reason: "Session not delivered",
      approved: null,
      decidedAt: null,
      refund: null,
    },
  ],
  holds: [],
  evidenceRequests: [],
  recipients: [],
  canManage: true,
  canExecuteMoney: true,
  ownershipScope: "PERSONAL",
  updatedAt: "2026-10-20T12:00:00.000Z",
};
const originalFetch = global.fetch;
const originalUuid = Object.getOwnPropertyDescriptor(
  global.crypto,
  "randomUUID",
);

beforeEach(() => {
  Object.defineProperty(global.crypto, "randomUUID", {
    configurable: true,
    value: () => "00000000-0000-4000-8000-000000000001",
  });
  global.fetch = jest.fn().mockImplementation(async (input: string) => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: input.includes("/preview")
        ? {
            refundablePaise: 5_000_000,
            amountPaise: 5_000_000,
            rail: "GATEWAY",
            blockedReason: null,
          }
        : resolution,
    }),
  }));
  mockToast.mockClear();
  mockPost.mockReset();
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalUuid)
    Object.defineProperty(global.crypto, "randomUUID", originalUuid);
  else Reflect.deleteProperty(global.crypto, "randomUUID");
});

it("shows a 202 refund as awaiting another admin, with a link to approvals", async () => {
  mockPost.mockResolvedValue({
    ok: true,
    status: 202,
    json: async () => ({
      status: "PROPOSED",
      proposalId: "proposal_1",
      expiresAt: "2026-10-21T12:00:00.000Z",
    }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["support-case-resolution", "case_1"], resolution);
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <CaseResolutionPanel caseId="case_1" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Financial review"));
  expect(screen.getByRole("button", { name: "Review refund" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Action reason"), {
    target: { value: "Session not delivered" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review refund" }));
  await screen.findByRole("alertdialog", { name: "Review refund" });
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm refund review" }),
  );

  const pending = await screen.findByRole("status");
  expect(pending).toHaveTextContent("Waiting for another admin’s approval");
  expect(pending).toHaveTextContent("The refund has not been sent.");
  expect(
    screen.getByRole("link", { name: "View money approvals" }),
  ).toHaveAttribute("href", "/dashboard/admin/money/approvals");
  expect(mockToast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Sent to another admin for approval" }),
  );
  expect(mockToast).not.toHaveBeenCalledWith({ title: "Case updated" });
  expect(mockPost).toHaveBeenCalledTimes(1);
  unmount();
  client.clear();
});
