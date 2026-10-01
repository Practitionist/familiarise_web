jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: mockSession }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => "/explore/programs/plans/webinars/webinar-plan",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("../../hooks/useCurrency", () => ({
  useCurrency: () => ({ formatPrice: (price: number) => `₹${price / 100}` }),
}));

import React, { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ClientClassRegistration } from "@/app/explore/programs/plans/classes/[classPlanId]/components/ClientClassRegistration";
import { ClientWebinarRegistration } from "@/app/explore/programs/plans/webinars/[webinarPlanId]/components/ClientWebinarRegistration";

let mockSession: { user: { id: string } } | null = null;
const mockPush = jest.fn();
let root: Root;
let container: HTMLDivElement;
const start = new Date("2026-10-05T10:00:00Z");
const plan = {
  id: "class-plan",
  title: "Design workshop",
  price: 200000,
  maxParticipants: 2,
  refundWindowHours: 24,
  classes: [
    {
      id: "batch",
      schedulingPeriodStartsAt: start,
      appointment: { participants: [] },
    },
  ],
  // Only the public fields read by this registration card are needed here.
} as unknown as ComponentProps<typeof ClientClassRegistration>["plan"];
const webinar = {
  title: "Design webinar",
  webinarPlanId: "webinar-plan",
  webinarId: "webinar-event",
  price: 100000,
  nextSessionDate: start,
  sessionStatus: "Upcoming",
  maxParticipants: 2,
  appointment: { participants: [] },
} satisfies ComponentProps<typeof ClientWebinarRegistration>;
const button = (label: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  )!;
const click = async (label: string) => {
  await act(async () => button(label).click());
};
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockPush.mockClear();
  mockSession = null;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("preserves a guest's class checkout callback behind review", async () => {
  await act(async () => root.render(<ClientClassRegistration plan={plan} />));
  await click("Review registration");
  expect(mockPush).not.toHaveBeenCalled();
  await click("Sign in to continue");
  expect(mockPush).toHaveBeenCalledWith(
    `/auth/signin?callbackUrl=${encodeURIComponent("/checkout/plans/class/class-plan")}`,
  );
});

it("preserves the webinar event id and guest callback behind review", async () => {
  await act(async () =>
    root.render(<ClientWebinarRegistration {...webinar} />),
  );
  await click("Review registration");
  expect(mockPush).not.toHaveBeenCalled();
  await click("Sign in to continue");
  expect(mockPush).toHaveBeenCalledWith(
    `/auth/signin?callbackUrl=${encodeURIComponent("/checkout/plans/webinar/webinar-plan?eventId=webinar-event")}`,
  );
});

it("hands an authenticated registration to the existing checkout only after review", async () => {
  mockSession = { user: { id: "buyer" } };
  await act(async () =>
    root.render(<ClientWebinarRegistration {...webinar} />),
  );
  await click("Review registration");
  expect(mockPush).not.toHaveBeenCalled();
  await click("Continue to checkout");
  expect(mockPush).toHaveBeenCalledWith(
    "/checkout/plans/webinar/webinar-plan?eventId=webinar-event",
  );
});

it("does not offer a review for a sold-out class or unscheduled webinar", async () => {
  await act(async () =>
    root.render(
      <ClientClassRegistration
        plan={{
          ...plan,
          classes: [
            {
              ...plan.classes[0],
              appointment: { participants: [{ userId: "a" }, { userId: "b" }] },
            },
          ],
        }}
      />,
    ),
  );
  expect(button("Sold out").disabled).toBe(true);
  expect(button("Review registration")).toBeUndefined();
  await act(async () =>
    root.render(
      <ClientWebinarRegistration
        {...webinar}
        webinarId={undefined}
        sessionStatus="To be announced"
      />,
    ),
  );
  expect(button("Registration Opening Soon").disabled).toBe(true);
  expect(button("Review registration")).toBeUndefined();
  expect(mockPush).not.toHaveBeenCalled();
});
