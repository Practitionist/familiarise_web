/**
 * @jest-environment jsdom
 */

/**
 * Account › Data consent: consent is given only to an ACTIVE organisation, a
 * granted one stays withdrawable in a suspended or unverified organisation, and
 * a deactivated one (the consent route answers 403) is named in one line.
 */

jest.mock("../../hooks/use-toast", () => {
  const toast = jest.fn();
  return { __esModule: true, useToast: () => ({ toast }) };
});

jest.mock("../../lib/auth-client", () => ({
  __esModule: true,
  useSession: () => ({ data: { user: { id: "user-1" } } }),
}));

// jsdom has no matchMedia for the real dialog; the trigger is what is asserted.
jest.mock("../../components/dashboard/ConfirmDialog", () => ({
  __esModule: true,
  ConfirmDialog: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}));

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConsentSection } from "../../components/dashboard/account/ConsentSection";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The shape GET /api/user/org-memberships answers (findSwitcherMemberships, all=false).
const MEMBERSHIPS = {
  data: [
    {
      organizationId: "org-live",
      orgName: "Wipro Limited",
      orgLogo: null,
      orgStatus: "ACTIVE",
      role: "OWNER",
      status: "ACTIVE",
    },
    {
      organizationId: "org-paused",
      orgName: "Paused Co",
      orgLogo: null,
      orgStatus: "SUSPENDED",
      role: "LEARNER",
      status: "ACTIVE",
    },
    {
      organizationId: "org-gone",
      orgName: "QA Fixture Org",
      orgLogo: null,
      orgStatus: "DEACTIVATED",
      role: "OWNER",
      status: "ACTIVE",
    },
  ],
};

const json = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body });

describe("ConsentSection organisation rows", () => {
  const realFetch = global.fetch;
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    fetchMock = jest.fn((url: string) => {
      if (url.startsWith("/api/user/org-memberships")) return json(MEMBERSHIPS);
      if (url.startsWith("/api/organizations/org-gone/consent")) {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: async () => ({}),
        });
      }
      if (url.startsWith("/api/organizations/org-paused/consent")) {
        return json({
          data: [
            {
              purposeCodes: ["PRIMARY_PROCESSING"],
              withdrawnAt: null,
              auditRetainedUntil: "2099-01-01T00:00:00.000Z",
            },
          ],
        });
      }
      return json({ data: [] });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    global.fetch = realFetch;
  });

  it("gives consent only to an active organisation, still withdraws in a suspended one, and names a deactivated one", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={client}>
          <ConsentSection />
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    for (const org of ["org-live", "org-paused"]) {
      expect(
        urls.some((u) => u.startsWith(`/api/organizations/${org}/consent`)),
      ).toBe(true);
    }
    expect(urls.some((u) => u.includes("/org-gone/"))).toBe(false);

    const block = (name: string) => {
      const heading = Array.from(container.querySelectorAll("h3")).find(
        (h) => h.textContent === name,
      );
      const el = heading?.parentElement;
      return {
        text: el?.textContent ?? "",
        buttons: Array.from(el?.querySelectorAll("button") ?? []).map(
          (b) => b.textContent,
        ),
      };
    };
    expect(block("Wipro Limited").buttons).toContain("Give consent");
    const paused = block("Paused Co");
    expect(paused.buttons).toContain("Withdraw");
    expect(paused.buttons).not.toContain("Give consent");
    expect(paused.text).toContain(
      "Paused Co is not active, so you can withdraw a consent here but not give one.",
    );

    const text = container.textContent ?? "";
    expect(text).not.toContain("couldn't load your consent");
    expect(text).toContain(
      "QA Fixture Org has been deactivated, so there is no consent to give or withdraw there.",
    );
    expect(container.querySelectorAll("h3")).toHaveLength(3);
  });
});
