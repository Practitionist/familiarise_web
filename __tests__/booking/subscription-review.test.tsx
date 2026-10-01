jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock(
  "../../app/explore/experts/[consultantId]/components/TrialBookingModal",
  () => ({ TrialBookingModal: () => null }),
);

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import SubscriptionPricingToggle from "@/app/explore/experts/[consultantId]/components/SubscriptionPricingToggle";
import type { PricingOption } from "@/app/explore/experts/[consultantId]/defaults";

const options: PricingOption[] = [
  {
    id: "mentorship-a",
    title: "3 Months",
    description: "Career mentorship",
    price: 100000,
    priceCurrency: "INR",
    duration: "3",
    durationInMonths: 3,
    sessionsPerWeek: 1,
    totalSessions: 12,
  },
];
let root: Root;
let container: HTMLDivElement;
const checkout = jest.fn();
const button = (label: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  )!;
async function click(label: string) {
  await act(async () => button(label).click());
}
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  checkout.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("reviews the first cycle, retains the start date on Back, and preserves the checkout payload", async () => {
  await act(async () =>
    root.render(
      <SubscriptionPricingToggle
        subscriptionOptions={options}
        selectedPlanId={options[0].id}
        onPlanChange={jest.fn()}
        consultantDetails={{ id: "expert" }}
        handleSubscriptionBooking={checkout}
        timezone="Asia/Kolkata"
      />,
    ),
  );
  await click("Choose a start date");
  const input = document.querySelector<HTMLInputElement>('input[type="date"]')!;
  const before = input.value;
  await click("Review plan");
  expect(document.body.textContent).toContain("Career mentorship");
  expect(document.body.textContent).toContain("/ plan");
  expect(document.body.textContent).not.toContain("/ month");
  expect(document.body.textContent).toContain("Asia/Kolkata");
  expect(checkout).not.toHaveBeenCalled();
  await click("Back");
  expect(
    document.querySelector<HTMLInputElement>('input[type="date"]')!.value,
  ).toBe(before);
  await click("Review plan");
  await click("Continue to checkout");
  expect(checkout).toHaveBeenCalledWith(options[0], {
    startDate: expect.any(Date),
    endDate: expect.any(Date),
  });
  expect(checkout.mock.calls[0][1].endDate.getTime()).toBeGreaterThan(
    checkout.mock.calls[0][1].startDate.getTime(),
  );
});

it("only opens for a new booking request, not a service-tab remount", async () => {
  const props = {
    subscriptionOptions: options,
    selectedPlanId: options[0].id,
    onPlanChange: jest.fn(),
    consultantDetails: { id: "expert" },
    handleSubscriptionBooking: checkout,
    timezone: "Asia/Kolkata",
  };
  await act(async () =>
    root.render(<SubscriptionPricingToggle {...props} bookingRequest={2} />),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () =>
    root.render(<SubscriptionPricingToggle {...props} bookingRequest={3} />),
  );
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await click("Cancel");
  await act(async () =>
    root.render(<SubscriptionPricingToggle {...props} bookingRequest={3} />),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
