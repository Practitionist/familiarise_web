/**
 * A waiter keeps a way to leave the notify-me list after a seat opens and the
 * registration card stops reading sold out; a non-waiter sees only the buy button.
 */
import { render, screen } from "@testing-library/react";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  usePathname: () => "/explore/programs/plans/webinars/plan-1",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u-1" } }, isPending: false }),
}));
jest.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    formatPrice: (p: number) => `₹${p / 100}`,
    formatPriceExact: (p: number) => `₹${p / 100}`,
  }),
}));
jest.mock("@/components/events/FreeCancellationLine", () => ({
  FreeCancellationLine: () => null,
}));
jest.mock("@/components/booking/GroupSessionDisclosure", () => ({
  GroupSessionDisclosure: () => null,
}));
jest.mock("@/components/booking/NotifyMeButton", () => ({
  NotifyMeButton: ({ waiting }: { waiting: boolean }) => (
    <button>{waiting ? "leave-list" : "join-list"}</button>
  ),
}));

import { ClientWebinarRegistration } from "@/app/explore/programs/plans/webinars/[webinarPlanId]/components/ClientWebinarRegistration";
import { ClientClassRegistration } from "@/app/explore/programs/plans/classes/[classPlanId]/components/ClientClassRegistration";
import type { BatchCard } from "@/lib/booking/batch-cards";

const startsAt = new Date(Date.now() + 48 * 3_600_000);

function webinar(isWaiting: boolean) {
  return (
    <ClientWebinarRegistration
      webinarPlanId="plan-1"
      webinarId="web-1"
      price={50_000}
      nextSessionDate={startsAt}
      sessionStatus="Upcoming"
      isRegistered={false}
      isWaiting={isWaiting}
      viewerUserId="u-1"
      waitlistEnabled
      seatsTaken={1}
      maxParticipants={2}
    />
  );
}

it.each([
  [true, 1],
  [false, 0],
])(
  "an open webinar seat, waiting=%s, shows %i leave control",
  (isWaiting, count) => {
    render(webinar(isWaiting));
    expect(screen.getByText(/Register Now/)).toBeTruthy();
    expect(screen.queryAllByText("leave-list")).toHaveLength(count);
    expect(screen.queryAllByText("join-list")).toHaveLength(0);
  },
);

it("keeps the leave control on a class batch that has a seat again", () => {
  const batch = {
    classId: "cls-1",
    phase: "upcoming",
    startsAt,
    endsAt: null,
    label: "Starts soon",
    seatsLeft: 1,
    isFull: false,
    enrolment: { state: "open", basePaise: 50_000 },
    freeCancellationUntil: null,
    canEnrol: true,
    nextBatchStartsAt: null,
  } as unknown as BatchCard;
  render(
    <ClientClassRegistration
      plan={
        {
          id: "plan-1",
          price: 50_000,
          maxParticipants: 2,
          classes: [
            {
              id: "cls-1",
              maxParticipants: null,
              appointment: { id: "appt-1", _count: { participants: 1 } },
            },
          ],
        } as never
      }
      enrolledAppointmentIds={[]}
      waitingAppointmentIds={["appt-1"]}
      viewerUserId="u-1"
      waitlistEnabled
      batch={batch}
    />,
  );
  expect(screen.getByText(/Register Now/)).toBeTruthy();
  expect(screen.getByText("leave-list")).toBeTruthy();
});
