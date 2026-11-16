/**
 * The Leads control asks for a reason before a move, and what it sends parses
 * with the transition door's own body schema. "Received" reads in India time.
 */

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { z } from "zod";

// A native <select> stands in for Radix Select, which jsdom cannot open.
jest.mock("@/components/ui/select", () => {
  const Ctx = React.createContext<{
    value: string;
    onChange: (v: string) => void;
  }>({ value: "", onChange: () => {} });
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (v: string) => void;
      children: React.ReactNode;
    }) => (
      <Ctx.Provider value={{ value, onChange: onValueChange }}>
        {children}
      </Ctx.Provider>
    ),
    SelectTrigger: ({ id }: { id?: string }) => (id ? <span>{id}</span> : null),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => {
      const { value, onChange } = React.useContext(Ctx);
      return (
        <select
          aria-label={`Select from ${value}`}
          defaultValue=""
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="" />
          {children}
        </select>
      );
    },
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children: React.ReactNode;
    }) => <option value={value}>{children}</option>,
  };
});

import { LeadsManagement } from "../../components/admin/LeadsManagement";
import { leadTransitionShape } from "../../lib/backoffice/lead-transition";
import { opsReasonSchema } from "../../lib/backoffice/ops-reason";

// The exact schema withOpsAction builds for the door.
const doorBody = z.object(leadTransitionShape).extend({
  reason: opsReasonSchema,
});

const lead = {
  id: "lead_1",
  sourceCategory: "ENTERPRISE",
  companyName: "Acme",
  contactName: "Asha",
  contactEmail: "buyer@example.test",
  phone: null,
  subject: "Team plan",
  message: "Hello",
  status: "NEW",
  // 00:00 UTC is 05:30 in India.
  createdAt: "2026-04-01T00:00:00.000Z",
};

let fetchMock: jest.Mock;
const originalFetch = global.fetch;
beforeEach(() => {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
  fetchMock = jest.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    json: async () =>
      init?.method === "PATCH"
        ? { lead: { ...lead, status: "CONTACTED" } }
        : { leads: [lead], nextCursor: null },
  }));
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = originalFetch;
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LeadsManagement />
    </QueryClientProvider>,
  );
}

const patches = () =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");

it("shows when the lead arrived in India time with UTC on hover", async () => {
  renderPage();
  const time = await screen.findByText("1 Apr 2026, 5:30 am IST");
  expect(time.tagName).toBe("TIME");
  expect(time).toHaveAttribute("title", "1 Apr 2026, 12:00 am UTC");
});

it("sends nothing until a reason of five characters is given", async () => {
  renderPage();
  fireEvent.change(await screen.findByLabelText("Select from NEW"), {
    target: { value: "CONTACTED" },
  });
  const confirm = await screen.findByRole("button", { name: "Move lead" });
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "ok" },
  });
  expect(confirm).toBeDisabled();
  expect(patches()).toHaveLength(0);
});

it("sends a body the door's schema accepts", async () => {
  renderPage();
  fireEvent.change(await screen.findByLabelText("Select from NEW"), {
    target: { value: "CONTACTED" },
  });
  fireEvent.change(await screen.findByLabelText("Reason"), {
    target: { value: "  Called the buyer back  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Move lead" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  const [url, init] = patches()[0];
  expect(url).toBe("/api/admin/leads/lead_1");
  const sent: unknown = JSON.parse(String(init.body));
  expect(doorBody.parse(sent)).toEqual({
    status: "CONTACTED",
    reason: "Called the buyer back",
  });
  expect(sent).toEqual({
    status: "CONTACTED",
    reason: "Called the buyer back",
  });
});
