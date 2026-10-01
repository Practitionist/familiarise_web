import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RegistrationReview } from "@/components/booking/RegistrationReview";

let root: Root;
let container: HTMLDivElement;
const continueToCheckout = jest.fn();
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  continueToCheckout.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("reviews without checkout, restores the initiating button, and submits only on confirmation", async () => {
  await act(async () =>
    root.render(
      <RegistrationReview
        title="Design workshop"
        price="₹2,000"
        onContinue={continueToCheckout}
      >
        <p>October 5 · Asia/Kolkata</p>
      </RegistrationReview>,
    ),
  );
  const triggers = Array.from(container.querySelectorAll("button"));
  const mobile = triggers[1];
  mobile.focus();
  await act(async () => mobile.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Design workshop");
  expect(dialog.textContent).toContain("₹2,000");
  expect(continueToCheckout).not.toHaveBeenCalled();
  await act(async () =>
    Array.from(dialog.querySelectorAll("button"))
      .find((b) => b.textContent === "Back")!
      .click(),
  );
  // Radix restores focus on the next task after its focus scope unmounts.
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(mobile);
  await act(async () => triggers[0].click());
  await act(async () =>
    Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent === "Continue to checkout")!
      .click(),
  );
  expect(continueToCheckout).toHaveBeenCalledTimes(1);
});
