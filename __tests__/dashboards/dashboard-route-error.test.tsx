/**
 * The dashboard boundary retries a server-thrown error once, and a
 * failed retry must land on the error card even when it arrives as an UPDATE of
 * the same instance (a mount-once decision left the page on "Reconnecting…").
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { DashboardRouteError } from "@/components/dashboard/DashboardRouteError";

const refresh = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../components/dashboard/ErrorState", () => ({
  ErrorState: ({ digest }: { digest?: string }) => <div>card {digest}</div>,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const serverError = (digest: string) =>
  Object.assign(new Error("boom"), { digest });

const props = {
  scope: "dashboard/test",
  event: "test_dashboard_error",
  entityKey: "consultantId",
  entityId: "c1",
  title: "Something went wrong",
  devFallbackMessage: "boom",
  escape: { href: "/dashboard", label: "Back" },
};

describe("DashboardRouteError auto-retry", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, "error").mockImplementation(() => {});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("retries once, then shows the card when the retry fails as an update", () => {
    const reset = jest.fn();
    act(() => {
      root.render(
        <DashboardRouteError
          error={serverError("d1")}
          reset={reset}
          {...props}
        />,
      );
    });
    expect(container.textContent).toContain("Reconnecting");

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);

    // The retry failed: same boundary instance, new error, same digest.
    act(() => {
      root.render(
        <DashboardRouteError
          error={serverError("d1")}
          reset={reset}
          {...props}
        />,
      );
    });
    expect(container.textContent).toContain("card d1");
    expect(container.textContent).not.toContain("Reconnecting");
  });

  it("shows the card straight away for a client error (no digest)", () => {
    act(() => {
      root.render(
        <DashboardRouteError
          error={new Error("client")}
          reset={jest.fn()}
          {...props}
        />,
      );
    });
    expect(container.textContent).toContain("card");
    expect(container.textContent).not.toContain("Reconnecting");
  });
});
