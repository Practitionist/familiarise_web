import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

import { CreateTicketDialog } from "../../components/dashboard/shared/support/CreateTicketDialog";

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/user/org-memberships") {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    return {
      ok: true,
      json: async () => ({ data: { id: "case_1", referenceNumber: "FAM-1" } }),
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function renderDialog() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <CreateTicketDialog
        defaults={{
          issueType: "PAYMENT_ISSUE",
          title: "Charged twice",
          description: "Two debits for one booking",
        }}
      />
    </QueryClientProvider>,
  );
}

describe("New support case dialog", () => {
  it("offers no priority control and sends no priority", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /New support case/ }));

    expect(screen.queryByText("Priority")).toBeNull();
    expect(screen.queryByLabelText(/priority/i)).toBeNull();

    fireEvent.click(
      await screen.findByRole("button", { name: "Create support case" }),
    );

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => u === "/api/support/cases"),
      ).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([u]) => u === "/api/support/cases");
    const body = JSON.parse(call?.[1].body as string) as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty("priority");
    expect(body.title).toBe("Charged twice");
  });
});
