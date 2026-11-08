/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react";

import { ProfileAnchorTabs } from "@/app/explore/experts/[consultantId]/components/ProfileAnchorTabs";

type Entry = { target: Element; isIntersecting: boolean };

let fire: (entries: Entry[]) => void;

class FakeObserver {
  constructor(callback: (entries: Entry[]) => void) {
    fire = (entries) => callback(entries);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const IDS = ["about", "sessions", "programs", "reviews"] as const;

/** Adds the page's sections to the document with a stubbed distance from the viewport top. */
function placeSections(tops: Record<(typeof IDS)[number], number>) {
  for (const id of IDS) {
    const el = document.createElement("div");
    el.id = id;
    el.getBoundingClientRect = () => ({ top: tops[id] }) as DOMRect;
    document.body.appendChild(el);
  }
}

function renderTabs() {
  render(
    <ProfileAnchorTabs
      present={{
        about: true,
        sessions: true,
        programs: true,
        products: false,
        reviews: true,
      }}
    />,
  );
}

const visibleEntry = (id: string): Entry => ({
  target: document.getElementById(id) as Element,
  isIntersecting: true,
});

const activeTab = () =>
  screen
    .getAllByRole("link")
    .find((a) => a.getAttribute("aria-current") === "true")?.textContent;

beforeAll(() => {
  globalThis.IntersectionObserver =
    FakeObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ProfileAnchorTabs", () => {
  it("stays on About at the top, while only the Sessions sidebar is in view", () => {
    // Wide layout: the sidebar starts above About, so it is the only section
    // inside the observed band until the reader scrolls.
    placeSections({ about: 545, sessions: 283, programs: 1500, reviews: 2600 });
    renderTabs();

    act(() => fire([visibleEntry("sessions")]));

    expect(activeTab()).toBe("About");
  });

  it("moves to Sessions once About has been reached and left behind", () => {
    placeSections({
      about: -200,
      sessions: -300,
      programs: 900,
      reviews: 2000,
    });
    renderTabs();

    act(() => fire([visibleEntry("sessions")]));

    expect(activeTab()).toBe("Sessions");
  });

  it("prefers About when both are in view and About has been reached", () => {
    placeSections({ about: 10, sessions: -100, programs: 900, reviews: 2000 });
    renderTabs();

    act(() => fire([visibleEntry("sessions"), visibleEntry("about")]));

    expect(activeTab()).toBe("About");
  });

  it("follows later sections as they are reached", () => {
    placeSections({ about: -800, sessions: -900, programs: 40, reviews: 1200 });
    renderTabs();

    act(() => fire([visibleEntry("programs")]));

    expect(activeTab()).toBe("Programs");
  });
});
