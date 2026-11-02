/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockSignOut = jest.fn();
const mockUseSession = jest.fn();

jest.mock("@/lib/auth-client", () => ({ useSession: () => mockUseSession() }));
jest.mock("@/lib/auth/sign-out", () => ({
  signOutEverywhere: (to: string) => mockSignOut(to),
}));
jest.mock("next/navigation", () => ({ usePathname: () => "/explore/experts" }));
jest.mock("@/hooks/useRememberedAuth", () => ({
  useRememberedAuth: () => null,
  resolveAuthView: ({
    user,
  }: {
    user: { name?: string; image?: string } | null;
  }) =>
    user
      ? { mode: "authed", name: user.name ?? null, image: user.image ?? null }
      : { mode: "anonymous", name: null, image: null },
}));
jest.mock("@/hooks/useCurrency", () => ({
  SUPPORTED_CURRENCIES: [{ code: "INR", label: "INR" }],
  useCurrency: () => ({
    currency: "INR",
    symbol: "₹",
    setCurrency: jest.fn(),
    isEstimate: false,
  }),
}));
jest.mock("@/providers/AnnouncementBarProvider", () => ({
  useAnnouncementBar: () => ({ isVisible: false }),
}));

import Navbar from "@/components/Navbar";

const mockFetch = jest.fn();
const renderNavbar = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Navbar />
    </QueryClientProvider>,
  );
const FACETS = {
  facets: [
    {
      kind: "expert",
      key: "expert",
      label: "Expert",
      href: "/dashboard/consultant/c1/home",
    },
    {
      kind: "organization",
      key: "org:o1",
      label: "Acme",
      href: "/dashboard/organization/o1",
    },
  ],
};

// Radix opens its trigger on Enter, the keyboard path the menu must support.
const openMenu = () =>
  fireEvent.keyDown(screen.getByRole("button", { name: "Account menu" }), {
    key: "Enter",
  });

const USER = {
  id: "u1",
  name: "Asha Rao",
  role: "CONSULTANT",
  consultantProfileId: "c1",
  consulteeProfileId: "l1",
};

const href = (name: string) =>
  screen.getByRole("menuitem", { name }).getAttribute("href");

describe("Navbar account menu", () => {
  beforeEach(() => {
    mockSignOut.mockReset();
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockUseSession.mockReturnValue({ data: { user: USER }, isPending: false });
  });

  it("shows the personal doors and a skeleton while the facets load, then My library, Settings and Sign out", () => {
    mockFetch.mockReturnValue(new Promise(() => undefined));
    renderNavbar();
    openMenu();
    expect(href("Expert dashboard")).toBe("/dashboard/go/expert");
    expect(href("Learner dashboard")).toBe("/dashboard/go/client");
    expect(
      screen.getByRole("status", { name: "Loading dashboards" }),
    ).toBeTruthy();
    expect(href("My library")).toBe("/dashboard/go/library");
    expect(href("Settings")).toBe("/dashboard/consultant/c1/settings/account");
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(mockSignOut).toHaveBeenCalledWith("/auth/signin");
  });

  it("renders the fetched facets, including organizations, once the menu has opened", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => FACETS });
    renderNavbar();
    expect(mockFetch).not.toHaveBeenCalled();
    openMenu();
    await waitFor(() =>
      expect(href("Acme")).toBe("/dashboard/organization/o1"),
    );
    expect(href("Expert dashboard")).toBe("/dashboard/consultant/c1/home");
    expect(
      screen.queryByRole("status", { name: "Loading dashboards" }),
    ).toBeNull();
    expect(mockFetch).toHaveBeenCalledWith("/api/user/dashboard-facets");
    expect(href("My library")).toBe("/dashboard/go/library");
  });

  it("falls back to All dashboards when the facets cannot be loaded", async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    renderNavbar();
    openMenu();
    await waitFor(() => expect(href("All dashboards")).toBe("/dashboard"));
    expect(href("My library")).toBe("/dashboard/go/library");
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
  });
});
