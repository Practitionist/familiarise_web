/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import { ProfileAnchorTabs } from "@/app/explore/experts/[consultantId]/components/ProfileAnchorTabs";

class FakeObserver {
  observe = jest.fn();
  disconnect = jest.fn();
}

beforeAll(() => {
  (
    globalThis as unknown as { IntersectionObserver: unknown }
  ).IntersectionObserver = FakeObserver;
});

describe("ProfileAnchorTabs", () => {
  it("hides the tab of an empty section", () => {
    render(
      <ProfileAnchorTabs
        present={{
          about: true,
          sessions: true,
          programs: false,
          products: false,
          reviews: true,
        }}
      />,
    );
    const links = screen.getAllByRole("link").map((a) => a.textContent);
    expect(links).toEqual(["About", "Sessions", "Reviews"]);
    expect(
      screen.getByRole("link", { name: "About" }).getAttribute("aria-current"),
    ).toBe("true");
    expect(
      screen.getByRole("link", { name: "Reviews" }).getAttribute("href"),
    ).toBe("#reviews");
  });

  it("renders nothing when only About exists", () => {
    const { container } = render(
      <ProfileAnchorTabs
        present={{
          about: true,
          sessions: false,
          programs: false,
          products: false,
          reviews: false,
        }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
