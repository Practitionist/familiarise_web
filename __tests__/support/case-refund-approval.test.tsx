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

import { StaffCaseResolution } from "../../components/support/resolution/StaffCaseResolution";
import { supportKeys } from "../../lib/support/support-keys";

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
  client.setQueryData(supportKeys.resolution("case_1"), resolution);
  client.setQueryData(supportKeys.workspace("case_1"), {
    updatedAt: resolution.updatedAt,
  });
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <StaffCaseResolution caseId="case_1" basePath="/dashboard/admin" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Financial review"));
  fireEvent.click(screen.getByRole("button", { name: "Review refund" }));
  await screen.findByRole("alertdialog", { name: "Review refund" });
  const confirm = screen.getByRole("button", { name: "Confirm refund review" });
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Refund review reason"), {
    target: { value: "Session not delivered" },
  });
  fireEvent.click(confirm);

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

it("keeps a hold reason out of the refund recommendation", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(supportKeys.resolution("case_1"), resolution);
  render(
    <QueryClientProvider client={client}>
      <StaffCaseResolution
        caseId="case_1"
        paymentId="pay_1"
        basePath="/dashboard/admin"
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Financial review"));
  fireEvent.click(screen.getByRole("button", { name: "Hold payment" }));
  fireEvent.change(screen.getByLabelText("Reason: Hold payment"), {
    target: { value: "Chargeback opened" },
  });
  expect(
    screen.getByLabelText("Reason for the refund recommendation"),
  ).toHaveValue("");
  fireEvent.change(
    screen.getByLabelText("Reason for the refund recommendation"),
    {
      target: { value: "Partial delivery" },
    },
  );
  expect(
    screen.getByRole("button", { name: "Recommend refund" }),
  ).toBeDisabled();
  client.clear();
});
