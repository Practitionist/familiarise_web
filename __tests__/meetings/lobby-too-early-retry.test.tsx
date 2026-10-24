/**
 * The TOO_EARLY card re-checks the join route after the room opens, up to
 * MAX_AUTO_RETRIES times, even when each check is answered with the same refusal.
 */
import * as React from "react";
import { act, render, screen } from "@testing-library/react";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn() }),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { user: { timezone: "UTC" } } }),
}));

import { CONSULTEE_JOIN_WINDOW_MS } from "../../lib/appointments/occurrences";
import { MeetingLobbyGateCard } from "../../app/meetings/[id]/components/MeetingLobbyGateCard";

const NOW = new Date("2026-10-24T10:00:00.000Z").getTime();

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => jest.useRealTimers());

describe("MeetingLobbyGateCard TOO_EARLY auto-retry", () => {
  it("re-arms after each refused check until the budget is spent", async () => {
    const onRetryJoin = jest.fn();
    const startsAt = new Date(NOW + CONSULTEE_JOIN_WINDOW_MS + 2_000);
    render(
      <MeetingLobbyGateCard
        meetingId="m1"
        onRetryJoin={onRetryJoin}
        access={{
          hasAccess: false,
          role: "participant",
          message: "Join opens soon",
          code: "TOO_EARLY",
          startsAt: startsAt.toISOString(),
        }}
      />,
    );

    expect(screen.getByTestId("early-lobby-countdown")).toBeTruthy();

    for (let second = 0; second < 40; second++) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_000);
      });
    }

    expect(onRetryJoin).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("early-lobby-rechecking").textContent).toContain(
      "Use Check Again",
    );
  });

  it("shows which check is running once the room is due to open", async () => {
    const startsAt = new Date(NOW + CONSULTEE_JOIN_WINDOW_MS + 1_000);
    render(
      <MeetingLobbyGateCard
        meetingId="m1"
        onRetryJoin={jest.fn()}
        access={{
          hasAccess: false,
          role: "participant",
          message: "Join opens soon",
          code: "TOO_EARLY",
          startsAt: startsAt.toISOString(),
        }}
      />,
    );

    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_000);
    });

    expect(screen.getByTestId("early-lobby-rechecking").textContent).toContain(
      "2 of 3",
    );
  });
});
