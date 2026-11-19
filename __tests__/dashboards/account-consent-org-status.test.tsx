/**
 * @jest-environment jsdom
 */

/**
 * Account › Data consent asks only an ACTIVE organisation for consent. The
 * consent route refuses a deactivated one with a 403, so fetching it only
 * printed a dead-end line per organisation.
 */

jest.mock("../../hooks/use-toast", () => {
  const toast = jest.fn();
  return { __esModule: true, useToast: () => ({ toast }) };
});

jest.mock("../../lib/auth-client", () => ({
  __esModule: true,
  useSession: () => ({ data: { user: { id: "user-1" } } }),
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
      return json({ data: [] });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    global.fetch = realFetch;
  });

  it("fetches consent for the active organisation only and names the other quietly", async () => {
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
    expect(
      urls.some((u) => u.startsWith("/api/organizations/org-live/consent")),
    ).toBe(true);
    expect(urls.some((u) => u.includes("/org-gone/"))).toBe(false);

    const text = container.textContent ?? "";
    expect(text).not.toContain("couldn't load your consent");
    expect(text).toContain(
      "QA Fixture Org is not active, so there is no consent to give or withdraw there.",
    );
    expect(container.querySelectorAll("h3")).toHaveLength(2);
  });
});
