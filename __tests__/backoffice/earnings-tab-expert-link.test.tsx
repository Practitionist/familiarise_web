/**
 * @jest-environment jsdom
 */

// A link that names an expert opens the Earnings tab already filtered to that
// expert's held earnings, so no id is carried between screens by hand.

jest.mock(
  "@/components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({
    useBackofficeCapability: () => ({ basePath: "/dashboard/admin" }),
  }),
);
jest.mock("@/components/dashboard/backoffice/money/ops-door", () => ({
  useOpsDoor: () => ({ run: jest.fn(), isPending: false }),
}));
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";

import { EarningsTab } from "@/components/dashboard/backoffice/money/EarningsTab";
import { earningsExpertParam } from "@/lib/backoffice/money-list-schemas";

const fetched: string[] = [];

beforeEach(() => {
  fetched.length = 0;
  global.fetch = jest.fn((url: string) => {
    fetched.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 }),
    });
  }) as unknown as typeof fetch;
});

it("opens on the expert a link names, holds first", async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EarningsTab initialConsultantProfileId="cp-ravi" />
    </QueryClientProvider>,
  );

  expect(screen.getByLabelText("Expert profile id")).toHaveValue("cp-ravi");
  await waitFor(() => expect(fetched.length).toBeGreaterThan(0));
  expect(fetched[0]).toContain("consultantProfileId=cp-ravi");
  expect(fetched[0]).toContain("status=HELD");
});

it("reads the expert from the address, and takes anything else as no filter", () => {
  expect(earningsExpertParam.parse(" cp-ravi ")).toBe("cp-ravi");
  expect(earningsExpertParam.parse(undefined)).toBeUndefined();
  expect(earningsExpertParam.parse(["cp-a", "cp-b"])).toBeUndefined();
  expect(earningsExpertParam.parse("")).toBeUndefined();
});
