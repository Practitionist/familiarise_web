/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react";

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

// Radix opens its trigger on Enter, the keyboard path the menu must support.
const openMenu = () =>
  fireEvent.keyDown(screen.getByRole("button", { name: "Account menu" }), {
    key: "Enter",
  });

const USER = {
  name: "Asha Rao",
  role: "CONSULTANT",
  consultantProfileId: "c1",
  consulteeProfileId: "l1",
};

describe("Navbar account menu", () => {
  beforeEach(() => {
    mockSignOut.mockReset();
    mockUseSession.mockReturnValue({ data: { user: USER }, isPending: false });
  });

  it("opens from the avatar with the facets, My library, Settings and Sign out", () => {
    render(<Navbar />);
    openMenu();
    const href = (name: string) =>
      screen.getByRole("menuitem", { name }).getAttribute("href");
    expect(href("Expert dashboard")).toBe("/dashboard/go/expert");
    expect(href("Learner dashboard")).toBe("/dashboard/go/client");
    expect(href("My library")).toBe("/dashboard/go/library");
    expect(href("Settings")).toBe("/dashboard/consultant/c1/settings/account");
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(mockSignOut).toHaveBeenCalledWith("/auth/signin");
  });

  it("offers Dashboard to a viewer with neither profile", () => {
    mockUseSession.mockReturnValue({
      data: { user: { name: "Op", role: "ADMIN" } },
      isPending: false,
    });
    render(<Navbar />);
    openMenu();
    expect(
      screen.getByRole("menuitem", { name: "Dashboard" }).getAttribute("href"),
    ).toBe("/dashboard");
  });
});
