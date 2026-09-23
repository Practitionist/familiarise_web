import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MobileBookingBar } from "@/app/explore/components/MobileBookingBar";

describe("MobileBookingBar", () => {
  let host: HTMLDivElement;
  let target: HTMLDivElement;
  let root: Root;
  let observerCallback: IntersectionObserverCallback;
  const disconnect = jest.fn();
  const originalObserver = global.IntersectionObserver;
  const originalMatchMedia = window.matchMedia;

  beforeAll(() => {
    (global as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
      true;
  });

  beforeEach(() => {
    host = document.createElement("div");
    target = document.createElement("div");
    target.id = "booking-options";
    document.body.append(host, target);
    root = createRoot(host);
    disconnect.mockClear();

    global.IntersectionObserver = class {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe = jest.fn();
      disconnect = disconnect;
      unobserve = jest.fn();
      takeRecords = jest.fn(() => []);
      root = null;
      rootMargin = "0px";
      thresholds = [0.05];
    } as unknown as typeof IntersectionObserver;

    window.matchMedia = jest.fn(() => ({
      matches: true,
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    target.remove();
    global.IntersectionObserver = originalObserver;
    window.matchMedia = originalMatchMedia;
  });

  it("shows a shortcut only while booking is off screen and scrolls without motion when requested", () => {
    const scrollIntoView = jest.fn();
    target.scrollIntoView = scrollIntoView;

    act(() => {
      root.render(
        <MobileBookingBar
          targetId="booking-options"
          context="Class registration"
          label="₹1,000"
        />,
      );
    });
    expect(host.querySelector("button")).toBeNull();

    act(() => {
      observerCallback(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    const button = host.querySelector("button");
    expect(button?.textContent).toContain("View options");
    expect(host.querySelector('section[aria-label="Booking shortcut"]')).not.toBeNull();
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.activeElement).toBe(target);
    expect(target.tabIndex).toBe(-1);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "instant",
      block: "start",
    });

    act(() => {
      observerCallback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(host.querySelector("button")).toBeNull();
  });
});
