/**
 * The manual invoice composer shows the terms-default due date before it
 * issues: prefilled, labelled "Net N", and sent exactly as before when untouched.
 */

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { z } from "zod";

// The route's schema module also holds the issuing service; its vendors stay out.
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/novu/org-workflows", () => ({}));
jest.mock("../../lib/email/senders/money", () => ({}));
jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({}));

import { InvoiceComposer } from "../../components/organization/billing/InvoiceComposer";
import { CreateOrgInvoiceSchema } from "../../lib/payments/billing/create-org-invoice";
import { opsReasonSchema } from "../../lib/backoffice/ops-reason";

// 20:00 UTC on 20 Nov 2026 is already 21 Nov in India; Net 30 lands on 21 Dec IST.
const NOW = Date.parse("2026-11-20T20:00:00.000Z");
const DEFAULT_DUE = new Date(NOW + 30 * 86_400_000).toISOString();
const RouteBody = z.object(CreateOrgInvoiceSchema.shape).extend({
  reason: opsReasonSchema,
});

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

const originalFetch = global.fetch;
let nowSpy: jest.SpyInstance;
beforeEach(() => {
  nowSpy = jest.spyOn(Date, "now").mockReturnValue(NOW);
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ data: { id: "inv_1" } }),
  });
});
afterEach(() => {
  nowSpy.mockRestore();
  global.fetch = originalFetch;
});

function compose() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <InvoiceComposer
        orgId="org_1"
        paymentTermsDays={30}
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("Description"), {
    target: { value: "Onboarding workshop" },
  });
  fireEvent.change(screen.getByLabelText("Unit price in rupees"), {
    target: { value: "1500" },
  });
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Requested by the org admin" },
  });
}

async function sentBody() {
  await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
  const init = (global.fetch as jest.Mock).mock.calls[0][1] as {
    body: string;
  };
  return RouteBody.parse(JSON.parse(init.body));
}

describe("InvoiceComposer due date", () => {
  it("prefills the Net 30 India date and sends the terms-default instant", async () => {
    compose();
    const due = screen.getByLabelText("Due date (Net 30)");
    expect(due).toHaveValue("2026-12-21");
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    const body = await sentBody();
    expect(body.dueDate.toISOString()).toBe(DEFAULT_DUE);
  });

  it("sends the submit-time default when left untouched across India midnight", async () => {
    // Opened at 23:59 IST, submitted two minutes later on the next India day.
    nowSpy.mockReturnValue(Date.parse("2026-11-20T18:29:00.000Z"));
    compose();
    expect(screen.getByLabelText("Due date (Net 30)")).toHaveValue(
      "2026-12-20",
    );
    const submitAt = Date.parse("2026-11-20T18:31:00.000Z");
    nowSpy.mockReturnValue(submitAt);
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    const body = await sentBody();
    expect(body.dueDate.toISOString()).toBe(
      new Date(submitAt + 30 * 86_400_000).toISOString(),
    );
  });

  it("sends an edited date as typed, even one equal to the prefill", async () => {
    compose();
    const due = screen.getByLabelText("Due date (Net 30)");
    fireEvent.change(due, { target: { value: "2026-12-22" } });
    fireEvent.change(due, { target: { value: "2026-12-21" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    const body = await sentBody();
    expect(body.dueDate.toISOString()).toBe("2026-12-21T00:00:00.000Z");
  });

  it("sends a date the operator picked", async () => {
    compose();
    fireEvent.change(screen.getByLabelText("Due date (Net 30)"), {
      target: { value: "2026-12-05" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    const body = await sentBody();
    expect(body.dueDate.toISOString()).toBe("2026-12-05T00:00:00.000Z");
  });
});
