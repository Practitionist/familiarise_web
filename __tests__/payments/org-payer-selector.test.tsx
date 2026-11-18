/**
 * @jest-environment jsdom
 *
 * The checkout payer picker offers an organisation only when checkout would
 * accept it for this plan; a refused one is disabled with checkout's sentence.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { OrgPayerSelector } from "@/app/checkout/components/OrgPayerSelector";
import { CheckoutPreviewQuerySchema } from "@/schemas/organizations";

const REFUSAL =
  "No active program assignment covers this booking. Ask your organization admin to assign you to a Program that covers WEBINAR.";

// The membership fields lib/auth.ts customSession puts on the session.
const membership = (organizationId: string, organizationName: string) => ({
  organizationId,
  organizationName,
  organizationSlug: organizationId,
  organizationLogo: null,
  role: "LEARNER" as const,
  departmentLabel: null,
  canSponsor: true,
  canHost: false,
  fundingSource: "WALLET" as const,
  walletBalance: 250_000,
});

jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "u_1",
        organizationMemberships: [
          membership("org_refused", "Acme"),
          membership("org_ok", "Globex"),
        ],
      },
    },
  }),
}));

const previewBody = (fundingRefusal: unknown) => ({
  applicable: false,
  programName: null,
  overageBehavior: null,
  coveredPaise: 0,
  marginalPaise: 0,
  surchargePaise: 0,
  willExceedCap: false,
  willBlock: false,
  chargeTo: null,
  reason: "no org-covered allocation",
  fundingRefusal,
});

const fetchMock = jest.fn(async (url: string) => {
  const body = url.includes("/org_refused/")
    ? previewBody({ code: "PROGRAM_ASSIGNMENT_INACTIVE", message: REFUSAL })
    : previewBody(null);
  return { ok: true, json: async () => body };
});

function renderSelector(selectedOrganizationId: string | null) {
  const onSelect = jest.fn();
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <OrgPayerSelector
        selectedOrganizationId={selectedOrganizationId}
        onSelect={onSelect}
        planType="WEBINAR"
        planId="wp_1"
      />
    </QueryClientProvider>,
  );
  return onSelect;
}

beforeEach(() => {
  fetchMock.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
});

it("disables an organisation checkout would refuse, with the refusal, and keeps one it accepts", async () => {
  const onSelect = renderSelector(null);

  await screen.findByText(REFUSAL);
  const refused = screen.getByRole("button", { name: /Bill to Acme/ });
  const accepted = screen.getByRole("button", { name: /Bill to Globex/ });
  expect(refused).toBeDisabled();
  expect(accepted).toBeEnabled();

  fireEvent.click(refused);
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(accepted);
  expect(onSelect).toHaveBeenCalledWith("org_ok");

  // What the picker sends is what the preview route parses.
  for (const [url] of fetchMock.mock.calls) {
    const query = Object.fromEntries(new URL(url, "http://x").searchParams);
    expect(CheckoutPreviewQuerySchema.parse(query)).toEqual({
      planType: "WEBINAR",
      planId: "wp_1",
      sessions: 1,
    });
  }
});

it("clears a selected organisation once checkout's refusal for it arrives", async () => {
  const onSelect = renderSelector("org_refused");

  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
});
