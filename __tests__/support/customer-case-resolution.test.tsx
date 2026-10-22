import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockToast = jest.fn();
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import { CustomerCaseResolution } from "../../components/support/resolution/CustomerCaseResolution";
import { supportKeys } from "../../lib/support/support-keys";

const resolution = {
  decisions: [
    {
      id: "dec_1",
      outcome: "NO_REMEDY",
      explanation: "The session was delivered as booked.",
      createdAt: "2026-10-19T10:00:00.000Z",
      appealUntil: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    },
  ],
  recommendations: [],
  holds: [],
  evidenceRequests: [],
  recipients: [],
  canManage: false,
  canExecuteMoney: false,
  canManageHolds: false,
  canVoidRecommendations: false,
  refundLimitPaise: null,
  ownershipScope: "ORG_OPERATIONS",
  updatedAt: "2026-10-20T12:00:00.000Z",
};

const originalFetch = global.fetch;
const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({
      data: { id: "case_appeal", referenceNumber: "SR-2026-0042" },
    }),
  });
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = originalFetch;
});

function renderCustomer() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(supportKeys.resolution("case_1"), resolution);
  render(
    <QueryClientProvider client={qc}>
      <CustomerCaseResolution caseId="case_1" />
    </QueryClientProvider>,
  );
  return qc;
}

describe("CustomerCaseResolution", () => {
  it("never renders operator controls, even on an organization case", () => {
    const qc = renderCustomer();
    expect(
      screen.queryByRole("button", { name: /handover/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/action reason/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/financial/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.getByText("The session was delivered as booked."),
    ).toBeInTheDocument();
    qc.clear();
  });

  it("opens the appeal inline with focus and then shows it as submitted", async () => {
    const qc = renderCustomer();
    fireEvent.click(
      screen.getByRole("button", { name: "Appeal this decision" }),
    );
    const reason = screen.getByLabelText("Explain what should be reconsidered");
    expect(reason).toHaveFocus();
    fireEvent.change(reason, { target: { value: "The expert never joined." } });
    fireEvent.click(screen.getByRole("button", { name: "Submit appeal" }));
    const receipt = await screen.findByRole("status");
    expect(receipt).toHaveTextContent("Appeal submitted · SR-2026-0042");
    expect(
      screen.queryByRole("button", { name: "Appeal this decision" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("/api/support/appeals");
    expect(JSON.parse(init.body)).toMatchObject({
      decisionId: "dec_1",
      reason: "The expert never joined.",
    });
    qc.clear();
  });
});
